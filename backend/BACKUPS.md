# Historical backups

The Backups tab in Settings is available to the primary owner. Automated snapshots are written to a private S3-compatible bucket (Cloudflare R2 is the recommended option), not to the live application database.

Production backups remain disabled until all required S3-compatible settings are configured and the MongoDB dump/restore runtime tools are installed. Until then, startup does not start the backup scheduler and manual/restore/status APIs report the missing configuration or unavailable tools.

## Retention and restore behavior

- A daily snapshot runs at 02:00 in `Africa/Johannesburg` and is retained for 30 days.
- A monthly snapshot is retained for the first successful daily run of each month, for 12 months. This gives a selectable historical copy from each month.
- The primary owner can also create a manual snapshot from Settings.
- Restoring a snapshot creates new, separately named MongoDB databases. It does not replace or delete the live databases.
- Scope: only the `invoices`, `payments`, `customers` and `deleted_customers` collections of all three company databases. Invoice PDFs are generated from invoice data and are not stored as files.

## Cloudflare R2 setup

1. Create a private R2 bucket for ERP backups.
2. Create an R2 API token restricted to that bucket, with object read, write, and delete permissions.
3. Configure these values as protected environment variables on the backend deployment. Do not put credentials in the frontend or send them in chat.

| Variable | Value |
|---|---|
| `BACKUP_S3_BUCKET` | Required bucket name |
| `BACKUP_S3_ENDPOINT_URL` | Required S3-compatible endpoint, such as `https://<account-id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_ACCESS_KEY_ID` | Required credential ID for a token restricted to this bucket |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Required matching secret credential |
| `BACKUP_S3_REGION` | Optional region; use `auto` for R2 (default) |
| `BACKUP_S3_PREFIX` | Optional object prefix; defaults to `erp-backups` |

The backend deployment/runtime must include MongoDB Database Tools and expose both `mongodump` and `mongorestore` on `PATH`. Store credentials only as protected backend environment variables; never in the frontend, source, chat, or public configuration.

Keep the bucket private and restrict the API token to the smallest required bucket scope. The token should permit object read, write, and delete for backup operations; the bucket should block public access and enable provider-managed at-rest encryption. The backup archive includes company records and account data, so only the primary owner can create, list, verify, or restore snapshots.

The adapter does not add an application-level or S3 encryption header. Existing provider-at-rest encryption is therefore required; no client-side encryption key or per-upload encryption header is configured by the current implementation.

Restart the backend after configuring the variables and installing the MongoDB tools. Settings > Backups shows whether storage and tools are ready. In the current infrastructure, backups remain inactive until the required configuration and tools are present.

## Restoring a snapshot

Choose a snapshot in Settings > Backups and confirm **Restore to copy**. The backend creates isolated recovery databases and shows their names and recovery ID. Live databases remain unchanged. The recovered databases are not opened as a workspace in the application; connecting them to a separate read-only workspace is a separate deployment task.
