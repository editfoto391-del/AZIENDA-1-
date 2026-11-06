import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from pymongo.errors import DuplicateKeyError


BACKUP_PREFIX = "erp-backups"
MAX_DAILY_AGE_DAYS = 30
MONTHLY_RETENTION_MONTHS = 12
BACKUP_COLLECTIONS = ("invoices", "payments", "customers", "deleted_customers")


def _excluded_collections(mongo_url, database_name):
    from pymongo import MongoClient

    client = MongoClient(mongo_url, serverSelectionTimeoutMS=10_000)
    try:
        return [name for name in client[database_name].list_collection_names() if name not in BACKUP_COLLECTIONS]
    finally:
        client.close()


class BackupBusyError(RuntimeError):
    pass


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
        "bucket": os.environ.get("BACKUP_S3_BUCKET"),
        "endpoint_url": os.environ.get("BACKUP_S3_ENDPOINT_URL"),
        "region": os.environ.get("BACKUP_S3_REGION", "auto"),
        "prefix": os.environ.get("BACKUP_S3_PREFIX", BACKUP_PREFIX).strip("/") or BACKUP_PREFIX,
        "provider": "Cloudflare R2",
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
    month_index = today.year * 12 + today.month - MONTHLY_RETENTION_MONTHS + 1
    year, month_offset = divmod(month_index, 12)
    return date(year, month_offset + 1, 1)


def mongo_tools_status():
    tools = {}
    for name in ("mongodump", "mongorestore"):
        executable = shutil.which(name)
        version = None
        if executable:
            try:
                result = subprocess.run(
                    [executable, "--version"],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    version = (result.stdout or result.stderr).splitlines()[0][:160]
            except (OSError, subprocess.TimeoutExpired):
                executable = None
        tools[name] = {"available": bool(executable), "version": version}
    return {
        "tools_available": all(tool["available"] for tool in tools.values()),
        "tools": tools,
    }


@asynccontextmanager
async def backup_job_lock(lock_database, *, lease_hours=24):
    owner = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    lease_until = now + timedelta(hours=lease_hours)
    collection = lock_database.backup_scheduler_locks
    try:
        await collection.insert_one({
            "_id": "backup-operation",
            "owner": owner,
            "expires_at": lease_until,
        })
    except DuplicateKeyError:
        acquired = await collection.find_one_and_update(
            {"_id": "backup-operation", "expires_at": {"$lte": now}},
            {"$set": {"owner": owner, "expires_at": lease_until}},
        )
        if not acquired:
            raise BackupBusyError("Another backup or restore operation is already running")
    try:
        yield owner
    finally:
        try:
            await collection.delete_one({"_id": "backup-operation", "owner": owner})
        except Exception:
            logging.error("Could not release backup-operation lease; it will expire automatically")


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_zip_path(name):
    path = PurePosixPath(name)
    if path.is_absolute() or not name or any(part in ("", ".", "..") for part in path.parts):
        raise RuntimeError("Backup archive contains an unsafe path")
    if "\\" in name or ":" in name:
        raise RuntimeError("Backup archive contains an unsafe path")
    return path


def _read_manifest(archive, expected_database_names=None):
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise RuntimeError("Backup archive contains duplicate paths")
    for name in names:
        _validate_zip_path(name)
    if "manifest.json" not in names:
        raise RuntimeError("Backup is missing its manifest")
    try:
        manifest = json.loads(archive.read("manifest.json"))
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError) as error:
        raise RuntimeError("Backup manifest is invalid") from error
    if not isinstance(manifest, dict) or manifest.get("format_version") not in (1, 2):
        raise RuntimeError("Backup format is not supported")
    entries = manifest.get("databases")
    if not isinstance(entries, list) or not entries or not all(isinstance(item, dict) for item in entries):
        raise RuntimeError("Backup manifest is invalid")
    database_names = [entry.get("name") for entry in entries]
    archive_names = [entry.get("archive") for entry in entries]
    if (
        any(not isinstance(name, str) or not name for name in database_names)
        or len(set(database_names)) != len(database_names)
        or any(not isinstance(name, str) for name in archive_names)
        or len(set(archive_names)) != len(archive_names)
    ):
        raise RuntimeError("Backup manifest contains duplicate or invalid database entries")
    if expected_database_names is not None and set(database_names) != set(expected_database_names):
        raise RuntimeError("Backup does not contain the expected company databases")
    for entry in entries:
        archive_name = entry["archive"]
        if archive_name not in names or PurePosixPath(archive_name).name != archive_name:
            raise RuntimeError("Backup database archive is missing or invalid")
        if manifest.get("format_version") == 2:
            if not isinstance(entry.get("size_bytes"), int) or not re.fullmatch(
                r"[0-9a-f]{64}", str(entry.get("sha256", ""))
            ):
                raise RuntimeError("Backup database checksums are missing or invalid")
            info = archive.getinfo(archive_name)
            if info.file_size != entry["size_bytes"]:
                raise RuntimeError("Backup database archive size does not match its manifest")
    file_inventory = manifest.get("files", [])
    if not isinstance(file_inventory, list):
        raise RuntimeError("Backup file inventory is invalid")
    for entry in file_inventory:
        if not isinstance(entry, dict) or not re.fullmatch(
            r"[0-9a-f]{64}", str(entry.get("sha256", ""))
        ):
            raise RuntimeError("Backup file inventory is invalid")
    if archive.testzip():
        raise RuntimeError("Backup archive failed its integrity check")
    return manifest


