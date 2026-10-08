# YUK-1394 conversation and placement orphan DBOS migration

## Parent decision and implementation boundary

The parent accepted the shared four-table design below after checking the existing domain transitions, their callers and installed scheduler identity code. The two allowed families are `prune_orphan_conversation_sessions` and `prune_orphan_placement_sessions`. This is a bounded implementation for two current consumers. It does not generalize the already delivered prune or review ledgers or change their workflow identities.

Tracker: YUK-1394, parent YUK-1355. Parent decision is recorded in Linear comment `3d73a982-c168-43dc-ba11-3b61b7d0917b`. The Start owner57961995 confirmed no overlapping WIP in the proposed paths. The next migration number remains unallocated. Implementation starts from freshly fetched main after PR1621 passes its exact-head gates and merges. At this document's creation, PR1621 head3be966000 has a new CI run pending after a test-only schedule-projection correction. This document is prepared locally for the next delivery and does not assert that1393 is already merged.

The domain transaction helper extractions and composite family keys are approved. Keep the six-hour `started_at` policy; resume or recent user input does not exempt an old session. The original identity-free run functions are called only by their factories and tests at the inspected baseline. Migrate those callers to the real legacy job or explicit native scheduled identity. Do not retain an unreceipted execution path or generate a UUID to impersonate an accepted backend task. Preserve existing domain wrappers and their public error/idempotency behavior.

Each family retains independent phase, schedule, producer fence, receipts, dispositions, quiescence and rollback. Every operational query and key must carry family. No new replay, force-finish, generic recovery owner, provider call, input policy or idle behavior belongs in this lane. `promote_conversation_idle` remains separate because its five-minute user-event clock and concurrent insert need a different contract.

The detailed report below is retained as the architecture input. Its request for parent adjudication has been satisfied by this section. All implementation and runtime acceptance remains pending; design approval is not permission to bypass runtime locking or deploy an unverified candidate.

## Prepared genuine predecessor artifacts

Only offline compilation was performed. Before actual use, compare these source digests with the eventual1393 merge tree. If product source changes, archive the actual accepted predecessor again rather than relabeling these artifacts.

- Review workflow: `/tmp/yuk1394-old-review-3be966000/worker.cjs`, SHA256 `b2d2df1c679b7b9b0275fbd972ef9a869f5975fde090421ac2f6efed7a615108`. `source-manifest.json` verifies76 repository inputs from Git3be966000, plus Node24.19.0 and installed dependency package versions/hashes. It builds the real existing `tests/dbos-review-orphan/worker.ts` from archived source.
- Old conversation handler: same directory `conversation-handler.cjs`, SHA256 `474b4a903d792fd240f8c409b8cdd4e830caacba2cbfe16b04d13b0235660386`.
- Old placement handler: same directory `placement-handler.cjs`, SHA256 `f159cf837c055297740a1166b76b1be324dbb632acd19734b170ed51d2b23018`. `old-consumer-manifest.json` verifies55 source inputs for each handler; original run/build exports are preserved.
- Earlier genuine prune archive remains `/tmp/yuk1393-old-prune-6aaf8ca89/worker.cjs`, SHA256 `606251411ff3c003e2a5c8fe8ae435b05298a547dd25f5f928d88c2afa7d1444`, with its source manifest. Prior1393 acceptance does not replace future four-family recovery acceptance.

No artifact was executed during this preparation. Tests must use disposable databases, bounded processes and the deployment mutex; observe actual predecessor exit and keep unresolved outcomes. The global goal remains full non-UI migration followed by outstanding Linear features.

## Original architecture report

# Two session-orphan families: proposed durable design

Status: design for parent adjudication, not implementation authorization or runtime acceptance.

Source baseline: `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`, branch `feat/yuk-1393-review-orphan-dbos`, HEAD `53f05b572e33440886b1a7e6ab1f084308ceef77`. The initial HEAD and clean tracked working tree were read locally. At final verification another actor had advanced HEAD to `2e6dbb7f3b23599716aaa16b9061a87f4a1f07c8`; the read-only diff from the fixed baseline contains only PLAN/now and YUK-1359 documentation/evidence. None of the cited implementation or test sources changed, so this report remains anchored to the requested fixed HEAD. PR1621 pending CI/merge is supplied task context, not independently queried. This report is for the lane after YUK-1393 merges, not another review of PR1621. Source citations below are repository-relative, one-based lines at this HEAD unless explicitly marked installed package or handoff. Proposed identifiers are not existing exports.

Only this `/tmp` report was written. No delegation, tracked write, git mutation, test, DB, Docker, provider, PR/Linear, or service operation was performed. Parent must adjudicate this design and coordinate shared ownership with 5796 before author implementation. Migration numbering must be allocated against fresh main later; this report reserves no number.

## Decision

Recommend LIGHT: one bounded `session-orphan` implementation and four shared ledger tables keyed by the exact family names `prune_orphan_conversation_sessions` and `prune_orphan_placement_sessions`. Use a closed discriminated union and exhaustive domain dispatch. Both families are real consumers in this lane. Each keeps its own phase row, schedule, admission identity, receipts, obligations, producer fence decision, quiescence proof and rollback horizon.

The four tables represent different lifecycles: mutable backend ownership, immutable tick admission, immutable per-candidate outcomes, and append-only operator dispositions. Combining those lifecycles into one nullable catch-all table would make commit and drain checks harder to inspect. Creating four tables for each new family would duplicate the same six-hour admission, unknown-outcome, and cutover protocol eight times at the schema level. Share these four tables only between the two new consumers.

FULL alternative: independent conversation and placement ledgers and modules. It provides easier future schema divergence and narrower per-table maintenance, but duplicates migrations, obligation queries, trigger installation, immutable-evidence rules, recovery tests, and operator parsing. It does not avoid the shared DBOS host or old-process quiescence requirement. Both choices can roll back one family's backend independently while retaining schema. No current behavioral difference justifies eight tables. Reconsider separate tables if a later approved family needs incompatible retention, privileges, eligibility snapshots, or recovery semantics.

