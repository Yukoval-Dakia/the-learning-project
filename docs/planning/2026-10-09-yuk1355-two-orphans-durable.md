# YUK-1394 implementation and parent acceptance runbook

The two existing six-hour orphan families now share four tables keyed by their exact names. Author source work is complete; runtime acceptance and cutover are pending. The approved contract is [the YUK-1394 design](2026-10-09-yuk1394-session-orphans-dbos.md). This document records author evidence and prepares the parent's acceptance work. It grants no runtime authorization to the author.

## Implemented behavior

`session-orphan-family.ts` owns canonical identity, admission, frozen candidates, row receipts and primary inspection. `session-orphan-backend.ts` owns independent family phases, obligations, dispositions, quiescence and rollback horizon. `session-orphan-worker.ts` registers the two exact workflows and family-bound adapters. `scripts/session-orphan-backend.ts` is a client-only operator requiring explicit `--family`; it does not launch an SDK host or replay workflows.

Migration0117 creates `session_orphan_control`, `session_orphan_tick`, `session_orphan_receipt` and `session_orphan_disposition`. Composite family keys and foreign keys prevent evidence sharing. Three evidence tables reject UPDATE/DELETE. Control rows start at `pg-boss`. The exact-two-family producer trigger reads the matching control row before pg-boss job/schedule insertion; accepted task state updates remain legal. Missing control fails closed.

Conversation selects active/idle; placement selects started. Both use strict `started_at < fixed_tick - interval '6 hours'`. Original timestamps retain microseconds. Recent input, resume, updated_at and version changes do not reset age; selected timestamp/version are evidence, not CAS. Each domain helper reuses its original transition. Conversation takes the original selection advisory lock before row lock. Placement preserves existing wrapper errors and idempotency. The original transition, version/ended_at, job event/transactional notification and row receipt commit together. No new domain event, provider, theta or starter effect is introduced.

Native identity is `sched-<exact-family>-<scheduledISO>`. Legacy admission requires the actual pg-boss UUID and corroborated queue name, canonicalizes UUID case, and stores the first-admission DB clock. The whole sorted candidate set freezes atomically with admission. There is no identity-free sweep entry. Saved receipts win even after phase/domain changes. Unknown COMMIT outcomes reconcile under the same family control/tick locks on a writable primary at READ COMMITTED. A lock-proven rollback may receive a deferred-known-failure receipt; unavailable primary remains unknown. Contract corruption and hook failures propagate.

Each family independently drains admitted work and fences unadmitted deliveries with explicit empty headers. Finish requires task/receipt/forwarder settlement and quiescence tied to the exact family/barrier/backend. Terminal row retirement precedes terminal task retirement; real task rows are re-read under lock and retained. Active, missing, DLQ and unknown tasks cannot be retired as success. Disposed gaps reject later execution. Rollback adds the selected family's 60-second minimum occurrence horizon, verifies effective missed policy, and requires actual consumer/producer exit evidence.

The shared host registers prune, review, conversation and placement before one SDK launch. Existing `prune-v1`, application/schema, prune workflow/step and review identities stay unchanged. Production declarations admit exactly those four; new families have no load/singleton metadata. The original daily cron offsets remain04:25/04:35 Asia/Shanghai. `promote_conversation_idle` is unchanged. Learner archive exclusion does not establish full-DB restore safety.

## Author validation

Workspace `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`; branch `feat/yuk-1394-session-orphans-dbos`; clean starting HEAD `b259598348f014b4eb8959305cb45136d17c335d`. Fresh-fetch migration allocation confirmed main `e1f2ef6bb7af15fc633ffea5c9909f0968ad99cd`, zero commits behind, journal ending0116 and no0117 before generation.

All commands used Node24 PATH `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`. Logs and machine-readable evidence are under `/tmp/yuk1394-author`.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `pnpm vitest run --config vitest.unit.config.ts src/server/durable/prune-worker.unit.test.ts src/server/export/constants.test.ts` | 0 | `unit.log`: 2 files, 50 tests |
| `pnpm typecheck` | 0 | `typecheck.log` |
| `pnpm lint` | 0 | `lint.log`: 290 warnings, no fixes |
| `pnpm build` | 0 | `build.log`: web, Start, server, worker, migrate |
| `pnpm audit:partition` | 0 | `audit-partition.log` |
| `pnpm audit:capability-boundaries` | 0 | `audit-capability-boundaries.log` |
| `pnpm audit:provider-lanes` | 0 | `audit-provider-lanes.log` |
| `pnpm audit:profile` | 0 | `audit-profile.log` |
| `pnpm audit:task-census` | 0 | `audit-task-census.log` |
| `pnpm audit:agent-control-plane` | 0 | `audit-agent-control-plane.log` |
| `pnpm lint:ratchet` | 0 | `lint-ratchet.log`: 290/0 within305/0 |
| `pnpm audit:schema` | 1 | `audit-schema.log`: one migration-seeded key; parent owns the minimal audit fix |
| Offline esbuild of new process fixture, CJS/node24 | 0 | `fixture-build.log`, `session-orphan-worker.meta.json` |
| Offline esbuild of operator, ESM/node24/packages external | 0 | `operator-build.log`, `session-orphan-backend.meta.json` |

