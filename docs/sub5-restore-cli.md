# Sub 5 — Restore CLI

Companion notes for `/api/_/export` + `/api/_/import`. The endpoint surface
is documented in `docs/superpowers/specs/2026-05-10-phase1a-sub5-design.md`;
this file lists day-to-day commands.

## Setup

```bash
TOKEN="$(grep INTERNAL_TOKEN .dev.vars | cut -d= -f2 | tr -d \\'\")"
HOST="http://127.0.0.1:8787"   # local
# HOST="https://your-worker.your-account.workers.dev"  # prod
```

## Export (refs only — small, fast)

```bash
curl -H "x-internal-token: $TOKEN" \
     -o "loom-backup-$(date +%F).zip" \
     "$HOST/api/_/export"
```

## Export (with R2 image bytes inline)

Server refuses if you have more than 45 R2 objects. If so, take refs-only and
pull bytes via wrangler (next section).

```bash
curl -H "x-internal-token: $TOKEN" \
     -o "loom-backup-full-$(date +%F).zip" \
     "$HOST/api/_/export?include_assets=1"
```

## Pull R2 bytes via wrangler (sidecar)

For >45 assets, take a refs-only export and pull each asset directly:

```bash
mkdir -p ./r2-sidecar
unzip -p loom-backup-2026-05-10.zip data.json \
  | jq -r '.source_asset[].storage_key' \
  | while read -r key; do
      wrangler r2 object get "learning-project-images/$key" \
        --file "./r2-sidecar/$key"
    done
```

Pack the sidecar files into the ZIP at the `assets/<key>` paths. Easiest path:

```bash
mkdir -p staging/assets
cp ./r2-sidecar/* staging/assets/
unzip loom-backup.zip -d staging/
cd staging
zip -r ../loom-backup-with-assets.zip .
cd ..
```

Then update `manifest.json` inside the ZIP to set `include_assets: true` and
`asset_count: N`. Or open the ZIP and edit it manually.

(In practice: easiest path is to have <45 assets and use `?include_assets=1`.)

## Import (destructive — wipes D1; overwrites R2 keys but does NOT wipe R2)

```bash
curl -X POST \
  -H "x-internal-token: $TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @loom-backup-2026-05-10.zip \
  "$HOST/api/_/import?confirm=wipe-and-reload"
```

Response is JSON:

```json
{
  "ok": true,
  "stats": { "knowledge": {"deleted": 0, "inserted": 42}, ... },
  "assets_uploaded": 12,
  "assets_failed": 0,
  "failed_keys": []
}
```

`ok` is `false` if any R2 PUT failed; `failed_keys` lists the storage_keys.

If `schema_version` doesn't match the running worker (`1.0`), import returns
400 with `{error: "schema_version_mismatch", expected, got}`.

If `data.json` has column-shape problems, import returns 400 with
`{error: "data_validation_failed", issues: [...]}` and D1 is NOT wiped.

## R2 orphans

Restore PUTs assets included in the ZIP but does NOT delete pre-existing
R2 objects. If you restore an older backup, R2 may carry orphan keys from
the in-between state. To clean up:

```bash
# List all R2 keys (fragmented across pages):
wrangler r2 object list learning-project-images

# Cross-reference with manifest.row_counts.source_asset post-restore.
# Delete by key:
wrangler r2 object delete learning-project-images/<orphan-key>
```

Or live with the orphans (they cost ~$0.015/GB/month).