Do not create a general housekeeping engine, plugin registry, injectable selector/mutator callback API, dynamic table names, or third recovery owner. Keep YUK-1393 review tables/module/operator and existing prune identities untouched. Extending their host's fixed admission list is necessary integration; migrating their evidence into the new ledger is excluded.

## Behavioral contract and source basis

- Conversation selects `type='conversation'`, `status IN ('active','idle')`, strictly `started_at < cutoff`. Current selection and broad catch-as-skip are in `src/server/boss/handlers/prune_orphan_conversation_sessions.ts:20-49`. The domain transition owns session update, version increment and `conversation.abandoned` job event with `{from_status, reason:'orphan_cron'}` in `src/server/session/conversation.ts:502-541`.
- Conversation takes `lockCopilotSessionSelection` before the session row lock, using the existing `copilot:session-selection` advisory key. Preserve that ordering and key exactly. See `src/server/session/conversation.ts:38-48,116-123,507-509`.
- Resume changes status, `updated_at` and version, not `started_at`, in `src/server/session/conversation.ts:323-358,554-597`. Neither a recent user event, active status, a version increase, nor resume exempts a six-hour-old session. The handoff's sentence “A user turn/resume race must not let an old candidate terminate a now-live conversation” at `/tmp/yuk1355-session-housekeeping-next-20261009.md:17` must not be implemented as an activity exemption. A terminal transition wins if committed first; resume to active remains eligible. The separate five-minute idle rule is excluded.
- Placement selects `type='placement'`, `status='started'`, strictly `started_at < cutoff`, in `src/server/boss/handlers/prune_orphan_placement_sessions.ts:23-47`. It is one-shot with no reopen (`src/server/session/placement.ts:15-28,51-64`). Its writer currently owns `Db.transaction`, locks the row, updates status/timestamps/version, and writes `placement.abandoned` with `{}`; it writes no domain `event` (`:204-264`; explicit test at `src/server/session/placement.test.ts:207-212`). Preserve completion and idempotent administrative transition behavior at `:187-188,224-237,268-273`.
- Placement `/next` already serializes through its session row and requires `started` (`src/capabilities/practice/api/placement-next.ts:64-80`). Serving a question first does not extend orphan age. Existing question, answer, theta, starter claim and provider effects remain independent and untouched.
- `writeJobEvent` writes its row and transaction-scoped notification through the supplied handle (`src/server/events/writer.ts:13-44`). The receipt must share that transaction. No extra `event` write, cancellation, paid call, or starter recovery belongs in this sweep.
- Existing cron declarations are daily 04:25 and 04:35 Asia/Shanghai, fast queue (`src/server/boss/handlers.ts:44-65`). Both are still separately mounted in the infra registrar (`:107-142,190-192`). Preserve offsets and timezone in the manifest.

## Concrete file ownership proposed to parent

New implementation files:

- `src/server/durable/session-orphan-family.ts`: two-family boundary schemas, immutable admission/row runner, ledger reads, outcome inspection and errors. No DBOS launch or pg-boss polling loop.
- `src/server/durable/session-orphan-backend.ts`: the two-family phase transitions, obligations, dispositions, quiescence, producer-fence installation and rollback horizon. Split from the family runner so operator concerns do not expand its transaction loop. No general backend framework.
- `src/server/durable/session-orphan-worker.ts`: register the two workflows before launch; create family-bound schedule/legacy-consumer adapters for the shared host.
- `scripts/session-orphan-backend.ts`: one client-only CLI requiring an explicit exact `--family`; existing operator actions, no default family and no `all` mutation.
- `drizzle/<fresh-number>_session_orphan_backend.sql`: four shared tables, constraints, immutability triggers and one exact-two-family producer trigger function. The placeholder is intentional, not a reserved migration path.
- `docs/planning/2026-10-09-yuk1355-two-orphans-durable.md`: adjudicated design, family-specific rollout/rollback runbook and evidence index after parent approval.

Existing implementation edits:

- `src/server/session/conversation.ts` and `src/server/session/placement.ts`: precise transaction helpers only, as specified below. No route or general lifecycle redesign.
- `src/server/boss/handlers/prune_orphan_conversation_sessions.ts` and `src/server/boss/handlers/prune_orphan_placement_sessions.ts`: retain named entrypoints where useful, replace old independently implemented sweeps with identity-required delegation to the bounded runner; factories pass each actual `job.id`.
- `src/server/durable/prune-worker.ts`: fixed four-family admission, pre-launch registrations, adapter reconciliation and stop aggregation only. Existing prune workflow body/config identities stay unchanged.
- `src/server/boss/register-capability-jobs.ts`: validate the exact complete four-family production declaration set before side effects.
- `src/server/boss/handlers.ts`: remove only these two imports, consumer blocks and infra schedule entries. Keep `promote_conversation_idle` and other jobs unchanged.
- `src/capabilities/observability/manifest.ts`: add the two declarations with `backend:'dbos'`, `queue:'fast'`, existing cron/tz, no `load` or singleton metadata. This declares host ownership; migration seeds runtime phases to `pg-boss`.
- `src/db/schema.ts`, `drizzle/meta/_journal.json`, `src/server/export/constants.ts`: schema exports, new journal entry and learner-archive exclusion with full-DB recovery explanation.

Tests proposed within the authorized tests scope:

- New `src/server/durable/session-orphan-family.db.test.ts`, `src/server/durable/session-orphan-backend.db.test.ts`.
- New `src/server/session/conversation-orphan.db.test.ts`, `src/server/session/placement-orphan.db.test.ts`.
- New `tests/dbos-session-orphan/worker.ts`, `tests/dbos-session-orphan/migration.db.test.ts`, `tests/dbos-session-orphan/cron.db.test.ts`.
- Extend `src/server/durable/prune-worker.unit.test.ts` for new runner identity/summary boundary tests and four-family host wiring. This is already included in the unit partition at `vitest.shared.ts:233`; no new config edit is required solely to discover another server unit file.
- Update the two original handler tests, `src/server/boss/handlers.test.ts`, `src/server/export/constants.test.ts`, and scoped cases in `tests/integration/migration-smoke.test.ts`. Registrar admission unit cases already live in `src/server/durable/prune-worker.unit.test.ts:188-230`; preserve that test location. Existing domain tests remain regression gates.

Read-only boundaries remain `start-worker`, shutdown owner outside `prune-worker.ts`, `prune-family.ts`, `scripts/prune-backend.ts`, review family/worker/operator/schema migration, Start, config, subject boot, kernel, Copilot dispatch, providers, and placement starter recovery. Existing `src/server/session/index.ts` need not change: durable code can directly import the new named helpers. Parent owns board/Linear capture and any additional documentation integration; this adviser did not operate those systems.

## Types and function signatures

Define Zod schemas at the new family boundary and derive the runtime types. The following are intended shapes, not a second type source to hand-copy beside schemas. Use strict objects, finite dates, UUID validation for actual pg-boss IDs, and validated PG timestamp strings that preserve microseconds.

```ts
type SessionOrphanFamily =
  | 'prune_orphan_conversation_sessions'
  | 'prune_orphan_placement_sessions';
type SessionOrphanSource =
  | { kind: 'dbos'; workflowId: string; scheduledAt: Date }
  | { kind: 'pg-boss'; jobId: string };
type SessionOrphanRequest =
  | { family: 'prune_orphan_conversation_sessions'; source: SessionOrphanSource }
  | { family: 'prune_orphan_placement_sessions'; source: SessionOrphanSource };
type SessionOrphanKey = { family: SessionOrphanFamily; tickId: string };
type FrozenCandidate = {
  sessionId: string;
  selectedStartedAt: string;
  selectedVersion: number;
};
type SessionOrphanOutcome =
  | { kind: 'abandoned'; fromVersion: number; toVersion: number }
  | { kind: 'skipped'; reason: 'missing' | 'terminal' | 'not-old' }
  | { kind: 'deferred-known-failure'; error: string };
type SessionOrphanInspection =
  | { kind: 'committed'; outcome: SessionOrphanOutcome }
  | { kind: 'not-committed' }
  | { kind: 'unknown'; error: string };
```

`missing` includes absent ID or wrong session type; terminal skips must be recognized domain terminal states, while corrupt/unrecognized states should fail rather than masquerade as a terminal session. The selected version and timestamp are audit evidence. Neither is a version CAS or review-style reopen test. Revalidate the current timestamp against the saved cutoff under lock. Both domains have no reopen transition; do not add `reopened` to this contract. Session IDs are not reusable identities.

Proposed exports:

```ts
runSessionOrphanTick(db: Db, request: SessionOrphanRequest,
  boundary?: SessionOrphanBoundaryHook): Promise<SessionOrphanSummary>;
inspectSessionOrphanOutcome(db: Db,
  input: SessionOrphanKey & { sessionId: string }): Promise<SessionOrphanInspection>;
inspectSessionOrphanAdmission(db: Db, request: SessionOrphanRequest):
  Promise<AdmissionInspection>;
readSessionOrphanPhase(db: Pick<Db, 'execute'>,
  family: SessionOrphanFamily): Promise<SessionOrphanPhase>;
sessionOrphanObligations(db: Pick<Db, 'execute'>,
  input: { family: SessionOrphanFamily; backend: 'pg-boss' | 'dbos' }):
  Promise<SessionOrphanObligation[]>;
changeSessionOrphanPhase(db: Db, boss: Pick<PgBoss, 'unschedule'>,
  input: { family: SessionOrphanFamily; target: SessionOrphanPhase },
  schedules: Pick<typeof DBOS, 'getSchedule' | 'pauseSchedule'>): Promise<void>;
attestSessionOrphanQuiescence(db: Db,
  input: { family: SessionOrphanFamily; reason: string }): Promise<void>;
retireFailedSessionOrphan(db: Db, input: SessionOrphanDispositionInput): Promise<void>;
installSessionOrphanProducerFence(db: Db): Promise<void>;
```

`AdmissionInspection` distinguishes committed frozen header, lock-proven noncommit, and unknown. `SessionOrphanSummary` follows complete/deferred/fenced variants, includes `family` and `tickId`, and never counts unknown as skipped. Boundary events are `selection-committed`, `row-committed` with session ID, and `checkpoint-saved`; every event includes the family. Business code must not swallow boundary-hook exceptions as row failures. Hooks exist for deterministic acceptance, not a second execution API.

Keep the old named runner entrypoints only as thin identity-required adapters:

```ts
runPruneOrphanConversationSessions(db: Db, input: { jobId: string }):
  Promise<SessionOrphanSummary>;
runPruneOrphanPlacementSessions(db: Db, input: { jobId: string }):
  Promise<SessionOrphanSummary>;
```

Their factories validate each job name and pass its UUID; tests migrate to explicit seeded legacy jobs or native runner requests. The fixed source has no other production caller of the old no-argument runners beyond their factories. Do not keep two no-identity scan implementations just for tests, and do not add random-ID defaults.

The concrete switch in `session-orphan-family.ts` owns selection and calls either Conversation's or Placement's helper. No caller supplies arbitrary predicates, tables, status lists, or transition functions. `SessionOrphanDispositionInput` is a discriminated union of terminal-task and terminal-row targets; quiescence has its own function. Every request carries a validated family. SQL values are parameters and all operational queries include that family.

