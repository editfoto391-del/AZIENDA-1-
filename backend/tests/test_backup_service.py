import asyncio
import hashlib
import io
import json
import zipfile
from datetime import date
from pathlib import Path

import pytest

from backup_service import (
    _mongo_config_file,
    _run_tool,
    backup_configuration,
    monthly_retention_cutoff,
    snapshot_key,
    snapshot_kind_from_key,
    create_snapshot,
    restore_snapshot_to_copy,
)


def test_backup_configuration_reports_missing_secrets_without_exposing_values(monkeypatch):
    for name in (
        "BACKUP_S3_BUCKET",
        "BACKUP_S3_ENDPOINT_URL",
        "BACKUP_S3_ACCESS_KEY_ID",
        "BACKUP_S3_SECRET_ACCESS_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BACKUP_S3_SECRET_ACCESS_KEY", "do-not-return-this-value")

    configuration = backup_configuration()

    assert configuration["configured"] is False
    assert configuration["missing"] == [
        "BACKUP_S3_BUCKET",
        "BACKUP_S3_ENDPOINT_URL",
        "BACKUP_S3_ACCESS_KEY_ID",
    ]
    assert "do-not-return-this-value" not in str(configuration)


def test_snapshot_keys_are_categorized_and_validated():
    assert snapshot_key("daily", date(2026, 10, 29)) == "daily/2026-10-29.zip"
    assert snapshot_key("monthly", date(2026, 10, 31)) == "monthly/2026-10.zip"
    assert snapshot_kind_from_key("daily/2026-10-29.zip") == "daily"
    assert snapshot_kind_from_key("monthly/2026-10.zip") == "monthly"
    assert snapshot_kind_from_key("../daily/2026-10-29.zip") is None
    assert snapshot_kind_from_key("daily/2026-13-29.zip") is None


@pytest.mark.parametrize(
    ("today", "expected"),
    [
        (date(2026, 10, 29), date(2025, 10, 1)),
        (date(2026, 1, 15), date(2025, 1, 1)),
        (date(2024, 3, 1), date(2023, 3, 1)),
    ],
)
def test_monthly_retention_keeps_the_current_month_and_previous_twelve(today, expected):
    assert monthly_retention_cutoff(today) == expected


def test_mongo_tool_config_keeps_full_uri_out_of_process_arguments(tmp_path):
    mongo_uri = (
        "mongodb://backup-user:p%40ssword@db.example.test/erp?authSource=admin"
    )
    config_path = _mongo_config_file(
        tmp_path,
        mongo_uri,
    )

    assert f"uri: {json.dumps(mongo_uri)}" in config_path.read_text(encoding="utf-8")
    assert config_path.stat().st_mode & 0o777 == 0o600