The official unit partition includes the host/contract and export tests. Original handler/domain tests and every new `.db.test.ts` remain in the DB partition. The migration additions remain in the existing migration partition. No config/partition file changed. Partition audit also reports ignored historical `.cache` archive tests; those are not executed unit evidence. No full local test command ran.

`source-manifest.json` and `source-sha256.txt` will bind the delivered commit and every owned changed file. `artifacts.json` records generated artifact bytes/hashes and installed versions. `validation.json` records exact commands, exits and log hashes. These temporary evidence files are handed to the parent alongside the source commit.

## Parent-owned source-audit fix

`audit:schema` reports only `session_orphan_control.family`. Migration0117 seeds exactly two immutable keys; runtime phase updates select by family and never insert or mutate that key. The audit scans TypeScript writers and does not count those SQL seed rows. No redundant runtime writer was added to satisfy the audit.

The parent acknowledged this false positive, captured the existing YUK-1394 follow-up in Linear, and confirmed the audit scripts/tests have no overlapping WIP. The parent owns the minimal fix and subsequent audit check. The author leaves audit scripts, tests and allowlist untouched. This remains a failing author audit result, with independent R1/runtime acceptance and main integration owned by the parent after the author releases this fixed diff.

## Parent runtime commands — NOT RUN

Acquire the parent's runtime mutex and complete the prescribed Node/Docker/database/version/target preflight first. These commands use official configs and their disposable `pgvector/pgvector:pg16` Testcontainers databases. Global setup supplies DATABASE_URL/TEST_DATABASE_URL and creates `test_fork_<poolId>` clones; do not point them at deployment data. Postgres and COMMIT fault proxies use assigned loopback ports; no fixed app/browser port or provider credentials are needed. Process fixtures reject non-loopback URLs and database names outside `/test_fork_\d+`. Serialize these groups with other DB/process/service operations.

```bash
export PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH
pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 \
  src/server/durable/session-orphan-family.db.test.ts \
  src/server/durable/session-orphan-backend.db.test.ts \
  src/server/session/conversation-orphan.db.test.ts \
  src/server/session/placement-orphan.db.test.ts \
  src/server/boss/handlers/prune_orphan_conversation_sessions.test.ts \
  src/server/boss/handlers/prune_orphan_placement_sessions.test.ts \
  src/server/boss/handlers.test.ts \
  src/server/session/conversation.test.ts \
  src/server/session/placement.test.ts \
  src/capabilities/practice/api/placement-api.db.test.ts \
  src/capabilities/observability/api/admin-config.db.test.ts

pnpm vitest run --config vitest.migration.config.ts \
  tests/integration/migration-smoke.test.ts -t YUK-1394

TLP_SESSION_EVIDENCE_PATH=/tmp/yuk1394-parent-process.json \
  pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 \
  tests/dbos-session-orphan/migration.db.test.ts

TLP_SESSION_CRON_EVIDENCE_PATH=/tmp/yuk1394-parent-cron.json \
  pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 \
  tests/dbos-session-orphan/cron.db.test.ts

pnpm vitest run --config vitest.db.config.ts --maxWorkers=1 \
  tests/dbos-prune/migration.db.test.ts tests/dbos-prune/cron.db.test.ts \
  tests/dbos-review-orphan/migration.db.test.ts tests/dbos-review-orphan/cron.db.test.ts
```

DB config defaults: test30s, hooks60s; process tests explicitly allow120–240s; cron tests allow600s each, with actual occurrence waits up to120s. Process IPC waits30s; unavailable-primary wait60s; selected old-handler tests180s; genuine predecessor recovery240s. The process fixtures build their own `.cache` bundles before spawning; author offline compilation does not replace that exact-source capture. Global DB setup migrates through0117. Migration smoke separately builds empty/populated post1393 databases, then applies0117.

Prepared acceptance cases:

- Both families: fixed microsecond cutoff boundaries, entire frozen lists, long/nested session payloads/events, duplicate executors/overlap, current-version effects, missing/terminal/wrong-type/non-old rows, corrupt-state task failure, immutable evidence, family-negative identity/receipt/phase/disposition/quiescence cases.
- Real conversation input/resume and end ordering; advisory selection lock before row lock. Placement completion/idempotency and the actual `/next` session loader under contention. The existing placement API suite remains the route regression gate; helper coverage is not route acceptance.
- Forced receipt failure rolls back domain mutation, event and transactional notification; one deferred receipt preserves known failure, later rows proceed, next independent tick can act. Explicit transaction rollback preserves original public behavior and unrelated question/answer/theta/starter data.
- Both families: SIGKILL before admission INSERT, after admission COMMIT, before receipt INSERT with domain/event writes uncommitted, after row COMMIT, after DBOS checkpoint. Replacement reads the same native identity/date/frozen list and preserves first receipts.
- Real PostgreSQL packet proxy drops admission, row or deferred receipt COMMIT acknowledgements after server commit. A separate pre-COMMIT fault terminates the actual backend to prove rollback. Unavailable primary remains unknown and terminal DBOS ERROR is retrieved without replay; explicit drain/dispositions retain original tasks and block missing receipts until real process exit/attestation.
- Genuine archived pre-lane conversation/placement handlers pause their actual SELECT promises, perform original effects without new receipts, and actually exit before quiescence. Genuine old prune/review partial workflows recover in the new four-family host both before and after native admission by both new families. Prior source/bundle hashes are checked against Git; no newly constructed domain handler is labeled old.
- Real pg-boss Timekeeper/forwarder delay across drain for over61s, actual legacy UUID/first-admission clock, real DBOS scheduler with two processes and one effect, restart/later/empty occurrences, both mixed phase directions, both-native ownership, selected-family rollback while other control/receipts remain unchanged. Minute cron exercises clocks; separate assertions bind04:25/04:35 Asia/Shanghai and UTC mapping. A minute fixture is not observation of daily production firing.

## Per-family operator sequence — NOT RUN

Run `pnpm exec tsx scripts/session-orphan-backend.ts --family <exact-family> <action>` only after parent runtime authorization and readiness. Allowed actions: `status`, `begin-dbos`, `finish-dbos`, `begin-rollback`, `finish-rollback`, `inspect <tick-id> <session-id>`, `quiesce '<observed evidence>'`, and `retire <backend> <task-id> '<reason>' [<tick-id> <session-id>]`. There is no default family or `all` mutation.

For a selected family, inspect status, begin drain, settle real task/receipt/SEND_IT obligations and observe all old consumers, held SELECT handlers, scheduler owners, suspended executors and forwarders exit. Record identities/hashes/PIDs and the exact drain barrier in quiescence reason. Only then attest and finish. If a preserved real terminal task requires retirement, dispose unresolved frozen rows first, then its task; retain backend rows and all receipts. Missing primary or uncertain task state stays unresolved.

Rollback follows begin-rollback, obligation/forwarder settlement, observed native consumer/scheduler exit, exact-barrier attestation, effective missed=skip verification and the recorded family-specific cooldown, then finish-rollback. A timer or `offWork(wait:false)` is not exit proof. Retain0117 and all four old/new ledgers, pg-boss and tlp_dbos. Observe exit of binaries lacking any new workflow before changing the shared host: unchanged `prune-v1` does not authorize mixed old/new executors.

Full-DB backup/restore, runtime TRUNCATE privileges/retention, actual package/scheduler deployment versions, selector backlog cost, old binary rollback, independent review and exact-head CI remain parent acceptance obligations. No deployment was attempted.

## Offline artifact evidence

Installed versions: Node24.19.0, pnpm11.13.1, DBOS5.2.11, pg-boss12.36.0, postgres3.4.9, Drizzle0.45.3, Vitest4.1.10, TypeScript6.0.2, esbuild0.28.2, Biome2.5.8, Testcontainers PostgreSQL12.1.0. Package/lock files were unchanged.

| Artifact | SHA256 |
| --- | --- |
| `dist/server.cjs` | `8a77c3a671c3fa268d501dc929233927c30fb20df704266546fafcf9770b037a` |
| `dist/worker.cjs` | `8b9dce925f136d8f9b243d95612da35560eb5bd9e838cdef8ca4abc8625b2a0b` |
| `dist/migrate.cjs` | `202d29b75eade7910c18de74f65ad9e7f28431c3d9ddac463a65dd1b738c4115` |
| `/tmp/yuk1394-author/session-orphan-worker.cjs` | `18a626201a36e2f4aa9cf31feb742e5051442ec2f434065c3abc49abfd15918a` |
| `/tmp/yuk1394-author/session-orphan-backend.mjs` | `2c79649790f60332e9083c0d4d814d3c554634dc34915475293dc7eb78d649f7` |
| `/tmp/yuk1394-old-review-3be966000/worker.cjs` | `b2d2df1c679b7b9b0275fbd972ef9a869f5975fde090421ac2f6efed7a615108` |
| Same archive `conversation-handler.cjs` | `474b4a903d792fd240f8c409b8cdd4e830caacba2cbfe16b04d13b0235660386` |
| Same archive `placement-handler.cjs` | `f159cf837c055297740a1166b76b1be324dbb632acd19734b170ed51d2b23018` |
| `/tmp/yuk1393-old-prune-6aaf8ca89/worker.cjs` | `606251411ff3c003e2a5c8fe8ae435b05298a547dd25f5f928d88c2afa7d1444` |

The predecessor directories were read only. Their actual source manifests and Git bases remain intact. Bundles were hashed without execution. Build success and artifact provenance do not establish process, cron, migration, cutover or restore completion.