## Domain Tx extraction without duplicate writers

Conversation:

```ts
export async function abandonOrphanConversationTx(
  tx: Tx, input: { sessionId: string; cutoff: string },
): Promise<OrphanConversationResult>;

// private, owns selection lock, row load and the one existing mutation body
async function abandonConversationTx(
  tx: Tx, input: { sessionId: string; reason: AbandonReason },
): Promise<{ fromVersion: number; toVersion: number }>;
```

Extract `abandonConversation`'s existing body into the private Tx helper. Public `abandonConversation(db,id,reason):Promise<void>` remains a `db.transaction` wrapper with identical missing/invalid-state errors. The orphan helper acquires the existing selection lock, loads the conversation row `FOR UPDATE`, and checks recognized status plus SQL `started_at < cutoff::timestamptz`. Extend the private loader's result with version if needed and read eligibility through the same transaction. It then calls the private Tx helper inside that same transaction. Reacquiring the same advisory/row locks in the same transaction is allowed and preserves one mutation body; do not acquire a session row before the selection lock. No nested `Db.transaction` or domain import of the durable ledger is needed. Derive `OrphanConversationResult` from its domain result shapes; durable outcome adds only the known-failure variant.

Placement:

```ts
async function applyPlacementSessionTransitionTx(
  tx: Tx, input: {
    sessionId: string;
    target: Exclude<PlacementSessionStatus, 'started'>;
    idempotent: boolean;
  },
): Promise<PlacementSessionTransition>;

export async function abandonOrphanPlacementTx(
  tx: Tx, input: { sessionId: string; cutoff: string },
): Promise<OrphanPlacementResult>;
```

Move the existing callback body of `applyPlacementSessionTransition` to the private Tx helper. Keep the existing Db wrapper and all public signatures/exception/idempotency behavior unchanged. The orphan helper locks the typed session row using the existing loader, reads version and strict SQL cutoff eligibility while holding that row, then calls the private helper with `target:'abandoned', idempotent:false`. The repeated row lock is in the same transaction. It returns versions for evidence. Do not widen a Db argument and hope a nested transaction joins the caller; `Tx` is explicit (`src/db/client.ts:47-53`). No ledger writes inside either domain module.

## Four-table ledger and identity contract

Proposed table names are `session_orphan_control`, `session_orphan_tick`, `session_orphan_receipt`, `session_orphan_disposition`. Every table has `family text NOT NULL CHECK (family IN (<the two exact names>))`. The migration seeds exactly two control rows to `pg-boss`; missing/invalid control is a hard failure, never a default phase.

1. `session_orphan_control`: primary key `family`; `phase` constrained to `pg-boss | draining-pg-boss | dbos | draining-dbos`; `phase_changed_at timestamptz NOT NULL`; nullable `legacy_not_before timestamptz`. Each transition locks and updates one family row only. Use the exact PostgreSQL timestamp text for the drain barrier, not a JavaScript Date round trip.
2. `session_orphan_tick`: primary key `(family,tick_id)`; FK `family` to control; `backend`, `provenance`, `tick_at`, `cutoff`, `admission`, `candidates jsonb`, `contract_version=1`, `recorded_at`. Check cutoff equals tick time minus six hours; native backend iff scheduled provenance; candidates is an array; fenced admission has `[]`. Validate candidate objects, uniqueness/order, timestamps and versions before writing and after reading. Header fields and candidates are immutable after commit.
3. `session_orphan_receipt`: primary key `(family,tick_id,session_id)`; composite FK `(family,tick_id)` to tick; `outcome jsonb NOT NULL`, `recorded_at`. Constrain outcome kind; fully parse its shape on reads. Receipt insertion must verify membership in that exact frozen header while holding its lock. Do not FK session ID to `learning_session`: a missing row can have a receipt, and evidence must survive session deletion. Never join on `tick_id` alone.
4. `session_orphan_disposition`: primary key `(family,id)`; family FK; `backend`, `kind`, `observed_state`, nonempty `reason`, `recorded_at`; target columns `task_id`, `tick_id`, `session_id`, `barrier_at`. SQL CHECK branches define a concrete union: `terminal-task` requires only `task_id`; `terminal-row` requires `task_id,tick_id,session_id`; `quiescence` requires only `barrier_at`. Add composite FK `(family,tick_id)` to tick where present. Task IDs are actual backend task IDs; row targets retain their tick ID separately. A quiescence record must match family, draining backend, exact current `phase_changed_at` and observed draining phase. This avoids overloading a raw job UUID, `legacy:` tick ID, or barrier string as the same identifier.

No unique constraint across families on tick/task/session ID. No process-local cache is authoritative. Add append-only UPDATE/DELETE rejection triggers to the three evidence tables, following the intent of `drizzle/0116_yuk1393_review_orphan_backend.sql:42-52` without calling or modifying its functions. Runtime credentials must not TRUNCATE these tables; tests may reset only disposable databases. Do not add evidence pruning in this lane.

Native workflow name and schedule name equal the exact family. Step names are separately fixed as `conversation-orphan-sweep-v1` and `placement-orphan-sweep-v1`. Accept a native request only when `workflowId === 'sched-' + family + '-' + scheduledAt.toISOString()`. This follows installed DBOS 5.2.11's scheduler (`node_modules/@dbos-inc/dbos-sdk/dist/src/scheduler/scheduler.js:190-202`; version in its `package.json:3`). Manual `trigger-*`, arbitrary test IDs, or another family's ID must not be relabeled as scheduled provenance. Process tests can enqueue controlled native-shaped IDs with frozen timestamps, but only actual scheduler tests establish cron acceptance.