def test_mongo_tool_errors_do_not_log_or_return_tool_output(monkeypatch, caplog):
    observed = {}

    class FailedProcess:
        returncode = 1

        async def communicate(self):
            return None, None

        def terminate(self):
            pass

        async def wait(self):
            return self.returncode

        def kill(self):
            pass

    async def fake_create_subprocess_exec(*arguments, **options):
        observed["arguments"] = arguments
        observed["options"] = options
        return FailedProcess()

    import backup_service

    monkeypatch.setattr(backup_service.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    with caplog.at_level("ERROR"):
        with pytest.raises(RuntimeError, match="exit code 1"):
            asyncio.run(_run_tool("mongodump", "--config=/protected/mongo-tools.yaml"))

    assert observed["options"]["stdout"] == asyncio.subprocess.DEVNULL
    assert observed["options"]["stderr"] == asyncio.subprocess.DEVNULL
    assert "private" not in caplog.text


def test_snapshot_contains_each_company_database_and_uses_private_archive(monkeypatch, tmp_path):
    database_names = ["erp", "erp__manufactoring", "erp__wholesale"]
    uploaded = {}

    class NotFoundError(Exception):
        response = {"ResponseMetadata": {"HTTPStatusCode": 404}}

    class FakeS3:
        exceptions = type("Exceptions", (), {"ClientError": NotFoundError})

        def head_object(self, **kwargs):
            if "path" in uploaded:
                payload = Path(uploaded["path"]).read_bytes()
                return {
                    "Metadata": {"sha256": hashlib.sha256(payload).hexdigest()},
                    "ContentLength": len(payload),
                }
            raise NotFoundError()

        def upload_file(self, path, bucket, key, **_kwargs):
            uploaded.update(bucket=bucket, key=key, path=path)
            with zipfile.ZipFile(path) as archive:
                uploaded["manifest"] = json.loads(archive.read("manifest.json"))
                uploaded["members"] = archive.namelist()

        def download_file(self, _bucket, _key, destination):
            Path(destination).write_bytes(Path(uploaded["path"]).read_bytes())

    async def fake_run_tool(*arguments):
        archive_arg = next(arg for arg in arguments if arg.startswith("--archive="))
        Path(archive_arg.removeprefix("--archive=")).write_bytes(b"sample dump")
        assert all("private" not in argument for argument in arguments)

    import backup_service

    monkeypatch.setattr(backup_service, "_s3_client", lambda _: FakeS3())
    monkeypatch.setattr(backup_service, "_run_tool", fake_run_tool)
    monkeypatch.setattr(backup_service, "_excluded_collections", lambda *_: [])
    configuration = {"configured": True, "bucket": "private-backups", "prefix": "erp-backups"}

    result = asyncio.run(create_snapshot(
        mongo_url="mongodb://backup-user:private%21@localhost/erp",
        database_names=database_names,
        configuration=configuration,
        snapshot_date=date(2026, 10, 29),
        kind="daily",
    ))

    assert result["key"] == "daily/2026-10-29.zip"
    assert uploaded["bucket"] == "private-backups"
    assert uploaded["key"] == "erp-backups/daily/2026-10-29.zip"
    assert [entry["name"] for entry in uploaded["manifest"]["databases"]] == database_names
    assert len(uploaded["members"]) == len(database_names) + 1


@pytest.mark.parametrize(
    "database_names",
    [["erp"], ["erp", "erp__manufactoring", "erp__wholesale"]],
)
def test_restore_creates_an_isolated_database_copy_without_drop(monkeypatch, tmp_path, database_names):
    tool_calls = []

    class FakeS3:
        def __init__(self):
            manifest = {
                "format_version": 1,
                "databases": [
                    {"name": database_name, "archive": f"database-{index}.archive.gz"}
                    for index, database_name in enumerate(database_names)
                ],
            }
            data = io.BytesIO()
            with zipfile.ZipFile(data, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest))
                for index in range(len(database_names)):
                    archive.writestr(f"database-{index}.archive.gz", b"dump")
            self.payload = data.getvalue()

        def head_object(self, **_kwargs):
            return {
                "Metadata": {"sha256": hashlib.sha256(self.payload).hexdigest()},
                "ContentLength": len(self.payload),
            }

        def download_file(self, _bucket, _key, destination):
            Path(destination).write_bytes(self.payload)

    async def fake_run_tool(*arguments):
        tool_calls.append(arguments)

    import backup_service

    monkeypatch.setattr(backup_service, "_s3_client", lambda _: FakeS3())
    monkeypatch.setattr(backup_service, "_run_tool", fake_run_tool)
    monkeypatch.setattr(backup_service, "_verify_restored_databases", lambda *_: None)
    configuration = {
        "configured": True,
        "bucket": "private-backups",
        "prefix": "erp-backups",
    }

    result = asyncio.run(restore_snapshot_to_copy(
        mongo_url="mongodb://backup-user:private%21@localhost/erp",
        database_names=["erp"],
        configuration=configuration,
        snapshot_key_value="monthly/2026-09.zip",
        base_database_name="erp",
    ))

    assert result["source_key"] == "monthly/2026-09.zip"
    assert result["databases"]["erp"].startswith("erp__rec_")
    assert all(
        restored.startswith(result["databases"]["erp"])
        for source, restored in result["databases"].items()
        if source != "erp"
    )
    assert len(set(result["databases"].values())) == len(database_names)
    assert all(not any(argument == "--drop" for argument in call) for call in tool_calls)
    targets = [
        argument.removeprefix("--nsTo=")
        for call in tool_calls
        for argument in call
        if argument.startswith("--nsTo=")
    ]
    assert len(targets) == len(database_names)
    assert len(set(targets)) == len(database_names)
    assert len(tool_calls) == len(database_names)
