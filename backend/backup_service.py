import asyncio
import json
import logging
import os
import re
import tempfile
import uuid
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from pymongo.errors import DuplicateKeyError


BACKUP_PREFIX = "erp-backups"
MAX_DAILY_AGE_DAYS = 30
MONTHLY_RETENTION_MONTHS = 12
def backup_configuration():
    required = (
        "BACKUP_S3_BUCKET",
        "BACKUP_S3_ENDPOINT_URL",
        "BACKUP_S3_ACCESS_KEY_ID",
        "BACKUP_S3_SECRET_ACCESS_KEY",
    )
    missing = [name for name in required if not os.environ.get(name)]
    return {
        "configured": not missing,
        "missing": missing,
        "bucket": os.environ.get("BACKUP_S3_BUCKET", ""),
        "endpoint_url": os.environ.get("BACKUP_S3_ENDPOINT_URL", ""),
        "region": os.environ.get("BACKUP_S3_REGION", "auto"),
        "prefix": os.environ.get("BACKUP_S3_PREFIX", BACKUP_PREFIX).strip("/") or BACKUP_PREFIX,
    }


def snapshot_key(kind, snapshot_date):
    if kind == "daily":
        return f"daily/{snapshot_date.isoformat()}.zip"
    if kind == "monthly":
        return f"monthly/{snapshot_date.strftime('%Y-%m')}.zip"
    if kind == "manual":
        return f"manual/{snapshot_date.strftime('%Y-%m-%dT%H-%M-%S-%fZ')}.zip"
    raise ValueError(f"Unknown snapshot type: {kind}")


def monthly_retention_cutoff(today):
    month_index = today.year * 12 + today.month - 1 - MONTHLY_RETENTION_MONTHS
    year, month_offset = divmod(month_index, 12)
    return date(year, month_offset + 1, 1)


def snapshot_kind_from_key(key):
    if re.fullmatch(r"daily/\d{4}-\d{2}-\d{2}\.zip", key):
        try:
            date.fromisoformat(key.removeprefix("daily/").removesuffix(".zip"))
            return "daily"
        except ValueError:
            return None
    if re.fullmatch(r"monthly/\d{4}-\d{2}\.zip", key):
        try:
            date.fromisoformat(key.removeprefix("monthly/").removesuffix(".zip") + "-01")
            return "monthly"
        except ValueError:
            return None
    if re.fullmatch(r"manual/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{6}Z\.zip", key):
        try:
            datetime.strptime(
                key.removeprefix("manual/").removesuffix(".zip"),
                "%Y-%m-%dT%H-%M-%S-%fZ",
            )
            return "manual"
        except ValueError:
            return None
    return None


def _s3_client(configuration):
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=configuration["endpoint_url"],
        region_name=configuration["region"],
        aws_access_key_id=os.environ["BACKUP_S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["BACKUP_S3_SECRET_ACCESS_KEY"],
    )


def _mongo_config_file(directory, mongo_url):
    path = Path(directory) / "mongo-tools.yaml"
    path.write_text(f"uri: {json.dumps(mongo_url)}\n", encoding="utf-8")
    path.chmod(0o600)
    return path