Use the native workflow ID itself as `tick_id`. Legacy uses `legacy:<actual-job-UUID>` and `legacy-first-admission`; first committed admission samples the authoritative database clock once. Never infer a scheduled time from pg-boss delivery time, use the job creation time as if it were scheduled provenance, or manufacture a UUID in a no-argument sweep. Storage-isolation fixtures may reuse the same raw legacy UUID under two family keys to prove that neither receipt satisfies the other. Real new admission must also corroborate the UUID against `pgboss.job` and require its actual name to equal the bound family; one real task UUID cannot authorize two families. Validate each delivered job name as well. Missing or differently named backend tasks are identity failures. For an already saved tick, its validated immutable identity remains readable even after backend retention removes the task row.

## Admission, row commits and unknown COMMIT

Keep contract-epoch gating through existing mechanisms. Preserve the current distinction between native epoch waiting and legacy housekeeping drain disposition (`src/server/durable/review-orphan-family.ts:256-261`); do not edit global epoch machinery.

Use a single new, namespaced tick advisory-lock expression everywhere admission, execution, inspection or retirement can touch a tick, for example `pg_advisory_xact_lock(hashtextextended('session-orphan:v1:' || family || ':' || tick_id, 0))`. The full exact family is part of the input. Never use review's bare-ID/1393 lock or prune's lock. A hash collision can serialize unrelated work but must not influence any identity/evidence decision; composite keys and validation remain authoritative.

Admission order:

1. Transaction on the writable primary, using READ COMMITTED so a read after waiting sees the original commit.
2. Selected family's control row `FOR SHARE`.
3. Exact family/tick advisory lock.
4. Existing tick row `FOR UPDATE`, if present. Validate source identity, backend, version and scheduled time; reuse it even after a phase change. A previously fenced tick stays fenced.
5. Reject a terminal-task disposition before creating a new header. A disposed task cannot become a new admission through redelivery. For a new ID, admit native only in `dbos`; legacy only in `pg-boss` after `legacy_not_before`. In either draining phase, persist fenced empty admission for every previously unadmitted request, including accepted-but-not-yet-admitted legacy deliveries.
6. Compute cutoff once and select the complete eligible list ordered by ID in one statement. Store `{sessionId,selectedStartedAt,selectedVersion}` with the header in this transaction. Candidate selection is a snapshot, not a set of locks held across the whole sweep. Do not truncate the list silently or refetch after partial progress.

Each candidate has its own transaction:

1. Family control `FOR SHARE`, then the same tick advisory lock, then saved tick `FOR UPDATE`.
2. Verify exact header identity and frozen membership. Read `(family,tick_id,session_id)` receipt first. A saved receipt wins over current domain state and a later phase; it is returned unchanged.
3. Without a receipt, require admitted header and matching active-or-draining backend. A terminal-task or terminal-row disposition blocks a new effect; it is not a success receipt. Normal execution must never continue a dispositioned gap.
4. Conversation takes the original selection advisory lock, then its session row. Placement takes only its session row. Neither path holds another family's control/tick lock or locks two candidate rows at once.
5. Domain helper rechecks type, allowed status and strict current `started_at < saved.cutoff`. It applies the existing transition or produces a recognized skip. Insert outcome receipt in the same transaction. Failure anywhere rolls back the session, job event, notification and receipt together.
6. Commit, then emit the test boundary. No all-candidate transaction and no `SKIP LOCKED` omission.

Overlap between different ticks serializes only when they reach the same domain row or Conversation's existing selection lock. One tick abandons; another records terminal skip. A version increase from active input remains eligible, and abandoned versions reflect the locked current version, not the selected version.

Identity conflicts, malformed saved evidence, unauthorized phases and disposed targets are contract failures, not ordinary deferred row outcomes. Fail them explicitly. After any uncertain transaction return, do not count a skip or issue a second mutation blindly. Reconnect to the authoritative writable primary and acquire the same control/tick locks in a fresh READ COMMITTED transaction. For a row, lock the saved header and read its exact receipt. Waiting on the tick lock proves the original transaction has ended; only then can receipt absence establish noncommit. A replica, stale snapshot, timeout, unreachable DB, cancelled lock wait, or failed identity validation does not prove absence.

- Receipt present: return exactly the saved outcome; do not re-execute the domain transition.
- Lock-proven receipt absent after an attempted row: persist `deferred-known-failure` in a new transaction under the same locks, rechecking prior receipt and disposition. This preserves the existing daily backstop without an in-tick retry. A future independently scheduled tick may select the still-old session. A race that creates a receipt meanwhile wins.
- Unknown inspection: throw `SessionOrphanUnknownOutcome` carrying family/tick/session and retain the failed task and missing-receipt obligation. No receipt says unknown equals success. Operator inspection does not retry.
- Admission commit unknown: reconcile header under the admission lock. A saved header wins. Only lock-proven absence permits creating the first admission with the current phase rules. No business effect has run before a header commit. Continued uncertainty remains explicit.
- Deferred-receipt COMMIT unknown: inspect again; only a saved receipt settles it. Otherwise remain unresolved. Avoid unbounded retry loops.

This tightens the new implementation's lock symmetry without changing YUK-1393. Its saved-receipt and primary-inspection concepts are local precedents (`src/server/durable/review-orphan-family.ts:205-253,295-330`), not proof that new code works.

## Shared host and operator behavior

The shared host already registers workflows before `DBOS.launch` and owns one shutdown (`src/server/durable/prune-worker.ts:179-221`). Preserve `name:'tlp-housekeeping'`, `systemDatabaseSchemaName:'tlp_dbos'`, executor/config behavior and `applicationVersion:'prune-v1'` (`:191-200`). Preserve the original `prune_job_events` workflow, `prune-business-commit` step and recovery semantics (`:24-45`). Preserve review's workflow and `review-orphan-sweep-v1` step (`src/server/durable/review-orphan-worker.ts:15-36`). New families add functions; they do not rename old ones or adopt old receipts.

