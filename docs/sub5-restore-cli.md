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
  | jq -r '
      .source_asset[]?.storage_key,
      (.question_block[]?.crop_refs[]? | "figures/\(.).png"),
      (.question_block[]?.figures[]?.asset_id | "figures/\(.).png")
    ' \
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

YUK-842 provider gate: the import endpoint requires Hono to remain running, so this is not a generic
"stop every process" restore. First block user ingress and pause job dispatch, then wait for central
SDK sessions to finish normally. Before aborting, killing, or stopping any remaining owner, inspect
and record its quarantine bound while the operational table still exists:

```sql
select count(*) filter (where status in ('acquired', 'lease_expired')) as active_or_quarantined,
       count(*) filter (where status = 'waiting') as waiting,
       max(hard_reclaim_at) as restore_quarantine_until
from provider_session_admission
where (status = 'waiting' and wait_deadline_at > clock_timestamp())
   or (status in ('acquired', 'lease_expired') and hard_reclaim_at > clock_timestamp());
```

Zero waiting and zero active/quarantined rows are necessary but not sufficient: a single DB snapshot
cannot prove that an already-running caller is not between its wait loop and acquire transaction.
Only an application-level in-flight drain signal, after ingress/dispatch have been blocked, may prove
normal drain. Persist any returned maximum outside Postgres before abort/stop/import; it remains a
mandatory lower bound even after the table is wiped. Then stop worker and restart/retain only the
admin Hono process with
`AI_PROVIDER_SESSION_ADMISSION_MODE=off`. Record the time of the last provider traffic. Do not allow
normal API traffic while the import is running. The archive excludes and transactionally wipes
`provider_session_admission`.

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

Before reopening ingress, wait until all applicable bounds have passed:

1. 60 seconds since the last pre-restore provider traffic (start-reservation window).
2. The captured `restore_quarantine_until`.
3. Unless application-level normal drain was positively confirmed, process stop time plus the deployed
   45s SDK startup budget, maximum execution timeout, and 30s abort grace. This worst-case fallback is
   mandatory for every abort/kill/ambiguous stop; a shorter DB snapshot may extend it but may never
   shorten it.

Abort is not proof that an already sent provider request stopped. If the admission table/state was
already lost, a central caller ran off/unlisted, or no trustworthy application-level drain signal
exists, use the same stop-time worst-case bound. If the deployed maximum timeout cannot be proven,
keep ingress/dispatch closed. Once safe, restart app and worker together with one identical admission
mode/policy.

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

The existing full helpers add a source-bound parity gate to this manual dump path:

```bash
# The maintenance owner supplies a held boundary; these helpers never stop/restart writers.
bash scripts/cutover-final-backup.sh --target=<pg-url> \
  --quiescence-evidence=<maintenance.json> --out=<capture-root> --strict
# Read the returned unique capture directory. After successful sealing, the owner may release it.
bash scripts/restore-drill.sh --dump=<capture>/database.dump \
  --source-manifest=<capture>/source-manifest.json --out=<capture>/restore-evidence.json
pnpm exec tsx scripts/cutover-backup.ts --capture-dir=<capture>/migration \
  --dump=<capture>/database.dump --dlq=<capture>/dlq-tombstones.json \
  --source-manifest=<capture>/source-manifest.json --restore-evidence=<capture>/restore-evidence.json \
  --out=<capture> --strict --require-restore-parity
```

`--strict` retains the required migration manifest/dump/DLQ presence rule. The independent
`--require-restore-parity` gate requires a current successful version-2 receipt. It rehashes the
selected artifacts, checks dump/source/quiescence links and phase outcomes, and recomputes comparison.
No success boolean alone satisfies the gate. Legacy unversioned receipts are preserved unchanged:
`reported_verified` records their historical claim; normalized `verified` is false. For a legacy dump,
explicit `--restore-only --image=<compatible-image>` proves SQL loading only. `--list-only` checks TOC
and emits no parity receipt. Existing receipt paths are refused; `--overwrite` archives the previous
receipt before attempting a replacement. Failed attempts exit nonzero and write failed JSON where writable.

The source uses a live exported snapshot through dump and all source reads. Its logical algorithm is
`pg16-column-text-sha256-multiset-v1`: fixed UTF-8/UTC PostgreSQL 16 text values, ordered column/type
metadata, sorted full-row SHA-256 digests with duplicate multiplicity, streamed into a table digest.
It covers every non-system schema (including empty schemas), physical table/partition/inheritance rows
using `ONLY`, and all sequences with decimal-string `last_value` and boolean `is_called`. Supported
value types include ordinary deterministic builtins, pgvector `vector`, enums with ordered labels,
and recursively supported arrays/domains. Unknown output types, foreign tables, unpopulated materialized
views, denied RLS reads, query/stream/TOC/restore failures and missing/extra inventories fail visibly.
Host table/dump hashing is bounded; database sort work uses bounded work_mem/temp_file_limit and deadlines.

