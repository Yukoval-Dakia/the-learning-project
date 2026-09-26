# YUK-1057 — isolated rehearsal + D18 eval readiness

Isolated backup→restore→capture→classify→apply→verify rehearsal against a throwaway
Postgres container, plus the D18 eval-harness readiness runner. Neither touches the
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

## D18 eval readiness runner

```bash
pnpm eval:d18 --target=<postgres-url> [--run-id=<id>] [--out=<dir>]
              [--items=<N>] [--attempts=<N>]
```

`--target` is mandatory (sealing evidence writes `ai_task_runs` rows — a write
path that never falls back to `DATABASE_URL`). Point it at a scratch database
(e.g. an ephemeral container or a `*_d18` db on the docker dev Postgres), never
the production/NAS database.

Proof surface: `EvalBudgetGate` real accounting (admit → invoke → settle, latch +
halt on first ceiling), evidence double-sealed to `<out>/evidence.ndjson` and
`ai_task_runs` (`task_kind='D18EvalHarness'`, input/result digests, usage and
cost basis recorded verbatim).

### Live actual-output run (owner-triggered)

The shipped invoker is a deterministic **stub** with zero egress — it proves
harness, gate, and sealing are ready. A real provider invoker lane
(`--lane=jev-openrouter|mimo-text|mimo-vision`) is implemented by the eval ticket
that plugs a provider-bound `EvalInvoker` into `runEvalHarness`; the budget gate,
retry accounting, and evidence seams are identical. Do not run real provider keys
through this runner as shipped — there is no live lane wired yet.

When the live lane lands, the owner-triggered command is:

```bash
pnpm eval:d18 --target=<scratch-db-url> --lane=<real-lane> \
  --items=<corpus-size> --attempts=<max-retries> --run-id=<d18-live-N>
```

D18 budget caps ($5 total, ≤200 verification calls, ≤800 requests, per-call
token caps, unknown-cost conservative reserve, first-ceiling halt) are pinned in
`src/core/eval/d18-budget.ts` (`D18_BUDGET_CAPS`) and enforced by the gate itself,
not by the invoker.