def _verify_archive_file(path, expected_database_names=None):
    archive_path = Path(path)
    if not archive_path.is_file() or archive_path.stat().st_size <= 0:
        raise RuntimeError("Backup archive is empty or missing")
    with zipfile.ZipFile(archive_path) as archive:
        manifest = _read_manifest(archive, expected_database_names)
        if manifest.get("format_version") == 2:
            for entry in manifest["databases"]:
                digest = hashlib.sha256()
                with archive.open(entry["archive"]) as member:
                    for chunk in iter(lambda: member.read(1024 * 1024), b""):
                        digest.update(chunk)
                if digest.hexdigest() != entry["sha256"]:
                    raise RuntimeError("Backup database archive checksum failed")
    return manifest


def _collect_embedded_file_inventory(mongo_url, database_companies):
    from pymongo import MongoClient

    client = MongoClient(mongo_url, serverSelectionTimeoutMS=10_000)
    inventory = []
    try:
        for database_name, company_id in database_companies.items():
            collection = client[database_name]["vehicle_licence_discs"]
            for document in collection.find(
                {"document_base64": {"$type": "string"}},
                {
                    "_id": 1,
                    "id": 1,
                    "vehicle_id": 1,
                    "document_name": 1,
                    "document_content_type": 1,
                    "document_size": 1,
                    "document_base64": 1,
                },
            ):
                try:
                    content = base64.b64decode(document["document_base64"], validate=True)
                except (ValueError, TypeError) as error:
                    raise RuntimeError("A stored business document is invalid and could not be inventoried") from error
                inventory.append({
                    "database": database_name,
                    "company_id": company_id,
                    "collection": "vehicle_licence_discs",
                    "record_id": str(document.get("id", document.get("_id", ""))),
                    "vehicle_id": str(document.get("vehicle_id", "")),
                    "name": str(document.get("document_name", "")),
                    "content_type": str(document.get("document_content_type", "")),
                    "size_bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                })
        return inventory
    finally:
        client.close()


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
    database_companies=None,
    file_inventory=None,
):
    if not configuration["configured"]:
        raise RuntimeError("External backup storage is not configured")
    key = snapshot_key(kind, snapshot_date)
    prefix = configuration["prefix"]
    object_key = f"{prefix}/{key}"
    s3 = _s3_client(configuration)

    try:
        existing = await asyncio.to_thread(s3.head_object, Bucket=configuration["bucket"], Key=object_key)
        verified = await verify_snapshot_object(
            configuration=configuration,
            snapshot_key_value=key,
            expected_database_names=database_names,
            s3=s3,
            head=existing,
        )
        if verified["verification_status"] != "verified":
            raise RuntimeError("The existing backup has no trusted checksum and will not be reported as verified")
        return {
            **{name: value for name, value in verified.items() if name != "manifest"},
            "key": key,
            "kind": kind,
            "date": snapshot_date.isoformat(),
            "already_exists": True,
        }
    except s3.exceptions.ClientError as error:
        if not _is_missing_object_error(error):
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
                *[f"--excludeCollection={name}" for name in await asyncio.to_thread(_excluded_collections, mongo_url, database_name)],
                f"--archive={dump_path}",
                "--gzip",
            )
            if not dump_path.is_file() or dump_path.stat().st_size <= 0:
                raise RuntimeError(f"MongoDB backup for database {database_name} is empty")
            dump_files.append({
                "name": database_name,
                "archive": dump_path.name,
                "path": dump_path,
                "size_bytes": dump_path.stat().st_size,
                "sha256": _sha256_file(dump_path),
            })

        if file_inventory is None:
            file_inventory = []
        elif not isinstance(file_inventory, list):
            raise RuntimeError("Backup file inventory is invalid")

        created_at = datetime.now(timezone.utc)
        backup_id = uuid.uuid4().hex
        company_ids = sorted({
            company_id for company_id in (database_companies or {}).values() if company_id
        })

        archive_path = Path(temp_dir) / "snapshot.zip"
        manifest = {
            "format_version": 2,
            "backup_id": backup_id,
            "created_at": created_at.isoformat(),
            "timezone": "Africa/Johannesburg",
            "snapshot_date": snapshot_date.isoformat(),
            "kind": kind,
            "application_version": os.environ.get("APP_VERSION", "unknown"),
            "commit_sha": os.environ.get("COMMIT_SHA", os.environ.get("GIT_COMMIT", "unknown")),
            "companies": company_ids,
            "databases": [
                {
                    "name": entry["name"],
                    "company_id": (database_companies or {}).get(entry["name"]),
                    "archive": entry["archive"],
                    "size_bytes": entry["size_bytes"],
                    "sha256": entry["sha256"],
                }
                for entry in dump_files
            ],
            "files": file_inventory,
            "file_storage": {
                "provider": "MongoDB embedded documents",
                "backed_up": True,
                "included_collections": ["vehicle_licence_discs"],
                "limitations": [],
            },
        }
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
            for entry in dump_files:
                archive.write(entry["path"], entry["archive"])

        _verify_archive_file(archive_path, database_names)
        archive_sha256 = _sha256_file(archive_path)

        await asyncio.to_thread(
            s3.upload_file,
            str(archive_path),
            configuration["bucket"],
            object_key,
            ExtraArgs={"Metadata": {
                "sha256": archive_sha256,
                "backup-id": backup_id,
                "backup-kind": kind,
                "database-count": str(len(database_names)),
                "file-count": str(len(file_inventory)),
            }},
        )
        verified = await verify_snapshot_object(
            configuration=configuration,
            snapshot_key_value=key,
            expected_database_names=database_names,
            s3=s3,
            expected_size=archive_path.stat().st_size,
            expected_sha256=archive_sha256,
        )

        return {
            **{name: value for name, value in verified.items() if name != "manifest"},
            "backup_id": backup_id,
            "key": key,
            "kind": kind,
            "date": snapshot_date.isoformat(),
            "size_bytes": archive_path.stat().st_size,
            "already_exists": False,
        }