The required `loom-maintenance-boundary` JSON identifies `owner`, `window`, `established_at`,
`held_until_explicit_release:true`, source cluster/database identity, `source_revision`, and
enforced `restart_admission_control`, `other_clients_control`, and
`background_writers_control`. `writers` lists stopped container IDs or externally controlled host/remote
writers. Its basis is `external-maintenance-boundary`. See the exported `quiescenceEvidenceSchema` in
`src/core/migration/cutover-manifest.ts` for the exact shape. All writers, schedulers, admin/migration
clients, replication/background writing jobs and sequence actors must be accounted for. A boolean
“writers stopped”, unknown controls or requested controls are insufficient. The helper compares host
and container cluster/database identity and observes sessions/prepared transactions/listed containers;
those observations detect violations and do not enforce continuous exclusion or freeze sequences.
Assurance is `operator-attested-with-observations`. Companion DLQ/migration captures remain inside the
same externally held boundary; the existing migration CLI does not import the exported snapshot.

Version 1 retains mandatory immutable `app_image` and `worker_image`. A host Node worker with no app
uses version 2 with `execution.kind="host-node-v1"`, `execution.app={"kind":"absent"}`,
`execution.runtime={"kind":"node","version":<process.version>,"artifact":<file/sha256/bytes>}`,
and `execution.worker={"name":<controlled-host-writer>,"artifact":<file/sha256/bytes>}`.
The worker name must match an enforced external entry in `writers`. Capture, restoration and final
artifact assembly rehash these exact files. The runtime bytes and version must also match the helper's
pinned `process.execPath` and `process.version`. Mixed image/host evidence, missing provenance and
changed artifacts fail. These digests bind artifacts; the external maintenance owner remains responsible
for proving that this worker used them and was stopped. Explicit `--target` identity uses the installed
`postgres` driver lazily, with a read-only transaction, one owned connection and bounded close. It does
not require host `psql`, import the application DB, use an inherited database URL or log credentials.

The default scratch has `--network=none`. For parent acceptance that must reopen the same restored
database, full parity supports only this paired, explicit exception:

```text
bash scripts/restore-drill.sh --dump=<sealed-dump> --source-manifest=<capture-source-manifest> --quiescence-evidence=<maintenance.json> --out=<new-attempt-receipt> --keep --scratch-loopback-port=<1024..65535> --scratch-database=test_fork_<digits>
```

Both scratch options require `--key=value` once, full mode and `--keep`; bare, duplicated, malformed,
unpaired or limited-mode options fail before Docker. The helper creates a new random container from
the locally resolved immutable image with `--pull=never`, `--network=bridge` and exactly
`127.0.0.1:<port>:5432`. A collision fails; it never chooses another port, stops another owner, restores
to an existing target or attaches a caller's volume. It verifies ID/name/image/attempt label, environment,
storage and actual mapping before every exec and cleanup, and reads database identity before/after
restore and inspection. Unknown or ambiguous creation never permits name-based cleanup.

The current receipt adds `scratch.ownership={container_id,attempt,volumes}` for an observed owned
container. Only a successful retained loopback attempt adds `scratch.reopen` with
`kind="retained-loopback-v1"`, full `container_id`, literal host, observed port and full database identity.
A failed retained container has no reopen object and grants no launch authority. Ordinary current
parity receipts without reopen remain valid parity evidence and cannot satisfy the parent's reopen
gate. The parent must hash-bind the exact helper closure, new receipt, sealed capture/dump/quiescence
inputs and target witness, recheck the actual ID/label/image/mapping and durable DB identity, and hold
maintenance through launch. Host and container route addresses may differ; cluster/database OID/name,
version/start time and recovery state must match. No second restore, migration or writer may intervene.
The parent owns eventual cleanup of the recorded disposable volumes. The helper never launches a worker.

Measure scratch parity before migrations, admission-row deletion or worker reopen. Database-content
parity does not certify complete DDL/roles/privileges, R2 blobs, Mem0 or durable worker recovery. Parent
acceptance separately restores nonempty completed/pending/held DBOS obligations and proves safe reopen.

The repository also provides `pnpm db:dump` for a plain-SQL dump to `/tmp` and
`pnpm db:restore < /tmp/<dump>.sql` for its matching restore path.

To restore a custom-format dump, first block ingress/dispatch and record the time of the last provider
traffic. Run the waiting/active/quarantined query from the application-import section and persist its
maximum `hard_reclaim_at` outside Postgres before aborting or stopping any owner. Unless a separate
application-level signal positively confirms normal drain, also record process stop time and use the
deployed 45s SDK startup budget + maximum execution timeout + 30s fallback. The dump includes
operational admission rows, so they must be discarded after migrations and before app/worker restart.
Confirm `DUMP` and the compose
project before running:

```bash
docker compose stop app worker

docker compose exec -T postgres pg_restore \
  -U "${POSTGRES_USER:-loom}" \
  -d "${POSTGRES_DB:-loom}" \
  --clean --if-exists --no-owner --single-transaction --exit-on-error \
  < "$DUMP"

docker compose run --rm migrate
docker compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 \
  -U "${POSTGRES_USER:-loom}" \
  -d "${POSTGRES_DB:-loom}" \
  -c 'TRUNCATE TABLE provider_session_admission'

# Wait for the >=60s rate bound, any captured restore_quarantine_until, and—unless
# application-level drain was confirmed—stop time + 45s startup budget + deployed
# max execution timeout + 30s abort grace.
# If either bound is unknown, remain fail-closed and do not run this start command.
docker compose up -d app worker
docker compose ps
```

Smoke-test the Hono API through the actual deployment ingress after restore:

```bash
curl -fsS "$HOST/api/health"
```

Postgres dumps do not contain R2 objects. Pair every disaster-recovery snapshot with either an
inline application archive or an independently verified R2 sidecar/bucket backup.
