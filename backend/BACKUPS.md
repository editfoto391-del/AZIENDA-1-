# Historical backups

The Backups tab in Settings is available to the primary owner. Automated snapshots are written to a private S3-compatible bucket (Cloudflare R2 is the recommended option), not to the live application database.

## Retention and restore behavior

- A daily snapshot runs at 02:00 in `Africa/Johannesburg` and is retained for 30 days.
- A monthly snapshot is retained for the first successful daily run of each month, for 12 months. This gives a selectable historical copy from each month.
- The primary owner can also create a manual snapshot from Settings.
- Restoring a snapshot creates new, separately named MongoDB databases. It does not replace or delete the live databases.
- The current application does not store uploaded documents outside MongoDB, so these snapshots cover the database records only.

## Cloudflare R2 setup

1. Create a private R2 bucket for ERP backups.
2. Create an R2 API token restricted to that bucket, with object read, write, and delete permissions.
3. Configure these values as protected environment variables on the backend deployment. Do not put credentials in the frontend or send them in chat.

| Variable | Value |
|---|---|
| `BACKUP_S3_BUCKET` | The bucket name |
| `BACKUP_S3_ENDPOINT_URL` | `https://<account-id>.r2.cloudflarestorage.com` |
| `BACKUP_S3_ACCESS_KEY_ID` | The access key from the R2 token |
| `BACKUP_S3_SECRET_ACCESS_KEY` | The secret key from the R2 token |
| `BACKUP_S3_REGION` | `auto` (default) |
| `BACKUP_S3_PREFIX` | Optional object prefix; defaults to `erp-backups` |

The backend runtime must include MongoDB Database Tools (`mongodump` and `mongorestore`). Restart the backend after configuring the variables. Settings > Backups shows whether storage and tools are ready.

Keep the bucket private and enable the provider's at-rest encryption. The backup archive includes company records and account data, so only the primary owner can create, list, or restore snapshots.

## Restoring a snapshot

Choose a snapshot in Settings > Backups and confirm **Restore to copy**. The backend creates isolated recovery databases and shows their names and recovery ID. Live databases remain unchanged. The recovered databases are not opened as a workspace in the application; connecting them to a separate read-only workspace is a separate deployment task.