Extend production declarations to `{pruneEvents,reviewOrphans,conversationOrphans,placementOrphans}`. Validate the exact set, duplicate names, fast tier, schedules/timezone, and absence of load/singleton metadata before mounting anything. Keep the prune-only compatibility entry unchanged. The host's declaration key must include both new declarations in a deterministic order; repeated identical startup reuses its promise, mutation after launch fails. Current two-family validation and host-key behavior are in `src/server/boss/register-capability-jobs.ts:117-146` and `src/server/durable/prune-worker.ts:77-107,127-165`.

`registerSessionOrphanWorkflows(db,boundary?)` returns two named handles. Each workflow binds its own family, validates DBOS workflow ID and scheduled argument, and performs one named `DBOS.runStep` with `retriesAllowed:false`. Process recovery re-enters the same frozen ledger when that step was not checkpointed. Do not add a timer that scans incomplete ticks, an operator replay command, or a second recovery worker.

`createSessionOrphanBackend({boss,db,binding})` accepts a closed union of conversation declaration/workflow or placement declaration/workflow. It returns `reconcile()` and `stop()`, using one family control row. The existing host invokes all four reconcilers and collects errors so a failure in one does not starve the rest (`src/server/durable/prune-worker.ts:263-278`). Stop attempts every new adapter and the existing review adapter even if one throws, then executes exactly one `DBOS.shutdown`. No backend calls launch/shutdown itself.

Schedule reconciliation under that family's `FOR SHARE` control lock follows the existing pattern (`src/server/durable/review-orphan-worker.ts:58-104`): native schedule active only in `dbos`, with `automaticBackfill:false`; legacy consumer mounted in `pg-boss` and `draining-pg-boss`; legacy schedule exists only in `pg-boss` after the horizon. Both schedules inactive in draining phases. Already admitted ticks finish through their owning engine. Native scheduled requests racing a pause are business-fenced by admission. Never restore a stale schedule from an unlocked phase read.

CLI syntax is `scripts/session-orphan-backend.ts --family <exact-name> <action> ...`, with actions `status`, `begin-dbos`, `finish-dbos`, `begin-rollback`, `finish-rollback`, `quiesce`, `inspect`, `retire`. Reuse the client-only PgBoss and DBOSClient mechanisms in `scripts/review-orphan-backend.ts:6-36,57-83`: PgBoss scheduling/supervision/migration disabled, existing DBOS schema/application, clean connection disposal. No SDK launch, direct workflow replay, retry, cancellation, queue purge or default phase change. Status includes phase, drain barrier, task/receipt/forwarder obligations and rollback horizon for the selected family. Mutating commands accept one family only.

## Cutover, obligations and rollback

Use each family's sequence `pg-boss -> draining-pg-boss -> dbos -> draining-dbos -> pg-boss`. Lock only that control row `FOR UPDATE`; reject skipped/reverse phase jumps. Same target is idempotent. Pause/unschedule the exact family using existing clients. Scheduler calls and the application DB transaction are not atomic: persist ownership only after successful calls; on any partial failure the still-authoritative phase and producer/admission gates prevent an effect from the wrong backend, and reconciliation restores the intended schedules.

Install one new trigger, with its own name, on both `pgboss.job` and `pgboss.schedule`, `BEFORE INSERT OR UPDATE OF name`, after pg-boss owns those tables. Serialize installation under a distinct new installation advisory namespace. Trigger returns unchanged for every name except the two exact queues, then selects only `session_orphan_control WHERE family=NEW.name FOR SHARE`. Missing control fails closed; only ready `pg-boss` permits new producers. Do not interfere with state updates of accepted jobs or replace the prune/review triggers. This follows the existing installation boundary (`src/server/durable/review-orphan-family.ts:333-345`; `drizzle/0116_yuk1393_review_orphan_backend.sql:54-67`).

Each phase finish requires all of the following for that family:

- Accepted pg-boss tasks in created/retry/active and historical failed/cancelled/unexpected-DLQ states accounted for; DBOS workflow states inspected by exact workflow name. Terminal failures remain stored. An explicit disposition is a decision about an observed failed task, not conversion to success.
- Every admitted candidate has a receipt or a terminal-row disposition against its stopped failed owner. A successful backend status alone cannot settle missing receipts. Native SUCCESS with no admission header is an obligation. Normalize pg-boss raw task UUID and `legacy:` tick only at the boundary; do not compare unlike IDs.
- Targeted `__pgboss__send-it` jobs are settled. Malformed or unknown-target payloads block both new families conservatively; a valid other-family payload belongs only to that other family. This uncertainty is a shared environmental blocker, not permission for one family to retire another's forwarder. Keep unexpected DLQ rows held for investigation. Local precedent: `src/server/durable/review-orphan-family.ts:356-384,425-475`.
- Quiescence evidence names the old process/bundle identities, confirms selected-row handlers have exited, and settles stopped/suspended/in-flight scheduler forwarders. Bind it to this family's exact draining barrier. One family's attestation cannot authorize the other; another phase cycle requires new evidence.
- On rollback, legacy forwarding obligations are checked even when all native tasks succeeded, and the family-specific cooldown has expired.

Retirement first locks the selected control row `FOR UPDATE`, then re-reads a real terminal task under lock, confirms its exact queue/workflow name and backend, then takes the family's tick lock and reads receipts. Active, unknown, missing tasks, malformed forwarders and unexpected DLQ tasks cannot be retired through this command. Use an ordered operator contract: retire unresolved rows first; terminal-task retirement refuses while undispositioned receipt gaps remain. Row retirement inspects the preserved backend task directly rather than relying only on an obligation list that may filter prior dispositions. Do not make later row retirement impossible merely because obligation filtering hides a task. Require observed owner quiescence before terminal disposition when a stopped transport status alone does not prove a suspended executor exited. The runner refuses to execute a disposed gap if an old task is somehow invoked again.

