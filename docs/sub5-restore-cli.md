# Backup and restore runbook

This runbook covers two different recovery layers in the current self-hosted stack:

- The application archive API (`GET /api/_/export` and `POST /api/_/import`) exports the
  tables curated by `src/server/export/archive.ts` and can optionally include R2 bytes. It
  requires the Hono API to be running.
- A compose-level Postgres dump is the disaster-recovery path for the complete database and
  does not depend on the application process. R2 still needs its own backup.

The original Sub 5 design in
`docs/superpowers/specs/2026-05-10-phase1a-sub5-design.md` explains the archive format, but
its deployment examples are historical. The commands below are authoritative for the current
Hono + Postgres + S3-compatible R2 stack.

## Application archive setup

Run these commands from the repository root. Local development normally uses `.env.local`;
the compose host normally uses `.env`.

```bash
ENV_FILE=.env.local
test -f "$ENV_FILE" || ENV_FILE=.env

TOKEN="$(node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.INTERNAL_TOKEN ?? "")')"
test -n "$TOKEN"

HOST="http://127.0.0.1:8787" # local Hono API
# HOST="https://<your-tunnel-hostname>" # NAS through Cloudflare Tunnel
```

Do not print `TOKEN` or commit either environment file.

## Export database references

This is the fast default. It includes Postgres rows and R2 storage keys, but not object bytes.

```bash
BACKUP="loom-backup-$(date +%F).zip"
curl -fsS \
  -H "x-internal-token: $TOKEN" \
  -o "$BACKUP" \
  "$HOST/api/_/export"

unzip -t "$BACKUP"
unzip -p "$BACKUP" manifest.json | jq '{schema_version, include_assets, row_counts}'
```

## Export with R2 bytes inline

For at most 45 `source_asset` rows, the supported one-file backup path is:

```bash
BACKUP="loom-backup-full-$(date +%F).zip"
curl -fsS \
  -H "x-internal-token: $TOKEN" \
  -o "$BACKUP" \
  "$HOST/api/_/export?include_assets=1"

unzip -t "$BACKUP"
unzip -p "$BACKUP" manifest.json | jq '{include_assets, asset_count, missing_assets}'
```

The API returns HTTP 400 with `error: "too_many_assets"` above the 45-object safety cap. Use
the references-only archive plus the S3 sidecar below instead of editing `manifest.json` by
hand.

## R2 sidecar for larger libraries

This path downloads only the keys referenced by the application archive. It needs AWS CLI v2
and `jq`; Cloudflare R2 is accessed through its S3-compatible endpoint.

```bash
R2_ENDPOINT="$(node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.R2_ENDPOINT ?? "")')"
R2_BUCKET="$(node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.R2_BUCKET ?? "")')"
export AWS_ACCESS_KEY_ID="$(node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.R2_ACCESS_KEY_ID ?? "")')"
export AWS_SECRET_ACCESS_KEY="$(node --env-file="$ENV_FILE" -e 'process.stdout.write(process.env.R2_SECRET_ACCESS_KEY ?? "")')"
export AWS_DEFAULT_REGION=auto
test -n "$R2_ENDPOINT" && test -n "$R2_BUCKET"

rm -f /tmp/loom-r2-keys.txt
unzip -p "$BACKUP" data.json \
  | jq -r '.source_asset[].storage_key' \
  | sort -u > /tmp/loom-r2-keys.txt

mkdir -p r2-sidecar
while IFS= read -r key; do
  target="r2-sidecar/$key"
  mkdir -p "$(dirname "$target")"
  aws s3api get-object \
    --endpoint-url "$R2_ENDPOINT" \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    "$target" >/dev/null
done < /tmp/loom-r2-keys.txt
```

Verify every referenced object was copied:

```bash
test "$(wc -l < /tmp/loom-r2-keys.txt | tr -d ' ')" \
  -eq "$(find r2-sidecar -type f | wc -l | tr -d ' ')"
```

After importing the references-only ZIP into a new or empty R2 bucket, restore the sidecar:

```bash
aws s3 sync \
  --endpoint-url "$R2_ENDPOINT" \
  r2-sidecar/ \
  "s3://$R2_BUCKET/"
```

## Import an application archive

> Destructive database operation. Stop writers, verify the target host and archive, and keep
> a compose-level Postgres dump before continuing.