def _is_missing_object_error(error):
    response = getattr(error, "response", {})
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    code = response.get("Error", {}).get("Code")
    return status == 404 or code in {"404", "NoSuchKey", "NotFound"}


async def verify_snapshot_object(
    *,
    configuration,
    snapshot_key_value,
    expected_database_names=None,
    s3=None,
    head=None,
    expected_size=None,
    expected_sha256=None,
):
    s3 = s3 or _s3_client(configuration)
    object_key = f"{configuration['prefix']}/{snapshot_key_value}"
    head = head or await asyncio.to_thread(
        s3.head_object,
        Bucket=configuration["bucket"],
        Key=object_key,
    )
    size_bytes = head.get("ContentLength")
    if not isinstance(size_bytes, int) or size_bytes <= 0:
        raise RuntimeError("Uploaded backup has an invalid size")
    if expected_size is not None and size_bytes != expected_size:
        raise RuntimeError("Uploaded backup size does not match the local archive")
    metadata = head.get("Metadata", {})
    expected_metadata_sha = expected_sha256 or metadata.get("sha256")
    if expected_sha256 and metadata.get("sha256") != expected_sha256:
        raise RuntimeError("Uploaded backup checksum metadata does not match")
    with tempfile.TemporaryDirectory(prefix="erp-backup-verify-") as temp_dir:
        downloaded = Path(temp_dir) / "verified.zip"
        await asyncio.to_thread(
            s3.download_file,
            configuration["bucket"],
            object_key,
            str(downloaded),
        )
        if downloaded.stat().st_size != size_bytes:
            raise RuntimeError("Uploaded backup size verification failed")
        archive_sha256 = _sha256_file(downloaded)
        if expected_metadata_sha and archive_sha256 != expected_metadata_sha:
            raise RuntimeError("Uploaded backup SHA-256 verification failed")
        manifest = _verify_archive_file(downloaded, expected_database_names)
    return {
        "size_bytes": size_bytes,
        "sha256": archive_sha256,
        "verification_status": "verified" if expected_metadata_sha else "legacy_unverified",
        "backup_id": manifest.get("backup_id") or metadata.get("backup-id"),
        "created_at": manifest.get("created_at"),
        "database_count": len(manifest["databases"]),
        "file_count": len(manifest.get("files", [])),
        "manifest": manifest,
    }