A `draining-pg-boss` consumer may complete an already admitted list. An accepted legacy job with no saved admission is consumed as an immutable fenced tick with zero effects. It must not acquire a fresh cutoff and begin work during draining. The same rule applies to a late native request. Empty admitted native ticks still occupy their time and affect rollback horizon.

Compute rollback's minimum `not_before` from the maximum of the drain barrier, this family's persisted native tick times, and this family's validated native scheduled IDs in DBOS workflow status, plus the verified scheduler lookback. Current local pg-boss 12.36.0 has a 60-second occurrence window (`node_modules/pg-boss/dist/timekeeper.js:46,623-652`). Its `missed` policy can also admit older catch-up occurrences; absent policy defaults to skip (`:138-149,591-600`). Therefore 60 seconds is a minimum only when actual schedule options preserve skip. Inspect the effective options at acceptance; do not infer them from version alone. Retain `legacy_not_before` in admission and producer checks.

Cooldown is never proof of producer exit. A forwarder suspended longer than 60 seconds or an old handler holding a selected list can still act. Such old handlers have no new business fence and must exit before finish, as the analogous real-old-handler acceptance demonstrates (`tests/dbos-review-orphan/migration.db.test.ts:546-621`). The trigger blocks late sends; it cannot block an already-selected direct domain write. No lockless absence of a queue row, receipt, or PID observation alone substitutes for the complete obligation/quiescence evidence.

Backend rollback means selecting pg-boss under the new compatible binary, independently for one family. Keep the new tables and receipts. A binary downgrade to a pre-lane worker does not understand the new workflow names despite sharing `prune-v1`. Before downgrade, both new families must be drained, native schedules paused, all new-family DBOS recovery obligations settled/dispositioned and relevant new processes gone. Retain schema; no down-migration or evidence deletion. Do not run an old and new `prune-v1` worker together once the new workflows can be enqueued. Otherwise the old worker may claim a workflow it cannot register.

## Compatibility and recovery proof required

No source design is runtime PASS. The following are separate future evidence layers, all currently NOT RUN for this design.

- Preserve old prune-v1 inputs, step name/order, workflow name, app version, system schema and receipt semantics. Recover a genuine archived pre-1393 bundle's pending prune in the new four-family host before and after admitting the new families. Existing test shape is `tests/dbos-review-orphan/migration.db.test.ts:624-658`; do not substitute a recreated “old” implementation.
- Recover a genuine YUK-1393 review workflow and partial row ledger in the new host without modifying its identities. Also prove prune-only fixture startup, one launch/shutdown, duplicate startup behavior, and that a family reconcile failure does not prevent others reconciling. Review continues using its original schema, locks, steps and operator.
- New schema must apply to both empty and populated post-1393 databases, seed only the two phases, preserve learner/session data, and leave old prune/review ledger bytes unchanged. Prove cross-family FK/check/receipt identity and evidence immutability. Verify migration journal ordering against fresh main; no assumed next number.
- Add all four tables to `BACKUP_EXCLUDED_TABLES`, following `src/server/export/constants.ts:338-348`. They are excluded from learner wipe/restore archives, not disposable. Full PostgreSQL recovery must restore domain state, all old/new ledgers, pg-boss and `tlp_dbos` as one consistent backup with writers stopped. Selective receipt import, schema compatibility, or a migration smoke is not full restore proof.
- Default after source deployment remains pg-boss for each new family. Source merge and default compatibility do not establish DBOS cutover. Preserve installed version, runtime Node, worker artifact hash and tested source SHA in acceptance records; package source observed here is not evidence about a running service.

## Scoped acceptance matrix for the parent

Execute later in disposable, coordinated environments under the parent's runtime ownership. No full local `pnpm test`. Each case is required for both families unless explicitly domain-specific.

Unit/contract evidence, primarily existing `prune-worker.unit.test.ts` and registrar unit tests:

- Exactly four production declarations; unknown, duplicate, incomplete, wrong-tier, missing cron/tz, load and singleton declarations rejected before mounting. Prune-only compatibility remains exact.
- All workflows register before a single launch; one shutdown after all adapter stop attempts; startup failure unwinds; repeated same declaration set reuses host, changed set rejects. Reconciliation failure isolation holds.
- Family/source/ID parser rejects cross-family native IDs, wrong scheduled timestamp, invalid legacy UUID, mismatched legacy job name, unsupported contract version and malformed outcomes. Fenced and deferred summaries are distinguishable.
- Operator parsing requires family and exact action; inspection/retirement cannot dispatch or recover tasks. Production steps disable retries and no old step string changes.

Scoped DB/domain evidence in new family/backend/domain tests and the two original handler tests:

- Exact cutoff and one microsecond either side; old conversation active and idle; placement started; fresh/terminal/wrong-type/missing rows; empty tick. Long payload-bearing sessions and realistic nested existing events remain intact.
- Conversation resume and new user input between selection and row execution still permit abandonment when `started_at` is old. Assert current version +1 and original event payload. Race explicit end first and abandon first. Demonstrate selection-advisory-before-row order with a held real lock, not a mocked call-order assertion alone.
- Placement completion and `/next` races preserve the one-shot contract. Assert exactly one transition job event, no new domain event, unchanged question/answer/theta/starter/provider records.
- Frozen sorted candidates survive delayed execution and partial replay; later inserts/backdating do not join an admitted tick. Duplicate executors and overlapping ticks produce one business transition; storage fixtures with the same raw legacy ID across the two families cannot share receipt, phase, disposition or lock decision; real task reuse under the wrong family fails backend ownership validation.
- Force receipt insertion failure after domain writes; session, job event and notification all roll back. Known failure gets a deferred receipt, subsequent rows proceed, and the next independent tick can abandon the failed row. No same-tick effect retry.
- Receipt wins after later domain/phase changes. Wrong family receipt or quiescence never settles a gap. One family's draining state does not block the other's business admission; malformed shared forwarders block finish conservatively.
- Unadmitted legacy/native requests in drain get fenced empty headers; admitted lists finish. New pg-boss job/schedule insertions are rejected by family trigger while accepted job state updates work. Missing control and unknown state fail closed.
- Finish refuses live tasks, receipt gaps, failed tasks without disposition, malformed SEND_IT, unexpected DLQ, stale-barrier attestation and early rollback. Exercise row-before-task retirement and attempted execution after disposition.