Import validates the ZIP, schema version, table names, columns, and row shapes before mutation.
The database replacement itself runs in one transaction: a failure rolls back atomically and
leaves Postgres unchanged. An archive with inline assets writes R2 after the database commit;
individual R2 failures therefore appear in `failed_keys` and must be retried.

```bash
BACKUP="loom-backup-2026-07-17.zip"
unzip -t "$BACKUP"
unzip -p "$BACKUP" manifest.json | jq

curl -fsS -X POST \
  -H "x-internal-token: $TOKEN" \
  -H "content-type: application/zip" \
  --data-binary "@$BACKUP" \
  "$HOST/api/_/import?confirm=wipe-and-reload" \
  | tee restore-result.json

jq -e '.ok == true' restore-result.json
```

A successful response contains per-table `deleted` / `inserted` counts plus
`assets_uploaded`, `assets_failed`, and `failed_keys`. Compare the table counts with
`manifest.json.row_counts`.

If `schema_version` differs from the running Hono API, import returns HTTP 400 with
`error: "schema_version_mismatch"`. Shape errors also return HTTP 400 before any database
mutation. A mid-transaction failure returns HTTP 500 and explicitly reports that the database
was left unchanged.

## R2 orphan audit

Application import overwrites included keys but deliberately does not delete any existing R2
object. Audit before deleting anything:

```bash
unzip -p "$BACKUP" data.json \
  | jq -r '
      .source_asset[]?.storage_key,
      (.question_block[]?.crop_refs[]? | "figures/\(.).png"),
      (.question_block[]?.figures[]?.asset_id | "figures/\(.).png")
    ' \
  | sort -u > /tmp/loom-r2-referenced.txt

aws s3api list-objects-v2 \
  --endpoint-url "$R2_ENDPOINT" \
  --bucket "$R2_BUCKET" \
  --query 'Contents[].Key' \
  --output text \
  | tr '\t' '\n' \
  | sed '/^None$/d' \
  | sort -u > /tmp/loom-r2-present.txt

comm -23 /tmp/loom-r2-present.txt /tmp/loom-r2-referenced.txt \
  > /tmp/loom-r2-orphans.txt
cat /tmp/loom-r2-orphans.txt
```

The referenced set includes both `source_asset.storage_key` objects and OCR figure crops. Crop
objects use the `figures/<asset_id>.png` key convention and are referenced by
`question_block.crop_refs` / `question_block.figures[].asset_id`, not by `source_asset`.

Treat the output as a review list, not an automatic delete list. Take an R2 backup first. To
delete one confirmed orphan explicitly:

```bash
ORPHAN_KEY="<confirmed-storage-key>"
aws s3api delete-object \
  --endpoint-url "$R2_ENDPOINT" \
  --bucket "$R2_BUCKET" \
  --key "$ORPHAN_KEY"
```

## Full Postgres disaster recovery

The application archive intentionally follows the app's curated table contract. For a complete
database snapshot on the compose host, including operational tables and schema objects, use a
Postgres custom-format dump:

```bash
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="backups/loom-$STAMP.dump"

docker compose exec -T postgres pg_dump \
  -U "${POSTGRES_USER:-loom}" \
  -d "${POSTGRES_DB:-loom}" \
  -F custom > "$DUMP"

test -s "$DUMP"
docker compose exec -T postgres pg_restore -l < "$DUMP" >/dev/null
```

The repository also provides `pnpm db:dump` for a plain-SQL dump to `/tmp` and
`pnpm db:restore < /tmp/<dump>.sql` for its matching restore path.

To restore a custom-format dump, first stop application writers. The following command replaces
the target database objects; confirm `DUMP` and the compose project before running it:

```bash
docker compose stop app worker

docker compose exec -T postgres pg_restore \
  -U "${POSTGRES_USER:-loom}" \
  -d "${POSTGRES_DB:-loom}" \
  --clean --if-exists --no-owner --single-transaction --exit-on-error \
  < "$DUMP"

docker compose up -d migrate app worker
docker compose ps
```

Smoke-test the Hono API through the actual deployment ingress after restore:

```bash
curl -fsS "$HOST/api/health"
```

Postgres dumps do not contain R2 objects. Pair every disaster-recovery snapshot with either an
inline application archive or an independently verified R2 sidecar/bucket backup.