async def list_snapshots(configuration, today=None, snapshot_metadata=None):
    if not configuration["configured"]:
        raise RuntimeError("External backup storage is not configured")
    today = today or date.today()
    cutoff = monthly_retention_cutoff(today)
    s3 = _s3_client(configuration)
    paginator = s3.get_paginator("list_objects_v2")
    snapshots = []
    storage_usage_bytes = 0
    counts = {"daily": 0, "monthly": 0, "manual": 0}
    snapshot_metadata = snapshot_metadata or {}
    prefix = f"{configuration['prefix']}/"
    async for page in _iterate_pages(paginator, Bucket=configuration["bucket"], Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"][len(prefix):]
            kind = snapshot_kind_from_key(key)
            if not kind:
                continue
            storage_usage_bytes += item.get("Size", 0)
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
            counts[kind] += 1
            metadata = snapshot_metadata.get(key, {})
            snapshots.append({
                "key": key,
                "kind": kind,
                "created_at": item["LastModified"].astimezone(timezone.utc).isoformat(),
                "size_bytes": item["Size"],
                "backup_id": metadata.get("backup_id"),
                "database_count": metadata.get("database_count"),
                "file_count": metadata.get("file_count"),
                "verification_status": metadata.get("verification_status", "not_verified"),
            })
    return {
        "snapshots": sorted(snapshots, key=lambda item: item["created_at"], reverse=True),
        "storage_usage_bytes": storage_usage_bytes,
        "counts": counts,
    }


async def _iterate_pages(paginator, **kwargs):
    pages = iter(paginator.paginate(**kwargs))
    sentinel = object()
    while True:
        page = await asyncio.to_thread(next, pages, sentinel)
        if page is sentinel:
            return
        yield page


async def restore_snapshot_to_copy(
    *,
    mongo_url,
    database_names,
    configuration,
    snapshot_key_value,
    base_database_name,
    database_companies=None,
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
        head = await asyncio.to_thread(
            s3.head_object,
            Bucket=configuration["bucket"],
            Key=object_key,
        )
        trusted_sha256 = head.get("Metadata", {}).get("sha256")
        if not isinstance(trusted_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", trusted_sha256):
            raise RuntimeError("Backup has no trusted SHA-256 checksum and cannot be restored")
        await asyncio.to_thread(
            s3.download_file,
            configuration["bucket"],
            object_key,
            str(archive_path),
        )
        if archive_path.stat().st_size != head.get("ContentLength") or _sha256_file(archive_path) != trusted_sha256:
            raise RuntimeError("Backup archive checksum verification failed")

        with zipfile.ZipFile(archive_path) as archive:
            manifest = _read_manifest(archive, database_names)
            for index, entry in enumerate(manifest["databases"]):
                source_database = entry["name"]
                archive_name = entry.get("archive")
                database_archive = Path(temp_dir) / f"restore-{index}.archive.gz"
                with archive.open(archive_name) as source, database_archive.open("wb") as target:
                    while chunk := source.read(1024 * 1024):
                        target.write(chunk)
                if manifest.get("format_version") == 2:
                    if database_archive.stat().st_size != entry["size_bytes"] or _sha256_file(database_archive) != entry["sha256"]:
                        raise RuntimeError("Backup database archive checksum failed")
                await _run_tool(
                    "mongorestore",
                    f"--config={mongo_config}",
                    f"--archive={database_archive}",
                    "--gzip",
                    f"--nsFrom={source_database}.*",
                    f"--nsTo={restored_names[source_database]}.*",
                )

    restored_database_names = list(restored_names.values())
    await asyncio.to_thread(_verify_restored_databases, mongo_url, restored_database_names)
    return {
        "restore_id": restore_id,
        "source_key": snapshot_key_value,
        "databases": restored_names,
        "restored_at": datetime.now(timezone.utc).isoformat(),
        "verification_status": "verified",
        "message": "Historical data was restored to a separate database copy; live databases were not changed.",
    }


def _verify_restored_databases(mongo_url, database_names):
    from pymongo import MongoClient

    client = MongoClient(mongo_url, serverSelectionTimeoutMS=10_000)
    try:
        available = set(client.list_database_names())
        missing = set(database_names) - available
        if missing:
            raise RuntimeError("Restore did not create all expected isolated databases")
    finally:
        client.close()


async def delete_expired_snapshots(configuration, today=None, kinds=("daily", "monthly")):
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
            if kind == "daily" and "daily" in kinds:
                snapshot_date = date.fromisoformat(key.removeprefix("daily/").removesuffix(".zip"))
                if snapshot_date <= today - timedelta(days=MAX_DAILY_AGE_DAYS):
                    expired.append(item["Key"])
            elif kind == "monthly" and "monthly" in kinds:
                snapshot_month = date.fromisoformat(
                    key.removeprefix("monthly/").removesuffix(".zip") + "-01"
                )
                if snapshot_month < cutoff:
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
        snapshot_date = datetime.now(local_timezone).date()
        try:
            async with backup_job_lock(lock_database):
                daily = await create_snapshot(
                    mongo_url=mongo_url,
                    database_names=database_names,
                    configuration=configuration,
                    snapshot_date=snapshot_date,
                    kind="daily",
                )
                if daily.get("verification_status") != "verified":
                    raise RuntimeError("Scheduled daily backup was not verified")
                try:
                    await delete_expired_snapshots(configuration, snapshot_date, kinds=("daily",))
                    retention_cleanup_ok = True
                except Exception:
                    logging.exception("Daily backup succeeded but retention cleanup failed")
                    retention_cleanup_ok = False

                monthly = {}
                if snapshot_date.day == 1:
                    monthly_date = snapshot_date - timedelta(days=1)
                    monthly = await create_snapshot(
                        mongo_url=mongo_url,
                        database_names=database_names,
                        configuration=configuration,
                        snapshot_date=monthly_date,
                        kind="monthly",
                    )
                    if monthly.get("verification_status") != "verified":
                        raise RuntimeError("Scheduled monthly backup was not verified")
                    try:
                        await delete_expired_snapshots(configuration, snapshot_date, kinds=("monthly",))
                    except Exception:
                        logging.exception("Monthly backup succeeded but retention cleanup failed")
                        retention_cleanup_ok = False
                logging.info("Scheduled backup completed and verified: %s", daily["key"])
                try:
                    await lock_database.backup_operations.insert_one({
                        "kind": "scheduled",
                        "status": "success",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "key": daily["key"],
                        "monthly_key": monthly.get("key"),
                        "size_bytes": daily.get("size_bytes"),
                        "database_count": daily.get("database_count"),
                        "file_count": daily.get("file_count"),
                        "verification_status": "verified",
                        "retention_cleanup_ok": retention_cleanup_ok,
                    })
                except Exception:
                    logging.exception("Could not record scheduled backup history")
        except BackupBusyError:
            logging.info("Scheduled backup skipped because another backup operation is running")
        except Exception:
            logging.exception("Scheduled backup failed")
            try:
                await lock_database.backup_operations.insert_one({
                    "kind": "scheduled",
                    "status": "failed",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "key": snapshot_key("daily", snapshot_date),
                    "verification_status": "failed",
                    "error": "Scheduled backup failed; inspect backend logs.",
                })
            except Exception:
                logging.exception("Could not record scheduled backup failure")