Process/SIGKILL/unknown evidence in `tests/dbos-session-orphan/migration.db.test.ts`:

- Distinct worker processes killed after admission commit, after first row commit, and after DBOS checkpoint. Replacement consumes the same native ID/date/list and does not duplicate version/event effects. Cover both families and a process with all four workflows registered.
- Real connection fault drops admission or row COMMIT acknowledgement after the server commits; inspection waits on the correct primary lock and returns the saved header/receipt. A separate case blocks before COMMIT then SIGKILLs the backend/worker and proves rollback before absence is accepted.
- Primary unavailable or unresolved lock yields unknown and blocks finish, never skipped/success. After restoring connectivity, inspection reads evidence without replay. Repeat fault during deferred receipt commit.
- Genuine old prune and YUK-1393 recovery remain compatible. Record archived source SHA, bundle SHA, process exits, workflow/step rows, pre/post receipts and business effect counts.

Actual cron evidence in `tests/dbos-session-orphan/cron.db.test.ts`:

- Observe real pg-boss Timekeeper and `__pgboss__send-it` forwarding, real legacy job UUID and first-admission provenance. Hold a targeted forwarder across drain for longer than the minimum horizon; show late send is fenced and finish remains blocked until settlement plus attestation.
- Observe real DBOS scheduling with two current compatible worker processes, same native scheduled ID, one header and per-row effects; stop one and observe a later tick on the other. Validate scheduled date/cutoff and empty ticks. A short test-only cron may exercise clocks, but production 04:25/04:35 Asia/Shanghai declarations need separate parser/due-time assertions; do not claim a daily production firing was observed from a minute fixture.
- Exercise conversation native while placement remains legacy, the reverse, both native, and rollback of just one family. Assert the other family's schedules, controls, receipts and old prune/review state are unchanged.
- Observe rollback before/after the horizon, effective pg-boss missed policy, no duplicate effect at a boundary occurrence, and native late admissions fenced. A schedule row by itself is not a cron execution result.

Old-consumer exit evidence:

- Archive and run the actual pre-lane conversation and placement handlers separately. Hold each after SELECT, begin drain, and show finish refuses missing quiescence. Allow the held old handler to finish or terminate it under the test's known transaction state; observe its actual process exit before attesting. It may produce a domain effect without a new receipt, which must not be relabeled durable evidence.
- Capture all old consumer/scheduler/forwarder owners, not only the new `offWork` call. Preserve failure rows and task identity. Prove shutdown completion and retained schema before testing a binary downgrade. A source search proving old registrations were removed is a separate static layer.

Final delivery checks later: scoped unit/DB/migration gates, typecheck/lint/build, applicable independent review and exact-head CI under the parent workflow. Actual cron, crash recovery, rollback, full restore and source delivery remain separate claims; incomplete layers stay explicit.

## Unresolved risks and adjudication points

1. Parent must approve shared-table LIGHT, the normalized disposition target shape, file ownership, and the two helper extractions before implementation. No author should start from this report without that adjudication. 5796 may have changed shared paths by then; rebase the design against merged 1393/fresh main and allocate a migration number there.
2. Frozen candidate JSON is the simplest current representation and matches the existing review approach (`src/server/durable/review-orphan-family.ts:150-177`). “Bounded” here means exactly two consumers and a fixed admitted set, not a hidden row cap. There is no current evidence for maximum backlog size or adequate existing indexes. Measure the scoped selector/backlog later. If a very large list exceeds acceptable admission duration/row size, ask parent to approve a candidate child table or another complete snapshot representation; do not truncate silently or introduce live pagination during replay.
3. Conversation's existing global selection advisory lock can delay input during each row transaction. Keep transactions short and perform no network/provider work under it. Do not replace it or invert its order to optimize this lane. Real contention acceptance is still required.
4. The shared `prune-v1` version means old workers can lack new workflow registrations. Additive source compatibility is not safe mixed-worker execution. Upgrade/downgrade requires observed old worker exit, not only independent family phases.
5. Operator quiescence remains an attestation of observed process ownership. Tables alone cannot prove a suspended process vanished. Unknown forwarders may block both family transitions until the owner supplies evidence; no generic recovery or force-finish command should bypass that uncertainty.
6. Installed pg-boss has catch-up options beyond the ordinary 60-second due window. Actual schedule options and deployment packages need verification. This report proposes maintaining skip/no-backfill semantics, not changing old prune/review horizon code or treating its tests as current service evidence.
7. READ COMMITTED, authoritative-primary routing and lock-wait behavior are correctness assumptions for noncommit proof. Fault tests must establish them using the real DB client. No new automatic failover, connection infrastructure or lockless fallback is authorized.
8. Session IDs must not be reused for a different lifetime, and these domains must remain non-reopenable. A later reopen feature needs a new contract version and explicit incarnation semantics. Do not import review's version/incarnation checks now, because version checks would wrongly exempt a resumed old conversation.
9. Retention and full-DB restore of the new evidence are operational obligations, not completed by export exclusion. No runtime snapshot or backup was inspected here. Parent retains their acceptance and tracker capture responsibilities.

Recommendation remains one closed two-family runner with a family-keyed four-table ledger, precise domain Tx helpers, and independent cutover. All runtime acceptance above is pending.