async def _run_tool(*arguments):
    process = await asyncio.create_subprocess_exec(
        *arguments,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await process.communicate()
    except asyncio.CancelledError:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        await process.communicate()
        raise
    if process.returncode:
        logging.error("MongoDB backup tool failed with exit code %s", process.returncode)
        raise RuntimeError(f"MongoDB backup tool failed with exit code {process.returncode}")


async def create_snapshot(
    *,
    mongo_url,
    database_names,
    configuration,
    snapshot_date,
    kind,
):
    if not configuration["configured"]:
        raise RuntimeError("External backup storage is not configured")
    key = snapshot_key(kind, snapshot_date)
    prefix = configuration["prefix"]
    object_key = f"{prefix}/{key}"
    s3 = _s3_client(configuration)

    try:
        await asyncio.to_thread(s3.head_object, Bucket=configuration["bucket"], Key=object_key)
        return {"key": key, "kind": kind, "date": snapshot_date.isoformat(), "already_exists": True}
    except s3.exceptions.ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
            raise

    with tempfile.TemporaryDirectory(prefix="erp-backup-") as temp_dir:
        mongo_config = _mongo_config_file(temp_dir, mongo_url)
        dump_files = []
        for index, database_name in enumerate(database_names):
            dump_path = Path(temp_dir) / f"database-{index}.archive.gz"
            await _run_tool(
                "mongodump",
                f"--config={mongo_config}",
                f"--db={database_name}",
                f"--archive={dump_path}",
                "--gzip",
            )
            dump_files.append((database_name, dump_path))

        archive_path = Path(temp_dir) / "snapshot.zip"
        manifest = {
            "format_version": 1,
            "snapshot_date": snapshot_date.isoformat(),
            "kind": kind,
            "databases": [
                {"name": database_name, "archive": dump_path.name}
                for database_name, dump_path in dump_files
            ],
        }
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
            for _, dump_path in dump_files:
                archive.write(dump_path, dump_path.name)

        await asyncio.to_thread(
            s3.upload_file,
            str(archive_path),
            configuration["bucket"],
            object_key,
        )

        return {
            "key": key,
            "kind": kind,
            "date": snapshot_date.isoformat(),
            "size_bytes": archive_path.stat().st_size,
            "already_exists": False,
        }


async def list_snapshots(configuration, today=None):
    if not configuration["configured"]:
        raise RuntimeError("External backup storage is not configured")
    today = today or date.today()
    cutoff = monthly_retention_cutoff(today)
    s3 = _s3_client(configuration)
    paginator = s3.get_paginator("list_objects_v2")
    snapshots = []
    prefix = f"{configuration['prefix']}/"
    async for page in _iterate_pages(paginator, Bucket=configuration["bucket"], Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"][len(prefix):]
            kind = snapshot_kind_from_key(key)
            if not kind:
                continue
            if kind == "daily":
                snapshot_date = date.fromisoformat(key.removeprefix("daily/").removesuffix(".zip"))
                if snapshot_date <= today - timedelta(days=MAX_DAILY_AGE_DAYS):
                    continue
            elif kind == "monthly":
                snapshot_month = date.fromisoformat(
                    key.removeprefix("monthly/").removesuffix(".zip") + "-01"
                )
                if snapshot_month < cutoff:
                    continue
            snapshots.append({
                "key": key,
                "kind": kind,
                "created_at": item["LastModified"].astimezone(timezone.utc).isoformat(),
                "size_bytes": item["Size"],
            })
    return sorted(snapshots, key=lambda item: item["created_at"], reverse=True)


async def _iterate_pages(paginator, **kwargs):
    for page in await asyncio.to_thread(lambda: list(paginator.paginate(**kwargs))):
        yield page


async def restore_snapshot_to_copy(
    *,
    mongo_url,
    database_names,
    configuration,
    snapshot_key_value,
    base_database_name,
):
    kind = snapshot_kind_from_key(snapshot_key_value)
    if not kind:
        raise ValueError("Invalid backup selection")
    if not configuration["configured"]:
        raise RuntimeError("External backup storage is not configured")

    object_key = f"{configuration['prefix']}/{snapshot_key_value}"
    restore_id = uuid.uuid4().hex[:12]
    restored_base_name = f"{base_database_name[:14]}__rec_{restore_id}"
    restored_names = {}
    for database_name in database_names:
        if database_name == base_database_name:
            restored_names[database_name] = restored_base_name
        else:
            suffix = database_name.removeprefix(f"{base_database_name}__")
            restored_names[database_name] = f"{restored_base_name}__{suffix}"

    s3 = _s3_client(configuration)
    with tempfile.TemporaryDirectory(prefix="erp-restore-") as temp_dir:
        mongo_config = _mongo_config_file(temp_dir, mongo_url)
        archive_path = Path(temp_dir) / "snapshot.zip"
        await asyncio.to_thread(
            s3.download_file,
            configuration["bucket"],
            object_key,
            str(archive_path),
        )

        with zipfile.ZipFile(archive_path) as archive:
            names = set(archive.namelist())
            if "manifest.json" not in names:
                raise RuntimeError("Backup is missing its manifest")
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("format_version") != 1:
                raise RuntimeError("Backup format is not supported")
            entries = manifest.get("databases")
            if not isinstance(entries, list):
                raise RuntimeError("Backup manifest is invalid")
            archived_databases = {entry.get("name") for entry in entries if isinstance(entry, dict)}
            if archived_databases != set(database_names) or len(entries) != len(database_names):
                raise RuntimeError("Backup does not contain the expected company databases")
            archive_names = [entry.get("archive") for entry in entries]
            if len(set(archive_names)) != len(database_names):
                raise RuntimeError("Backup manifest contains duplicate database archives")
            if archive.testzip():
                raise RuntimeError("Backup archive failed its integrity check")
            for index, entry in enumerate(entries):
                source_database = entry["name"]
                archive_name = entry.get("archive")
                if archive_name not in names or Path(archive_name).name != archive_name:
                    raise RuntimeError("Backup database archive is missing or invalid")
                database_archive = Path(temp_dir) / f"restore-{index}.archive.gz"
                with archive.open(archive_name) as source, database_archive.open("wb") as target:
                    while chunk := source.read(1024 * 1024):
                        target.write(chunk)
                await _run_tool(
                    "mongorestore",
                    f"--config={mongo_config}",
                    f"--archive={database_archive}",
                    "--gzip",
                    f"--nsFrom={source_database}.*",
                    f"--nsTo={restored_names[source_database]}.*",
                )

    return {
        "restore_id": restore_id,
        "source_key": snapshot_key_value,
        "databases": restored_names,
        "message": "Historical data was restored to a separate database copy; live databases were not changed.",
    }


async def delete_expired_snapshots(configuration, today=None):
    if not configuration["configured"]:
        raise RuntimeError("External backup storage is not configured")
    today = today or date.today()
    cutoff = monthly_retention_cutoff(today)
    s3 = _s3_client(configuration)
    prefix = f"{configuration['prefix']}/"
    paginator = s3.get_paginator("list_objects_v2")
    expired = []
    async for page in _iterate_pages(paginator, Bucket=configuration["bucket"], Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"][len(prefix):]
            kind = snapshot_kind_from_key(key)
            if kind == "daily":
                snapshot_date = date.fromisoformat(key.removeprefix("daily/").removesuffix(".zip"))
                if snapshot_date <= today - timedelta(days=MAX_DAILY_AGE_DAYS):
                    expired.append(item["Key"])
            elif kind == "monthly":
                snapshot_month = date.fromisoformat(
                    key.removeprefix("monthly/").removesuffix(".zip") + "-01"
                )
                if snapshot_month < cutoff:
                    expired.append(item["Key"])
            elif kind == "manual":
                date_text = key.removeprefix("manual/").split("T", 1)[0]
                if date.fromisoformat(date_text) < cutoff:
                    expired.append(item["Key"])
    for offset in range(0, len(expired), 1000):
        await asyncio.to_thread(
            s3.delete_objects,
            Bucket=configuration["bucket"],
            Delete={"Objects": [{"Key": key} for key in expired[offset:offset + 1000]]},
        )
    return len(expired)


async def scheduled_backup_loop(
    *,
    mongo_url,
    database_names,
    configuration,
    local_timezone,
    lock_database,
):
    while True:
        now = datetime.now(local_timezone)
        next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep((next_run - now).total_seconds())
        owner = uuid.uuid4().hex
        lease_until = datetime.now(timezone.utc) + timedelta(hours=4)
        try:
            try:
                await lock_database.backup_scheduler_locks.insert_one({
                    "_id": "daily",
                    "owner": owner,
                    "expires_at": lease_until,
                })
            except DuplicateKeyError:
                existing = await lock_database.backup_scheduler_locks.find_one_and_update(
                    {"_id": "daily", "expires_at": {"$lt": datetime.now(timezone.utc)}},
                    {"$set": {"owner": owner, "expires_at": lease_until}},
                )
                if not existing:
                    logging.info("Scheduled backup skipped because another worker owns the backup lease")
                    continue
            snapshot_date = datetime.now(local_timezone).date()
            daily = await create_snapshot(
                mongo_url=mongo_url,
                database_names=database_names,
                configuration=configuration,
                snapshot_date=snapshot_date,
                kind="daily",
            )
            await create_snapshot(
                mongo_url=mongo_url,
                database_names=database_names,
                configuration=configuration,
                snapshot_date=snapshot_date,
                kind="monthly",
            )
            await delete_expired_snapshots(configuration, snapshot_date)
            logging.info("Scheduled backup completed: %s", daily["key"])
            await lock_database.backup_scheduler_locks.delete_one({"_id": "daily", "owner": owner})
        except Exception:
            logging.exception("Scheduled backup failed")
            try:
                await lock_database.backup_scheduler_locks.delete_one({"_id": "daily", "owner": owner})
            except Exception:
                logging.exception("Could not release scheduled backup lease")
