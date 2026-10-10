# YUK-1057 — isolated rehearsal + D18 eval readiness

Isolated backup→restore→capture→classify→apply→verify rehearsal against a throwaway
Postgres container. It never touches the
running compose stack, `.env`, or any real `DATABASE_URL`.

## Rehearsal

```bash
pnpm rehearsal:cutover [--out=<dir>]
```

Runs all steps inside one ephemeral `pgvector/pgvector:0.8.2-pg16-bookworm`
testcontainer (same image tag as production compose). Steps: provision + full
`scripts/migrate.ts` boot surface, synthetic-corpus seed, in-container `pg_dump -Fc`,
`pg_restore` into a second database, row-hash restore proof (rollback boundary a),
`migration:capture` (with idempotent rerun), maintenance-window open with
stale-writer lock injection and epoch-fence probes, `migration:apply` with a
mid-execution backend crash + resume, single-writer advisory-lock rejection,
idempotent rerun, registry-bound supersession rerun, `mark_ready`/`activate` epoch
transitions (post-activate probes produce `epoch_mismatch` — the proof that old
code must not run on the post-cutover DB), post-cutover writes through the real
writer seams, delta export, and rollback boundary b (restore + replay +
reconciliation on a third database).

Artifacts land in `.remember/rehearsal/<UTC-ts>/` (gitignored): `report.json`,
`steps.jsonl`, `backup.dump`, `restore-diff.json`, `cutover-window.json`,
`failure-lock.json`, `postwrite-delta.json`, `registry.json`,
`rollback-b-reconcile.json`. Exit 0 only when every acceptance flag is green.

Isolation guardrails are hard-coded, not by discipline: the runner overwrites
`DATABASE_URL` with an unreachable placeholder before any app import, the only
Postgres it ever touches is the container it started, and blobs go to a local
filesystem store (`src/server/rehearsal/blob-store.ts`) — no R2 env, no provider
key, no model egress.

## D18 eval readiness runner (removed)

`pnpm eval:d18` and its harness (`scripts/eval-d18.ts`, `src/core/eval/d18-*`,
`src/server/eval/d18-*`) were removed in YUK-1401 (#1631, main `87f66b3e2`). Retrieve
them from `87f66b3e2^` if a D18 actual-output run is ever needed again; no runner
ships today. The rehearsal above is unaffected.
