# YUK-384 Durable Hub Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace best-effort nightly hub auto-sync with a PostgreSQL-authoritative, generation-fenced desired-state reconciler that converges safely across mutations, concurrent editors, crashes, retries, and repair runs.

**Architecture:** PostgreSQL triggers atomically advance one durable reconciliation cursor per hub whenever topology-relevant desired state changes; pg-boss only wakes a shared `runHubSyncCycle`. Workers claim one generation at a time, recompute with the existing deterministic `resolveHubMeshAtomics`, then atomically apply body blocks, block refs, evidence event, and acknowledgement behind advisory-lock, generation/token/lease, editing-session, and artifact-version fences.

**Tech Stack:** TypeScript, PostgreSQL 16+, Drizzle ORM, pg-boss, Hono, React 19, Zod, Vitest unit/DB/migration tests, Biome, pnpm.

## Global Constraints

- PostgreSQL is authoritative; pg-boss delivery is optional wake-up/recovery transport, never the durability boundary.
- Keep exactly one `hub_sync_reconciliation` row keyed by `artifact_id`; generations remain PostgreSQL `bigint` and cross the TypeScript boundary as decimal strings, never JavaScript `number`.
- Preserve `resolveHubMeshAtomics` and the existing deterministic auto-zone construction; do not introduce a generic outbox, durable patches, an attempt-history ledger, a generic orchestrator, selective fan-out, or in-memory durability parity.
- Trigger fan-out occurs inside the writer's real outer transaction. Rollback and savepoint rollback must leave generations unchanged.
- Claim exactly one row with `FOR UPDATE SKIP LOCKED`; lease duration is 2 minutes and renewal cadence is 30 seconds. Never pre-lease a batch tail.
- Compute desired state outside row/advisory locks. Final transaction lock order is transaction advisory lock, artifact row, reconciliation row, then edit-session inspection.
- Finalization fences exact `artifact_id + generation + claim_token`, unexpired lease using database time after lock waits, eligible artifact shape, artifact version, and absence of any active edit session.
- Reconciliation's own artifact body write must execute under `SET LOCAL app.hub_sync_internal_apply = '1'`; no other code may set this marker.
- A valid no-op acknowledges without changing artifact version or writing an apply event. An invalid document is a classified retryable failure, never a no-op acknowledgement.
- Editing activity is session-qualified. Exact age 30 seconds is active; only age greater than 30 seconds is expired. There is no 10-minute forced hub apply.
- Immediate wake, every-minute recovery, and nightly repair all invoke `runHubSyncCycle`; no scheduled path may apply directly.
- Rollout mode is exactly `off | shadow | apply`. Do not run mixed old direct-apply and new reconciler workers.
- New dirty input and successful acknowledgement reset `consecutive_failure_count`; editor deferral, supersession, lost lease, and artifact CAS are non-failures.
- Classified retries use `min(5s * 2^(failure_count - 1), 15m) + 0–20% jitter`; there is no terminal discard.
- All file paths, commands, and commits below are repository-relative. Do not modify `.omc/plans/**`.

---

## File Map

| File | Change | Responsibility |
|---|---|---|
| `src/db/schema.ts` | Modify | Drizzle declarations for reconciliation cursor and session-qualified editing rows. |
| `drizzle/0071_yuk384_durable_hub_sync.sql` | Create | Tables, strict checks/indexes, trigger functions/triggers, backfill, and removal of obsolete single-row presence state. |
| `drizzle/meta/0071_snapshot.json` | Create | Generated schema snapshot. |
| `drizzle/meta/_journal.json` | Modify | Register migration `0071_yuk384_durable_hub_sync`. |
| `tests/integration/migration-smoke.test.ts` | Modify | Populated-old-schema backfill and exact DDL/trigger assertions. |
| `src/capabilities/notes/server/hub-sync-reconciliation.ts` | Create | Cursor claim/renew/compute/finalize/retry/repair and unified cycle implementation. |
| `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts` | Create | Ordered adversarial tests 2–14 and 18–24. |
| `src/capabilities/notes/server/note-refine-apply.ts` | Modify | Expose the existing atomic block-ref/event primitives needed by fenced finalization; retain non-hub callers. |
| `src/server/artifacts/presence/types.ts` | Modify | Add `sessionId` to heartbeat/blur inputs; remove durable queued-patch semantics from hub arbitration. |
| `src/server/artifacts/presence/pg.ts` | Modify | Advisory-locked session-row upsert/delete/snapshot behavior. |
| `src/server/artifacts/presence/pg.db.test.ts` | Modify | Ordered tests 15–17 for multi-session and timing races. |
| `src/server/artifacts/editing-session.ts` | Modify | Thread session-qualified presence interfaces. |
| `src/capabilities/notes/api/contracts.ts` | Modify | Require `editor_session_id` in heartbeat and blur bodies. |
| `src/capabilities/notes/api/editing-heartbeat.ts` | Modify | Upsert only the caller's editing session. |
| `src/capabilities/notes/api/editing-blur.ts` | Modify | Delete only the caller's editing session. |
| `src/capabilities/notes/api/editing-heartbeat.unit.test.ts` | Modify | Route contract forwarding coverage. |
| `src/capabilities/notes/api/editing-blur.unit.test.ts` | Modify | Route contract forwarding coverage. |
| `src/capabilities/notes/ui/notes-api.ts` | Modify after design preflight approval | Send `editor_session_id` on heartbeat and blur. |
| `src/capabilities/notes/ui/NoteReaderPage.tsx` | Modify after design preflight approval | Create and retain one UUID per mounted edit session. |
| `src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx` | Modify | Verify stable per-session ID and fresh ID after remount. |
| `src/capabilities/notes/jobs/hub_auto_sync_nightly.ts` | Modify | Replace direct nightly application with wrappers around `runHubSyncCycle`. |
| `src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts` | Modify | Unified immediate/recovery/nightly and continuation tests. |
| `src/capabilities/notes/manifest.ts` | Modify | Register mutation wake worker, minute recovery schedule, and 02:45 nightly repair on the same handler family. |
| `src/capabilities/observability/server/hub-sync.ts` | Create | Aggregate durable reconciler health metrics. |
| `src/capabilities/observability/server/hub-sync.db.test.ts` | Create | Metric/read-model assertions. |
| `src/capabilities/observability/api/admin-hub-sync.ts` | Create | Admin JSON endpoint for reconciler health. |
| `src/capabilities/observability/api/admin-observability-contracts.ts` | Modify | Zod response contract. |
| `src/capabilities/observability/manifest.ts` | Modify | Register the admin route. |
| `scripts/audit-hub-sync-writers.ts` | Create | Static ownership audit for topology writers and forbidden bypasses. |
| `scripts/audit-hub-sync-writers.test.ts` | Create | Ordered RED test 25. |
| `scripts/audit-hub-sync-writers-allowlist.json` | Create | Explicit topology-writer inventory justified by trigger ownership. |
| `package.json` | Modify | Add `audit:hub-sync-writers` and wire it into `test`. |
| `tests/integration/step9-invariant-audit.test.ts` | Modify | Lock the single-owner/source invariants. |
| `docs/adr/0020-block-tree-note-rebuild.md` | Modify | Record the durable hub reconciliation amendment. |
| `docs/architecture.md` | Modify | Document trigger ownership, worker schedules, rollout mode, and operator metrics. |

## Explicit Interfaces and State Machine

```ts
export type HubSyncReason = 'mutation_wake' | 'recovery' | 'nightly_repair';
export type HubSyncMode = 'off' | 'shadow' | 'apply';
export type HubSyncResidentStatus =
  | 'pending'
  | 'claimed'
  | 'applying'
  | 'retry_wait'
  | 'acknowledged'
  | 'cancelled';

export interface HubSyncCycleOptions {
  reason: HubSyncReason;
  maxArtifacts: number;
  repairKey?: string;
  mode?: HubSyncMode;
  owner?: string;
}

export interface HubSyncCycleResult {
  reason: HubSyncReason;
  mode: HubSyncMode;
  claimed: number;
  applied: number;
  acknowledged_noop: number;
  deferred_editing: number;
  superseded: number;
  retry_scheduled: number;
  cancelled: number;
  continuation_needed: boolean;
}

export interface HubSyncClaim {
  artifactId: string;
  generation: string;
  claimToken: string;
  claimOwner: string;
  leaseExpiresAt: Date;
}

export interface HubDesiredState {
  artifactId: string;
  observedArtifactVersion: number;
  bodyBlocks: ArtifactBodyBlocks;
  desiredHash: string;
  changed: boolean;
}

export async function runHubSyncCycle(
  db: Db,
  options: HubSyncCycleOptions,
): Promise<HubSyncCycleResult>;

export async function claimNextHubSync(
  db: Db,
  input: { owner: string },
): Promise<HubSyncClaim | null>;

export async function renewHubSyncLease(db: Db, claim: HubSyncClaim): Promise<boolean>;

export async function computeHubDesiredState(
  db: Db,
  claim: HubSyncClaim,
): Promise<HubDesiredState>;

export async function finalizeHubSync(
  db: Db,
  input: { claim: HubSyncClaim; desired: HubDesiredState; mode: HubSyncMode },
): Promise<
  | 'applied'
  | 'acknowledged_noop'
  | 'deferred_editing'
  | 'superseded'
  | 'cancelled'
  | 'shadowed'
>;

export async function repairHubSyncCoverage(
  db: Db,
  input: { repairKey: string; pageSize: number },
): Promise<{ dirtied: number; cancelled: number; hasMore: boolean }>;
```

Resident transitions are: absent → pending; any resident state plus relevant mutation → newer pending, or cancelled if ineligible; pending/retry_wait/expired claim → claimed; claimed renewal → claimed; final transaction claimed → applying → acknowledged; active editor or artifact CAS → pending; classified error → retry_wait; archive/type loss → cancelled; restore → newer pending; hard delete → absent. `superseded` is an attempt outcome, never a resident status.

## Ordered RED Test Ledger

The tasks below introduce these tests in this exact order and retain their numbered names until rollout completes:

1. migration exact schema/checks/FKs/indexes/triggers plus populated-old-schema hub backfill;
2. topology dirtying is commit-atomic; outer rollback and savepoint rollback do not advance generation;
3. triggers select topology columns and ignore embedding/metadata-only changes;
4. atomic create/title/knowledge/archive/restore dirties every live hub;
5. hub create/restore/archive/knowledge/suppression/body changes dirty or cancel locally, while internal apply does not self-dirty;
6. concurrent global fan-out locks hubs in sorted artifact-ID order without multi-hub deadlock;
7. two workers cannot claim the same generation and no batch tail is pre-leased;
8. expired lease is reclaimable and an old token cannot apply, acknowledge, or record failure;
9. 30-second renewal supports compute longer than 2 minutes and failed renewal aborts;
10. generation N claimed then N+1 committed before finalization cannot write or acknowledge N;
11. finalization holding the cursor before N+1 arrives leaves the row pending at N+1;
12. artifact version change after compute prevents apply and returns pending without failure increment;
13. rollback injected after artifact/block-ref/event/ack work leaves no partial effect;
14. equal valid desired state acknowledges without churn, while invalid document enters retry;
15. blur for session A cannot clear session B and delayed blur cannot clear a newer session;
16. concurrent first-heartbeat/absent-row arbitration is serialized by the shared advisory lock;
17. exactly 30 seconds remains active, greater than 30 seconds expires, and database time is evaluated after lock waits;
18. active editing never increments failure count and missed blur eventually expires and applies;
19. archive/restore/suppression/body save/hard delete racing finalization has no deadlock or stale cancellation;
20. nightly repair racing archive/restore rechecks current state under lock;
21. duplicate nightly repair key does not increment generation twice;
22. immediate pg-boss send failure still converges through minute recovery;
23. backlog larger than a cycle emits one continuation and drains fairly;
24. one hub failure preserves later hubs and durable retry state;
25. static audit catches a new topology writer, reconciliation writer, internal marker setter, or direct `hub_auto_sync` apply bypass.

---

### Task 1: Durable Schema, Trigger Functions, and Backfill — RED Test 1

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0071_yuk384_durable_hub_sync.sql`
- Create: `drizzle/meta/0071_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `tests/integration/migration-smoke.test.ts`

**Interfaces:**
- Consumes: existing `artifact`, `knowledge`, and `knowledge_edge` tables; hub type `note_hub`; atomic type `note_atomic`.
- Produces: Drizzle exports `hub_sync_reconciliation` and `artifact_edit_session`; SQL functions `mark_hub_sync_dirty(text, boolean)` and `fanout_hub_sync_dirty()`; trigger-only GUC `app.hub_sync_internal_apply`.

- [ ] **Step 1: Write migration RED test 1 before adding schema**

```ts
it('YUK-384 RED 01: installs exact durable hub-sync schema, triggers, indexes, and backfills live hubs', async () => {
  await oldSchemaSql`
    insert into artifact (id, type, title, body_blocks, attrs, knowledge_ids, version)
    values ('hub-existing', 'note_hub', 'Hub', '[]'::jsonb, '{}'::jsonb, '{}'::text[], 1)
  `;
  await applyPendingMigrations(oldSchemaSql);

  const rows = await oldSchemaSql<{
    artifact_id: string;
    generation: string;
    acknowledged_generation: string;
    status: string;
  }[]>`
    select artifact_id, generation::text, acknowledged_generation::text, status
    from hub_sync_reconciliation
  `;
  expect(rows).toEqual([{
    artifact_id: 'hub-existing',
    generation: '1',
    acknowledged_generation: '0',
    status: 'pending',
  }]);

  const indexes = await oldSchemaSql<{ indexname: string }[]>`
    select indexname from pg_indexes
    where tablename in ('hub_sync_reconciliation', 'artifact_edit_session')
    order by indexname
  `;
  expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
    'hub_sync_reconciliation_pkey',
    'hub_sync_ready_idx',
    'hub_sync_expired_idx',
    'hub_sync_dirty_age_idx',
    'artifact_edit_session_pkey',
    'artifact_edit_session_recent_idx',
  ]));

  const triggers = await oldSchemaSql<{ tgname: string }[]>`
    select tgname from pg_trigger
    where not tgisinternal and tgname like 'hub_sync_%'
    order by tgname
  `;
  expect(triggers.map((row) => row.tgname)).toEqual([
    'hub_sync_artifact_dirty',
    'hub_sync_knowledge_dirty',
    'hub_sync_knowledge_edge_dirty',
  ]);
});
```

- [ ] **Step 2: Run RED test 1**

Run: `pnpm vitest run --config vitest.migration.config.ts tests/integration/migration-smoke.test.ts -t 'YUK-384 RED 01'`

Expected: FAIL with `relation "hub_sync_reconciliation" does not exist`.

- [ ] **Step 3: Add exact Drizzle table declarations**

```ts
export const hub_sync_reconciliation = pgTable(
  'hub_sync_reconciliation',
  {
    artifact_id: text('artifact_id').primaryKey().references(() => artifact.id, { onDelete: 'cascade' }),
    actor_ref: text('actor_ref').notNull().default('hub_auto_sync'),
    generation: bigint('generation', { mode: 'bigint' }).notNull().default(1n),
    acknowledged_generation: bigint('acknowledged_generation', { mode: 'bigint' }).notNull().default(0n),
    status: text('status').notNull().default('pending'),
    claim_owner: text('claim_owner'),
    claim_token: text('claim_token'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    claim_count: integer('claim_count').notNull().default(0),
    consecutive_failure_count: integer('consecutive_failure_count').notNull().default(0),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    last_dirty_at: timestamp('last_dirty_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    last_claimed_at: timestamp('last_claimed_at', { withTimezone: true }),
    last_error_at: timestamp('last_error_at', { withTimezone: true }),
    acknowledged_at: timestamp('acknowledged_at', { withTimezone: true }),
    last_outcome: text('last_outcome'),
    last_error_class: text('last_error_class'),
    last_error_code: text('last_error_code'),
    last_error: text('last_error'),
    last_desired_hash: text('last_desired_hash'),
    last_repair_key: text('last_repair_key'),
    last_observed_artifact_version: integer('last_observed_artifact_version'),
    last_applied_artifact_version: integer('last_applied_artifact_version'),
  },
  (table) => [
    check('hub_sync_actor_check', sql`${table.actor_ref} = 'hub_auto_sync'`),
    check('hub_sync_generation_check', sql`${table.generation} > 0`),
    check('hub_sync_ack_generation_check', sql`${table.acknowledged_generation} >= 0 and ${table.acknowledged_generation} <= ${table.generation}`),
    check('hub_sync_status_check', sql`${table.status} in ('pending','claimed','applying','retry_wait','acknowledged','cancelled')`),
    check('hub_sync_claim_shape_check', sql`((${table.status} in ('claimed','applying')) = (${table.claim_owner} is not null and ${table.claim_token} is not null and ${table.lease_expires_at} is not null))`),
  ],
);

export const artifact_edit_session = pgTable(
  'artifact_edit_session',
  {
    artifact_id: text('artifact_id').notNull().references(() => artifact.id, { onDelete: 'cascade' }),
    session_id: text('session_id').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.artifact_id, table.session_id] })],
);
```

Use `pnpm db:generate --name yuk384_durable_hub_sync` to create the next migration, then rename only if Drizzle does not choose `0071_yuk384_durable_hub_sync.sql`. Amend the generated SQL with the checks, partial indexes, trigger functions, triggers, and backfill below; keep `clock_timestamp()` out of every partial-index predicate.

```sql
CREATE INDEX hub_sync_ready_idx ON hub_sync_reconciliation (next_attempt_at, last_dirty_at, artifact_id)
  WHERE status IN ('pending', 'retry_wait');
CREATE INDEX hub_sync_expired_idx ON hub_sync_reconciliation (lease_expires_at, artifact_id)
  WHERE status IN ('claimed', 'applying');
CREATE INDEX hub_sync_dirty_age_idx ON hub_sync_reconciliation (last_dirty_at, artifact_id)
  WHERE acknowledged_generation < generation;
CREATE INDEX artifact_edit_session_recent_idx ON artifact_edit_session (artifact_id, last_heartbeat_at DESC);

INSERT INTO hub_sync_reconciliation (artifact_id, status)
SELECT id, 'pending' FROM artifact
WHERE type = 'note_hub' AND archived_at IS NULL
ORDER BY id
ON CONFLICT (artifact_id) DO NOTHING;
```

The artifact trigger must branch explicitly: live hub create/restore/relevant update calls local dirty; archive/type loss calls local cancel; hard delete relies on FK cascade; live atomic create/delete or relevant update fans out. Knowledge and edge triggers fan out only for the columns listed in Global Constraints and Task 2.

- [ ] **Step 4: Run migration GREEN and schema generation checks**

Run: `pnpm vitest run --config vitest.migration.config.ts tests/integration/migration-smoke.test.ts -t 'YUK-384 RED 01' && pnpm audit:schema`

Expected: PASS for RED 01 and `Schema audit passed`.

- [ ] **Step 5: Commit schema slice**

```bash
git add src/db/schema.ts drizzle/0071_yuk384_durable_hub_sync.sql drizzle/meta/0071_snapshot.json drizzle/meta/_journal.json tests/integration/migration-smoke.test.ts
git commit -m "feat(db): add durable hub sync cursor YUK-384"
```

---

### Task 2: Trigger-Backed Dirty Generations — RED Tests 2–6

**Files:**
- Modify: `drizzle/0071_yuk384_durable_hub_sync.sql`
- Create: `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts`

**Interfaces:**
- Consumes: trigger functions created in Task 1.
- Produces: atomic, sorted, topology-selective generation advancement for all current writer paths.

- [ ] **Step 1: Write RED tests 2–6 with transaction barriers**

```ts
it('YUK-384 RED 02: dirty generation follows outer commit, rollback, and savepoint rollback', async () => {
  await seedHub('hub-a');
  await db.transaction(async (tx) => {
    await tx.update(knowledge).set({ name: 'committed' }).where(eq(knowledge.id, 'k1'));
    expect(await generationOutsideTransaction('hub-a')).toBe('1');
  });
  expect(await generation('hub-a')).toBe('2');
  await expect(db.transaction(async (tx) => {
    await tx.update(knowledge).set({ name: 'rolled-back' }).where(eq(knowledge.id, 'k1'));
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await generation('hub-a')).toBe('2');
  await sql`savepoint dirty_sp`;
  await sql`update knowledge set name = 'savepoint' where id = 'k1'`;
  await sql`rollback to savepoint dirty_sp`;
  expect(await generation('hub-a')).toBe('2');
});

it('YUK-384 RED 03: only topology columns dirty hubs', async () => {
  await expectGenerationDelta('hub-a', 0, () => sql`update knowledge set embedding = null where id = 'k1'`);
  await expectGenerationDelta('hub-a', 1, () => sql`update knowledge set name = 'renamed' where id = 'k1'`);
  await expectGenerationDelta('hub-a', 0, () => sql`update artifact set verification_summary = '{}' where id = 'atomic-a'`);
  await expectGenerationDelta('hub-a', 1, () => sql`update artifact set title = 'renamed' where id = 'atomic-a'`);
});

it('YUK-384 RED 04: every atomic topology transition dirties all live hubs', async () => {
  await seedHub('hub-b');
  for (const mutate of atomicTopologyMutations()) {
    const before = await generations(['hub-a', 'hub-b']);
    await mutate();
    expect(await generations(['hub-a', 'hub-b'])).toEqual(before.map((value) => value + 1n));
  }
});

it('YUK-384 RED 05: hub-local changes dirty or cancel one hub and internal apply does not self-dirty', async () => {
  await sql`update artifact set attrs = jsonb_set(attrs, '{hub_mesh_suppressed_ids}', '["atomic-a"]') where id = 'hub-a'`;
  expect(await state('hub-a')).toMatchObject({ generation: '2', status: 'pending' });
  await sql`update artifact set archived_at = clock_timestamp() where id = 'hub-a'`;
  expect(await state('hub-a')).toMatchObject({ generation: '3', status: 'cancelled' });
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local app.hub_sync_internal_apply = '1'`);
    await tx.update(artifact).set({ body_blocks: [] }).where(eq(artifact.id, 'hub-b'));
  });
  expect(await generation('hub-b')).toBe('1');
});

it('YUK-384 RED 06: concurrent global fan-out locks hubs in artifact-id order', async () => {
  await seedHub('hub-z');
  const [left, right] = await Promise.allSettled([
    withStatementTimeout(2_000, () => sql`update knowledge set name = name || '-a' where id = 'k1'`),
    withStatementTimeout(2_000, () => sql`update knowledge_edge set reasoning = 'changed' where id = 'e1'`),
  ]);
  expect([left.status, right.status]).toEqual(['fulfilled', 'fulfilled']);
  expect(await generations(['hub-a', 'hub-z'])).toEqual([3n, 3n]);
});
```

`atomicTopologyMutations()` must concretely cover create, delete, `title`, `knowledge_ids`, `archived_at` archive/restore, and `type`. Hub-local assertions must cover create, restore, archive, type, `knowledge_ids`, suppression attrs, and owner `body_blocks`. Knowledge coverage is INSERT/DELETE plus updates to `name`, `domain`, `parent_id`, `merged_from`, `archived_at`, and identity-bearing fields present in `src/db/schema.ts`; edge coverage is INSERT/DELETE plus endpoint, relation, and archive updates.

- [ ] **Step 2: Run RED tests 2–6**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED 0[2-6]'`

Expected: FAIL first at RED 02 because topology writes do not advance durable generations.

- [ ] **Step 3: Implement trigger upsert semantics**

```sql
INSERT INTO hub_sync_reconciliation (
  artifact_id, generation, status, next_attempt_at, last_dirty_at, updated_at,
  claim_owner, claim_token, lease_expires_at, consecutive_failure_count,
  last_error_at, last_error_class, last_error_code, last_error
)
VALUES (
  target_artifact_id, 1, CASE WHEN cancel_target THEN 'cancelled' ELSE 'pending' END,
  clock_timestamp(), clock_timestamp(), clock_timestamp(),
  NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL
)
ON CONFLICT (artifact_id) DO UPDATE SET
  generation = hub_sync_reconciliation.generation + 1,
  status = CASE WHEN cancel_target THEN 'cancelled' ELSE 'pending' END,
  next_attempt_at = clock_timestamp(),
  last_dirty_at = clock_timestamp(),
  updated_at = clock_timestamp(),
  claim_owner = NULL,
  claim_token = NULL,
  lease_expires_at = NULL,
  consecutive_failure_count = 0,
  last_error_at = NULL,
  last_error_class = NULL,
  last_error_code = NULL,
  last_error = NULL;
```

Global fan-out must execute `SELECT mark_hub_sync_dirty(id, false) FROM artifact WHERE type = 'note_hub' AND archived_at IS NULL ORDER BY id`. The artifact trigger must suppress only the reconciliation-owned body update when `current_setting('app.hub_sync_internal_apply', true) = '1'`; it must not suppress refs, events, or unrelated artifact changes.

- [ ] **Step 4: Run GREEN tests 2–6 and migration suite**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED 0[2-6]' && pnpm test:migration`

Expected: 5 passing tests; migration suite PASS.

- [ ] **Step 5: Commit trigger slice**

```bash
git add drizzle/0071_yuk384_durable_hub_sync.sql src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts
git commit -m "feat(notes): dirty hub generations from topology triggers YUK-384"
```

---

### Task 3: One-at-a-Time Claim and Renewable Lease — RED Tests 7–9

**Files:**
- Create: `src/capabilities/notes/server/hub-sync-reconciliation.ts`
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts`

**Interfaces:**
- Produces: `claimNextHubSync(db, { owner })`, `renewHubSyncLease(db, claim)`, and `HubSyncClaim` exactly as declared above.

- [ ] **Step 1: Write RED tests 7–9**

```ts
it('YUK-384 RED 07: claims one generation once and does not lease a batch tail', async () => {
  await seedReadyHubs(3);
  const [a, b] = await Promise.all([
    claimNextHubSync(db, { owner: 'worker-a' }),
    claimNextHubSync(db, { owner: 'worker-b' }),
  ]);
  expect(a?.artifactId).not.toBe(b?.artifactId);
  expect(await claimedCount()).toBe(2);
  expect(await pendingCount()).toBe(1);
});

it('YUK-384 RED 08: expired claim is reclaimed and old token is powerless', async () => {
  const oldClaim = await claimRequired('worker-old');
  await expireClaim(oldClaim);
  const newClaim = await claimRequired('worker-new');
  expect(newClaim.claimToken).not.toBe(oldClaim.claimToken);
  await expectOldTokenOperations(oldClaim).resolves.toEqual({ apply: false, ack: false, fail: false });
});

it('YUK-384 RED 09: renewal extends long compute and zero-row renewal aborts it', async () => {
  const claim = await claimRequired('worker-a');
  await advanceDatabaseClockBy('90 seconds');
  expect(await renewHubSyncLease(db, claim)).toBe(true);
  await supersedeClaim(claim);
  expect(await renewHubSyncLease(db, claim)).toBe(false);
});
```

- [ ] **Step 2: Run RED tests 7–9**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED 0[7-9]'`

Expected: FAIL to import `claimNextHubSync`.

- [ ] **Step 3: Implement claim SQL and exact-token renewal**

```ts
export async function claimNextHubSync(
  db: Db,
  input: { owner: string },
): Promise<HubSyncClaim | null> {
  const token = crypto.randomUUID();
  const rows = await db.execute<{
    artifact_id: string;
    generation: string;
    lease_expires_at: Date;
  }>(sql`
    with candidate as (
      select artifact_id
      from hub_sync_reconciliation
      where (
        status in ('pending', 'retry_wait') and next_attempt_at <= clock_timestamp()
      ) or (
        status in ('claimed', 'applying') and lease_expires_at < clock_timestamp()
      )
      order by next_attempt_at, last_dirty_at, artifact_id
      for update skip locked
      limit 1
    )
    update hub_sync_reconciliation r
    set status = 'claimed', claim_owner = ${input.owner}, claim_token = ${token},
        lease_expires_at = clock_timestamp() + interval '2 minutes',
        last_claimed_at = clock_timestamp(), updated_at = clock_timestamp(),
        claim_count = claim_count + 1
    from candidate
    where r.artifact_id = candidate.artifact_id
    returning r.artifact_id, r.generation::text, r.lease_expires_at
  `);
  const row = rows.rows[0];
  return row ? {
    artifactId: row.artifact_id,
    generation: row.generation,
    claimToken: token,
    claimOwner: input.owner,
    leaseExpiresAt: row.lease_expires_at,
  } : null;
}
```

Renew with one `UPDATE ... WHERE artifact_id = ? AND generation = ?::bigint AND claim_token = ? AND status IN ('claimed','applying') AND lease_expires_at >= clock_timestamp()`; return `rowCount === 1`. The cycle will run a 30-second timer and abort compute/finalize immediately when renewal returns false.

- [ ] **Step 4: Run GREEN tests 7–9**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED 0[7-9]'`

Expected: 3 passing tests.

- [ ] **Step 5: Commit claim slice**

```bash
git add src/capabilities/notes/server/hub-sync-reconciliation.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts
git commit -m "feat(notes): claim and renew hub sync leases YUK-384"
```

---

### Task 4: Deterministic Compute and Atomic Fenced Apply — RED Tests 10–14

**Files:**
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.ts`
- Modify: `src/capabilities/notes/server/note-refine-apply.ts`
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts`

**Interfaces:**
- Consumes: `resolveHubMeshAtomics`, existing auto-zone builder logic from `hub_auto_sync_nightly.ts`, existing block-ref and event persistence behavior from `persistNoteRefineApply`.
- Produces: `computeHubDesiredState`, `finalizeHubSync`, and `classifyHubSyncError`.

- [ ] **Step 1: Write RED tests 10–14**

```ts
it('YUK-384 RED 10: N+1 committed before finalization fences N', async () => {
  const claimN = await claimRequired('worker');
  const desiredN = await computeHubDesiredState(db, claimN);
  await renameAtomic('atomic-a', 'N+1');
  expect(await finalizeHubSync(db, { claim: claimN, desired: desiredN, mode: 'apply' })).toBe('superseded');
  expect(await state('hub-a')).toMatchObject({ generation: '2', acknowledged_generation: '0', status: 'pending' });
});

it('YUK-384 RED 11: N+1 waiting behind final cursor lock leaves newer pending state', async () => {
  const barrier = new FinalizeBarrier('after-reconciliation-lock');
  const applyN = finalizeWithBarrier(await preparedClaim(), barrier);
  await barrier.waitUntilReached();
  const mutateN1 = renameAtomic('atomic-a', 'N+1');
  barrier.release();
  await Promise.all([applyN, mutateN1]);
  expect(await state('hub-a')).toMatchObject({ generation: '2', acknowledged_generation: '1', status: 'pending' });
});

it('YUK-384 RED 12: artifact CAS conflict returns pending without failure', async () => {
  const prepared = await preparedClaim();
  await ownerSaveHub('hub-a');
  expect(await finalizePrepared(prepared)).toBe('superseded');
  expect(await state('hub-a')).toMatchObject({ status: 'pending', consecutive_failure_count: 0 });
});

it('YUK-384 RED 13: rollback at each apply stage leaves no partial effects', async () => {
  for (const stage of ['artifact', 'block_refs', 'event', 'ack'] as const) {
    await resetPreparedHub();
    await expect(finalizeWithInjectedFailure(stage)).rejects.toThrow(`inject:${stage}`);
    expect(await durableApplySnapshot()).toEqual(beforeApplySnapshot());
  }
});

it('YUK-384 RED 14: valid no-op acknowledges without churn and invalid document retries', async () => {
  const before = await artifactVersionAndEventCount('hub-a');
  expect(await finalizePrepared(await preparedNoopClaim())).toBe('acknowledged_noop');
  expect(await artifactVersionAndEventCount('hub-a')).toEqual(before);
  await corruptHubDocument('hub-a');
  await runHubSyncCycle(db, { reason: 'recovery', maxArtifacts: 1, mode: 'apply' });
  expect(await state('hub-a')).toMatchObject({ status: 'retry_wait', last_error_class: 'invalid_document' });
});
```

- [ ] **Step 2: Run RED tests 10–14**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED (10|11|12|13|14)'`

Expected: FAIL because `computeHubDesiredState` and `finalizeHubSync` are not exported.

- [ ] **Step 3: Implement compute outside locks using the retained resolver**

```ts
const curated = resolveHubMeshAtomics(
  nodes,
  edges,
  { hub_artifact_id: hub.id, knowledge_ids: hub.knowledge_ids },
  atomics.map((atomic) => ({
    artifact_id: atomic.id,
    title: atomic.title,
    knowledge_ids: atomic.knowledge_ids,
  })),
).filter((candidate) => !suppressedArtifactIds(hub.attrs).has(candidate.artifact_id));

const patch = buildAutoZonePatch(hub.body_blocks, hub.id, curated);
const bodyBlocks = patch ? applyNotePatch(hub.body_blocks, patch) : hub.body_blocks;
return {
  artifactId: hub.id,
  observedArtifactVersion: hub.version,
  bodyBlocks,
  desiredHash: createHash('sha256').update(stableStringify(bodyBlocks)).digest('hex'),
  changed: patch !== null,
};
```

Do not store `patch`. Validate both current and desired documents before treating equality as a no-op.

- [ ] **Step 4: Implement final transaction with fixed lock/fence order**

```ts
return db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.claim.artifactId}, 0))`);
  const hub = await lockArtifactForUpdate(tx, input.claim.artifactId);
  const cursor = await lockHubSyncCursorForUpdate(tx, input.claim.artifactId);
  const activeEditors = await tx.execute(sql`
    select session_id from artifact_edit_session
    where artifact_id = ${input.claim.artifactId}
      and clock_timestamp() - last_heartbeat_at <= interval '30 seconds'
  `);

  if (!claimFenceMatches(cursor, input.claim) || cursor.lease_expires_at < await databaseNow(tx)) return 'superseded';
  if (!isLiveHub(hub)) return cancelClaimedCursor(tx, input.claim);
  if (activeEditors.rowCount > 0) return deferClaimedCursor(tx, input.claim, 'active_editor');
  if (hub.version !== input.desired.observedArtifactVersion) return deferClaimedCursor(tx, input.claim, 'artifact_version_changed');
  if (!isValidHubDocument(input.desired.bodyBlocks)) throw new HubSyncError('invalid_document', 'INVALID_DOCUMENT');
  if (!input.desired.changed) return acknowledgeNoop(tx, input.claim, input.desired);
  if (input.mode === 'shadow') return acknowledgeShadowObservation(tx, input.claim, input.desired);

  await tx.execute(sql`set local app.hub_sync_internal_apply = '1'`);
  await markApplying(tx, input.claim);
  const appliedVersion = await updateArtifactBodyWithVersionCas(tx, hub, input.desired.bodyBlocks);
  await replaceArtifactBlockRefs(tx, input.claim.artifactId, input.desired.bodyBlocks);
  await createHubSyncEvent(tx, {
    artifactId: input.claim.artifactId,
    generation: input.claim.generation,
    desiredHash: input.desired.desiredHash,
    reason: 'hub_desired_state_reconciled',
  });
  await acknowledgeApplied(tx, input.claim, input.desired, appliedVersion);
  return 'applied';
});
```

`acknowledgeNoop`, retry, apply, and defer updates must all include the exact generation/token/status/unexpired-lease predicate. Truncate `last_error` to 2,048 Unicode code points. `classifyHubSyncError` maps `invalid_document`, `desired_state_error`, `apply_validation_error`, PostgreSQL transient errors, and unknown errors to retry; non-failure outcomes never increment the failure counter.

- [ ] **Step 5: Run GREEN tests 10–14**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED (10|11|12|13|14)'`

Expected: 5 passing tests.

- [ ] **Step 6: Commit atomic apply slice**

```bash
git add src/capabilities/notes/server/hub-sync-reconciliation.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts src/capabilities/notes/server/note-refine-apply.ts
git commit -m "feat(notes): fence atomic hub sync apply YUK-384"
```

---

### Task 5: Session-Qualified PostgreSQL Editing — RED Tests 15–18

**Files:**
- Modify: `src/server/artifacts/presence/types.ts`
- Modify: `src/server/artifacts/presence/pg.ts`
- Modify: `src/server/artifacts/editing-session.ts`
- Modify: `src/server/artifacts/presence/pg.db.test.ts`
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts`
- Modify: `src/capabilities/notes/api/contracts.ts`
- Modify: `src/capabilities/notes/api/editing-heartbeat.ts`
- Modify: `src/capabilities/notes/api/editing-blur.ts`
- Modify: `src/capabilities/notes/api/editing-heartbeat.unit.test.ts`
- Modify: `src/capabilities/notes/api/editing-blur.unit.test.ts`

**Interfaces:**
- Produces: `RecordHeartbeatInput { artifactId: string; sessionId: string; now?: Date }` and `MarkIdleInput { artifactId: string; sessionId: string }`.
- Consumes: the same `pg_advisory_xact_lock(hashtextextended(artifactId, 0))` ordering used by finalization.

- [ ] **Step 1: Write RED tests 15–18**

```ts
it('YUK-384 RED 15: blur deletes only its session and cannot clear a newer session', async () => {
  await store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'A' });
  await store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'B' });
  await store.markArtifactIdleAndFlush({ artifactId: 'hub-a', sessionId: 'A', db });
  expect(await sessionIds('hub-a')).toEqual(['B']);
  await store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'A-new' });
  await store.markArtifactIdleAndFlush({ artifactId: 'hub-a', sessionId: 'A', db });
  expect(await sessionIds('hub-a')).toEqual(['A-new', 'B']);
});

it('YUK-384 RED 16: first heartbeat and reconcile serialize an absent-row race', async () => {
  const barrier = await holdHubAdvisoryLock('hub-a');
  const heartbeat = store.recordEditingHeartbeat({ artifactId: 'hub-a', sessionId: 'A' });
  const finalize = finalizePrepared(await preparedClaim());
  barrier.release();
  await Promise.all([heartbeat, finalize]);
  expect(await appliedWhileActive('hub-a')).toBe(false);
});

it('YUK-384 RED 17: exact 30 seconds is active and database time is read after lock wait', async () => {
  await heartbeatAtDatabaseAge('hub-a', 'A', '30 seconds');
  expect(await store.isArtifactIdle('hub-a')).toBe(false);
  await heartbeatAtDatabaseAge('hub-a', 'A', '30 seconds 1 millisecond');
  expect(await store.isArtifactIdle('hub-a')).toBe(true);
  expect(await evaluateAfterAdvisoryWait('hub-a', 'A', 31_000)).toBe(true);
});

it('YUK-384 RED 18: editing defers without failure and missed blur expires into apply', async () => {
  await heartbeatAtDatabaseAge('hub-a', 'A', '5 seconds');
  await runOneApplyCycle();
  expect(await state('hub-a')).toMatchObject({ status: 'pending', consecutive_failure_count: 0 });
  await heartbeatAtDatabaseAge('hub-a', 'A', '31 seconds');
  await runOneApplyCycle();
  expect(await state('hub-a')).toMatchObject({ status: 'acknowledged', consecutive_failure_count: 0 });
});
```

- [ ] **Step 2: Run RED tests 15–18**

Run: `pnpm vitest run --config vitest.db.config.ts src/server/artifacts/presence/pg.db.test.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED (15|16|17|18)'`

Expected: RED 15 FAIL because the current presence key is only `artifact_id`; RED 16–18 then remain red until shared advisory locking and database-time expiry exist.

- [ ] **Step 3: Implement advisory-locked session upsert/delete and API contracts**

```ts
export interface RecordHeartbeatInput {
  artifactId: string;
  sessionId: string;
  now?: Date;
}

export const EditingHeartbeatBodySchema = z.object({
  artifact_id: z.string().min(1),
  editor_session_id: z.string().uuid(),
  status: z.enum(['editing', 'idle']).default('editing'),
});

export const EditingBlurBodySchema = z.object({
  artifact_id: z.string().min(1),
  editor_session_id: z.string().uuid(),
});
```

```ts
await this.db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.artifactId}, 0))`);
  await tx.insert(artifact_edit_session).values({
    artifact_id: input.artifactId,
    session_id: input.sessionId,
    started_at: input.now,
    last_heartbeat_at: input.now,
  }).onConflictDoUpdate({
    target: [artifact_edit_session.artifact_id, artifact_edit_session.session_id],
    set: { last_heartbeat_at: input.now },
  });
});
```

Blur uses the same transaction lock then deletes exactly `(artifact_id, session_id)`. `isArtifactIdle` uses `NOT EXISTS` with `clock_timestamp() - last_heartbeat_at <= interval '30 seconds'`; it may delete rows older than 30 seconds as cleanup but correctness must not depend on cleanup. Remove the 10-minute force-apply path for hubs.

- [ ] **Step 4: Run GREEN tests 15–18 and route tests**

Run: `pnpm vitest run --config vitest.db.config.ts src/server/artifacts/presence/pg.db.test.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED (15|16|17|18)' && pnpm vitest run --config vitest.unit.config.ts src/capabilities/notes/api/editing-heartbeat.unit.test.ts src/capabilities/notes/api/editing-blur.unit.test.ts`

Expected: 4 numbered tests PASS; both route test files PASS.

- [ ] **Step 5: Commit editing backend slice**

```bash
git add src/server/artifacts/presence/types.ts src/server/artifacts/presence/pg.ts src/server/artifacts/editing-session.ts src/server/artifacts/presence/pg.db.test.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts src/capabilities/notes/api/contracts.ts src/capabilities/notes/api/editing-heartbeat.ts src/capabilities/notes/api/editing-blur.ts src/capabilities/notes/api/editing-heartbeat.unit.test.ts src/capabilities/notes/api/editing-blur.unit.test.ts
git commit -m "feat(notes): qualify editing presence by session YUK-384"
```

---

### Task 6: Required Design-Doc Preflight, Then Browser Session IDs

**Files:**
- Modify after approval: `src/capabilities/notes/ui/notes-api.ts`
- Modify after approval: `src/capabilities/notes/ui/NoteReaderPage.tsx`
- Modify: `src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx`

**Interfaces:**
- Consumes: API bodies requiring `editor_session_id` from Task 5.
- Produces: `sendEditingHeartbeat(artifactId: string, editorSessionId: string)` and `sendEditingBlur(artifactId: string, editorSessionId: string)`.

- [ ] **Step 1: Stop and perform the project UI design-doc preflight before editing UI**

Quote verbatim from `docs/adr/0040-notes-domain-rethink-living-note-contract.md` §6, lines 40–42:

> `### 6. 下线 dwell 触发，保留 editing_presence defer`
>
> `删 editing-heartbeat→refine 触发……保留 editing_presence 的「编辑时 defer AI 改动」并发仲裁……`

State that the component type is an existing **page** plus its API client, and list exactly:

- Modify: `src/capabilities/notes/ui/NoteReaderPage.tsx`
- Modify: `src/capabilities/notes/ui/notes-api.ts`
- Modify test only: `src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx`

No dedicated visual design document for the note editing-session transport was discovered under `docs/design/`; therefore stop and obtain owner approval that ADR-0040 §6 is sufficient grounding before Step 2. This task changes no layout, copy, or styling.

- [ ] **Step 2: After approval, write the failing browser-session test**

```tsx
it('keeps one editor session id for a mounted edit session and creates a new id after remount', async () => {
  const first = render(<NoteReaderPage />);
  await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
  await waitFor(() => expect(sendEditingHeartbeat).toHaveBeenCalled());
  const firstId = vi.mocked(sendEditingHeartbeat).mock.calls[0][1];
  await waitFor(() => expect(sendEditingHeartbeat).toHaveBeenCalledTimes(2));
  expect(vi.mocked(sendEditingHeartbeat).mock.calls[1][1]).toBe(firstId);
  first.unmount();

  render(<NoteReaderPage />);
  await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
  await waitFor(() => expect(sendEditingHeartbeat).toHaveBeenCalledTimes(3));
  expect(vi.mocked(sendEditingHeartbeat).mock.calls[2][1]).not.toBe(firstId);
});
```

- [ ] **Step 3: Run browser-session test RED**

Run: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx -t 'keeps one editor session id'`

Expected: FAIL because `sendEditingHeartbeat` receives only `artifactId`.

- [ ] **Step 4: Thread one UUID through heartbeat and blur**

```tsx
const editorSessionIdRef = useRef<string | null>(null);
const editorSessionId = () => {
  editorSessionIdRef.current ??= crypto.randomUUID();
  return editorSessionIdRef.current;
};

await sendEditingHeartbeat(artifactId, editorSessionId());
// On blur/unmount, capture the same value before clearing it.
const sessionId = editorSessionIdRef.current;
if (sessionId) await sendEditingBlur(artifactId, sessionId);
editorSessionIdRef.current = null;
```

```ts
export const sendEditingHeartbeat = (artifactId: string, editorSessionId: string) =>
  apiJson<{ ok: boolean }>('/api/editing-session/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ artifact_id: artifactId, editor_session_id: editorSessionId, status: 'editing' }),
  });

export const sendEditingBlur = (artifactId: string, editorSessionId: string) =>
  apiJson('/api/editing-session/blur', {
    method: 'POST',
    body: JSON.stringify({ artifact_id: artifactId, editor_session_id: editorSessionId }),
  });
```

- [ ] **Step 5: Run browser-session test GREEN**

Run: `pnpm vitest run --config vitest.unit.config.ts src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx`

Expected: all `NoteReaderPage.unit.test.tsx` tests PASS.

- [ ] **Step 6: Commit UI transport slice**

```bash
git add src/capabilities/notes/ui/notes-api.ts src/capabilities/notes/ui/NoteReaderPage.tsx src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx
git commit -m "feat(notes): send stable editor session ids YUK-384"
```

---

### Task 7: Race Closure Across Hub Lifecycle — RED Tests 19–21

**Files:**
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.ts`
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts`

**Interfaces:**
- Consumes: final lock order and trigger cursor from Tasks 2 and 4.
- Produces: `repairHubSyncCoverage(db, { repairKey, pageSize })` with idempotent `last_repair_key` handling.

- [ ] **Step 1: Write RED tests 19–21**

```ts
it.each(['archive', 'restore', 'suppression', 'body_save', 'hard_delete'] as const)(
  'YUK-384 RED 19: %s racing finalization cannot deadlock or leave stale cancellation',
  async (mutation) => {
    const result = await raceFinalizeAgainstHubMutation(mutation, { statementTimeoutMs: 2_000 });
    expect(result.deadlocked).toBe(false);
    expect(await reconciliationMatchesCurrentHub('hub-a')).toBe(true);
  },
);

it('YUK-384 RED 20: nightly repair rechecks archive and restore under artifact lock', async () => {
  const repair = repairWithBarrier('nightly:2026-07-21', 'before-artifact-lock');
  await repair.barrier.waitUntilReached();
  await archiveThenRestoreHub('hub-a');
  repair.barrier.release();
  await repair.done;
  expect(await state('hub-a')).toMatchObject({ status: 'pending' });
});

it('YUK-384 RED 21: duplicate nightly repair key increments each hub at most once', async () => {
  const key = 'nightly:2026-07-21';
  await repairHubSyncCoverage(db, { repairKey: key, pageSize: 100 });
  const once = await generation('hub-a');
  await repairHubSyncCoverage(db, { repairKey: key, pageSize: 100 });
  expect(await generation('hub-a')).toBe(once);
});
```

- [ ] **Step 2: Run RED tests 19–21**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED (19|20|21)'`

Expected: FAIL because `repairHubSyncCoverage` does not exist.

- [ ] **Step 3: Implement bounded idempotent repair**

Repair selects artifact IDs in ascending order by keyset page. For each ID it begins a transaction, takes the artifact advisory lock, locks/reloads the artifact, then locks the cursor. It increments/cancels only when `last_repair_key IS DISTINCT FROM repairKey`, and writes `last_repair_key = repairKey` in the same update. It never computes or applies desired body state.

```ts
const repairKey = input.repairKey;
if (!/^nightly:\d{4}-\d{2}-\d{2}$/.test(repairKey)) {
  throw new Error(`invalid nightly repair key: ${repairKey}`);
}
// Recheck artifact after advisory + row lock; do not trust the page scan snapshot.
await markRepairGeneration(tx, {
  artifactId,
  repairKey,
  cancel: !isLiveHub(lockedArtifact),
});
```

- [ ] **Step 4: Run GREEN tests 19–21**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts -t 'YUK-384 RED (19|20|21)'`

Expected: all parameterized RED 19 cases plus RED 20 and RED 21 PASS.

- [ ] **Step 5: Commit lifecycle race slice**

```bash
git add src/capabilities/notes/server/hub-sync-reconciliation.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts
git commit -m "feat(notes): repair hub cursors without lifecycle races YUK-384"
```

---

### Task 8: Unified Wake, Recovery, Nightly, Continuation, and Retry — RED Tests 22–24

**Files:**
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.ts`
- Modify: `src/capabilities/notes/jobs/hub_auto_sync_nightly.ts`
- Modify: `src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts`
- Modify: `src/capabilities/notes/manifest.ts`
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts`

**Interfaces:**
- Produces: `runHubSyncCycle` exactly as declared; pg-boss jobs `hub_sync_mutation_wake`, `hub_sync_recovery`, `hub_auto_sync_nightly`.
- Nightly repair key: `nightly:<Asia/Shanghai YYYY-MM-DD>`.

- [ ] **Step 1: Write RED tests 22–24**

```ts
it('YUK-384 RED 22: failed immediate send converges through minute recovery', async () => {
  await topologyMutationWithWake({ send: vi.fn().mockRejectedValue(new Error('boss unavailable')) });
  expect(await state('hub-a')).toMatchObject({ status: 'pending' });
  await runHubSyncCycle(db, { reason: 'recovery', maxArtifacts: 25, mode: 'apply' });
  expect(await state('hub-a')).toMatchObject({ status: 'acknowledged' });
});

it('YUK-384 RED 23: bounded cycle emits one continuation and drains fairly', async () => {
  await seedReadyHubs(30);
  const send = vi.fn().mockResolvedValue('job-id');
  const first = await buildHubSyncRecoveryHandler(db, { send })();
  expect(first.claimed).toBe(25);
  expect(send).toHaveBeenCalledTimes(1);
  expect(first.continuation_needed).toBe(true);
  await buildHubSyncRecoveryHandler(db, { send })();
  expect(await readyCount()).toBe(0);
  expect(await claimCounts()).toSatisfy((counts) => Math.max(...counts) - Math.min(...counts) <= 1);
});

it('YUK-384 RED 24: one hub failure schedules durable retry and later hubs continue', async () => {
  await seedReadyHubs(3);
  injectDesiredStateFailureFor('hub-b');
  const result = await runHubSyncCycle(db, { reason: 'recovery', maxArtifacts: 3, mode: 'apply' });
  expect(result).toMatchObject({ claimed: 3, applied: 2, retry_scheduled: 1 });
  expect(await state('hub-b')).toMatchObject({ status: 'retry_wait', consecutive_failure_count: 1 });
  expect(await retryDelayMs('hub-b')).toBeGreaterThanOrEqual(5_000);
  expect(await retryDelayMs('hub-b')).toBeLessThanOrEqual(6_000);
});
```

- [ ] **Step 2: Run RED tests 22–24**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts -t 'YUK-384 RED (22|23|24)'`

Expected: FAIL because direct nightly code does not share a bounded cycle or continuation.

- [ ] **Step 3: Implement the single cycle and job wrappers**

```ts
export async function runHubSyncCycle(db: Db, options: HubSyncCycleOptions): Promise<HubSyncCycleResult> {
  const mode = options.mode ?? readHubSyncMode(process.env.HUB_SYNC_MODE);
  const result = emptyCycleResult(options.reason, mode);
  if (mode === 'off') return result;
  if (options.reason === 'nightly_repair') {
    if (!options.repairKey) throw new Error('nightly_repair requires repairKey');
    await repairHubSyncCoverage(db, { repairKey: options.repairKey, pageSize: options.maxArtifacts });
  }
  for (let index = 0; index < options.maxArtifacts; index += 1) {
    const claim = await claimNextHubSync(db, { owner: options.owner ?? workerOwner() });
    if (!claim) break;
    result.claimed += 1;
    await reconcileClaimWithoutStoppingLaterHubs(db, claim, mode, result);
  }
  result.continuation_needed = await hasReadyHubSync(db);
  return result;
}
```

All three handlers call this function. Recovery cron is `* * * * *`, max 25. Nightly remains `45 2 * * *` in `Asia/Shanghai`, derives one BJT date repair key, and uses bounded pages plus continuation. Mutation wake is best-effort post-commit and max 25. If `continuation_needed`, the handler sends exactly one singleton-keyed continuation job.

Retry delay implementation:

```ts
const exponent = Math.max(0, consecutiveFailureCount - 1);
const baseMs = Math.min(5_000 * 2 ** exponent, 15 * 60_000);
const delayMs = Math.round(baseMs * (1 + random() * 0.2));
```

`claim_count` never enters this calculation. New trigger dirtying and successful acknowledgement reset consecutive failures.

- [ ] **Step 4: Run GREEN tests 22–24 and manifest tests**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts -t 'YUK-384 RED (22|23|24)' && pnpm vitest run --config vitest.unit.config.ts src/capabilities/notes/manifest.unit.test.ts`

Expected: RED 22–24 PASS; notes manifest tests PASS with all three job registrations.

- [ ] **Step 5: Commit unified worker slice**

```bash
git add src/capabilities/notes/server/hub-sync-reconciliation.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts src/capabilities/notes/jobs/hub_auto_sync_nightly.ts src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts src/capabilities/notes/manifest.ts
git commit -m "feat(notes): unify durable hub sync cycles YUK-384"
```

---

### Task 9: Static Writer Ownership Audit — RED Test 25

**Files:**
- Create: `scripts/audit-hub-sync-writers.ts`
- Create: `scripts/audit-hub-sync-writers.test.ts`
- Create: `scripts/audit-hub-sync-writers-allowlist.json`
- Modify: `package.json`
- Modify: `tests/integration/step9-invariant-audit.test.ts`

**Interfaces:**
- Produces: CLI `pnpm audit:hub-sync-writers` with exit 0 on a clean tree and exit 1 with file/line/rule findings.
- Audit rules: topology writes are inventoried because triggers own correctness; reconciliation-table writes and internal GUC setters are allowed only in `hub-sync-reconciliation.ts`; direct `actorRef: 'hub_auto_sync'` calls to `persistNoteRefineApply` are forbidden everywhere.

- [ ] **Step 1: Write RED test 25 using temporary fixture trees**

```ts
it.each([
  ['topology writer', "await db.update(knowledge).set({ name: 'x' })", 'UNINVENTORIED_TOPOLOGY_WRITER'],
  ['cursor writer', "await db.update(hub_sync_reconciliation).set({ status: 'acknowledged' })", 'RECONCILIATION_OWNER_BYPASS'],
  ['internal marker', "await db.execute(sql`set local app.hub_sync_internal_apply = '1'`)", 'INTERNAL_APPLY_MARKER_BYPASS'],
  ['direct apply actor', "persistNoteRefineApply({ db, artifactId, patch, actorRef: 'hub_auto_sync' })", 'DIRECT_HUB_ACTOR_APPLY'],
] as const)('YUK-384 RED 25: catches %s bypass', async (_name, source, rule) => {
  const root = await fixtureRepo({ 'src/bypass.ts': source });
  const findings = await auditHubSyncWriters({ root, allowlist: emptyAllowlist });
  expect(findings).toContainEqual(expect.objectContaining({ rule, file: 'src/bypass.ts' }));
});
```

- [ ] **Step 2: Run RED test 25**

Run: `pnpm vitest run --config vitest.unit.config.ts scripts/audit-hub-sync-writers.test.ts -t 'YUK-384 RED 25'`

Expected: FAIL to import `auditHubSyncWriters`.

- [ ] **Step 3: Implement lexical/static ownership audit and explicit allowlist**

```ts
export interface HubSyncAuditFinding {
  rule:
    | 'UNINVENTORIED_TOPOLOGY_WRITER'
    | 'RECONCILIATION_OWNER_BYPASS'
    | 'INTERNAL_APPLY_MARKER_BYPASS'
    | 'DIRECT_HUB_ACTOR_APPLY';
  file: string;
  line: number;
  excerpt: string;
}
```

Scan tracked `.ts`, `.tsx`, and `.sql` files. Match Drizzle and raw-SQL writes to `knowledge`, `knowledge_edge`, and topology-relevant `artifact` fields. Allow each known topology writer only through a JSON entry shaped exactly as follows:

```json
{
  "path": "src/capabilities/knowledge/api/node-update.ts",
  "tables": ["knowledge"],
  "reason": "PostgreSQL topology triggers atomically dirty all live hubs in the same transaction."
}
```

Reject reconciliation table writes and the internal marker unless the normalized path is `src/capabilities/notes/server/hub-sync-reconciliation.ts`. Reject direct hub actor apply without any allowlist escape hatch. Add `"audit:hub-sync-writers": "tsx scripts/audit-hub-sync-writers.ts"` to `package.json` and invoke it in the existing `test` audit chain.

- [ ] **Step 4: Run audit GREEN and source invariant tests**

Run: `pnpm vitest run --config vitest.unit.config.ts scripts/audit-hub-sync-writers.test.ts -t 'YUK-384 RED 25' && pnpm audit:hub-sync-writers && pnpm vitest run --config vitest.unit.config.ts tests/integration/step9-invariant-audit.test.ts`

Expected: RED 25 cases PASS; CLI prints `Hub sync writer audit passed`; invariant audit PASS.

- [ ] **Step 5: Commit audit slice**

```bash
git add scripts/audit-hub-sync-writers.ts scripts/audit-hub-sync-writers.test.ts scripts/audit-hub-sync-writers-allowlist.json package.json tests/integration/step9-invariant-audit.test.ts
git commit -m "test(notes): guard hub sync writer ownership YUK-384"
```

---

### Task 10: Durable Observability and Operator Contract

**Files:**
- Create: `src/capabilities/observability/server/hub-sync.ts`
- Create: `src/capabilities/observability/server/hub-sync.db.test.ts`
- Create: `src/capabilities/observability/api/admin-hub-sync.ts`
- Modify: `src/capabilities/observability/api/admin-observability-contracts.ts`
- Modify: `src/capabilities/observability/manifest.ts`
- Modify: `src/capabilities/notes/server/hub-sync-reconciliation.ts`

**Interfaces:**
- Produces: `readHubSyncHealth(db): Promise<HubSyncHealth>` and `GET /api/admin/hub-sync`.

- [ ] **Step 1: Write failing observability DB test**

```ts
it('reports cursor health, lag, age, failures, and latest ack/repair', async () => {
  await seedHubSyncHealthFixture();
  expect(await readHubSyncHealth(db)).toEqual({
    by_status: { pending: 1, claimed: 0, applying: 0, retry_wait: 1, acknowledged: 1, cancelled: 0 },
    dirty_count: 2,
    ready_count: 1,
    expired_lease_count: 0,
    invalid_document_count: 1,
    oldest_dirty_age_seconds: 600,
    oldest_invalid_age_seconds: 120,
    max_consecutive_failure_count: 3,
    max_generation_lag: '4',
    last_acknowledged_at: expect.any(String),
    last_repair_key: 'nightly:2026-07-21',
  });
});
```

- [ ] **Step 2: Run observability RED**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/server/hub-sync.db.test.ts`

Expected: FAIL to import `readHubSyncHealth`.

- [ ] **Step 3: Implement one aggregate query, route contract, and structured attempt logs**

```ts
export interface HubSyncHealth {
  by_status: Record<HubSyncResidentStatus, number>;
  dirty_count: number;
  ready_count: number;
  expired_lease_count: number;
  invalid_document_count: number;
  oldest_dirty_age_seconds: number | null;
  oldest_invalid_age_seconds: number | null;
  max_consecutive_failure_count: number;
  max_generation_lag: string;
  last_acknowledged_at: string | null;
  last_repair_key: string | null;
}
```

Use PostgreSQL filtered aggregates and return generation lag as text. Emit one structured log per attempt containing `artifact_id`, `generation`, `claim_token`, `reason`, `mode`, `outcome`, `duration_ms`, and error classification, but never document bodies. The operator alerts documented in Task 11 are: oldest dirty over 5 minutes, expired leases for more than 2 recovery cycles, invalid document over 15 minutes, and monotonically growing ready backlog.

- [ ] **Step 4: Run observability GREEN and API contract audit**

Run: `pnpm vitest run --config vitest.db.config.ts src/capabilities/observability/server/hub-sync.db.test.ts && pnpm audit:api-contracts`

Expected: observability DB test PASS; API contract audit PASS.

- [ ] **Step 5: Commit observability slice**

```bash
git add src/capabilities/observability/server/hub-sync.ts src/capabilities/observability/server/hub-sync.db.test.ts src/capabilities/observability/api/admin-hub-sync.ts src/capabilities/observability/api/admin-observability-contracts.ts src/capabilities/observability/manifest.ts src/capabilities/notes/server/hub-sync-reconciliation.ts
git commit -m "feat(observability): expose durable hub sync health YUK-384"
```

---

### Task 11: Coordinated Rollout, Documentation, and Full Verification

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/adr/0020-block-tree-note-rebuild.md`
- Verify only: all files in the File Map.

**Interfaces:**
- Consumes: `HUB_SYNC_MODE=off|shadow|apply`, three unified jobs, health endpoint, and writer audit.
- Produces: an operator-safe deploy/rollback procedure; no new runtime interface.

- [ ] **Step 1: Document the exact rollout and rollback sequence**

Add this sequence to the ADR amendment and architecture runtime section:

1. Deploy migration/backfill with `HUB_SYNC_MODE=off`.
2. Stop all old worker processes before deploying new workers; never overlap old direct `hub_auto_sync_nightly` code with the reconciler.
3. Deploy the same application build to API and worker with `HUB_SYNC_MODE=shadow`.
4. Verify cursor backfill count equals live hub count; inspect status counts, ready/dirty age, desired hashes, classified errors, and duplicate nightly repair behavior.
5. Set `HUB_SYNC_MODE=apply` on all API/worker instances in one coordinated restart.
6. Confirm minute recovery drains pending rows and the 02:45 BJT repair uses one `nightly:<date>` key.
7. Retire the old direct nightly apply path only after apply-mode verification.
8. Roll back by setting `HUB_SYNC_MODE=off`; retain reconciliation rows and unacknowledged generations so obligations are not lost.

Document alerts: oldest dirty `> 5m`; any expired lease persisting across `> 2` minute cycles; invalid document age `> 15m`; ready backlog increasing across consecutive samples. Document mutation-to-ack latency from `last_dirty_at` to `acknowledged_at`.

- [ ] **Step 2: Run all 25 ordered adversarial tests together**

Run: `pnpm vitest run --config vitest.migration.config.ts tests/integration/migration-smoke.test.ts -t 'YUK-384 RED 01' && pnpm vitest run --config vitest.db.config.ts src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts src/server/artifacts/presence/pg.db.test.ts src/capabilities/notes/jobs/hub_auto_sync_nightly.db.test.ts -t 'YUK-384 RED' && pnpm vitest run --config vitest.unit.config.ts scripts/audit-hub-sync-writers.test.ts -t 'YUK-384 RED 25'`

Expected: ordered RED ledger 1–25 all PASS; parameterized race cases may increase the Vitest assertion count but no numbered case is skipped.

- [ ] **Step 3: Run focused subsystem gates**

Run: `pnpm test:migration && pnpm audit:hub-sync-writers && pnpm audit:schema && pnpm audit:partition && pnpm audit:api-contracts`

Expected: every command exits 0 and each audit prints its pass summary.

- [ ] **Step 4: Run pre-PR gates with fresh output**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: TypeScript exits 0; Biome reports no errors; full unit/DB/migration suite exits 0; Vite plus server/worker/migrate esbuild bundles complete successfully. If a wrapper is used, inspect and report the real inner `GATE EXIT` line rather than relying on wrapper exit status.

- [ ] **Step 5: Inspect for blockers and bypass residue**

Run: `rg -n "test\.(skip|only)|describe\.(skip|only)|debugger|console\.log|TBD|HACK" src/capabilities/notes/server/hub-sync-reconciliation.ts src/server/artifacts/presence src/capabilities/notes/jobs/hub_auto_sync_nightly.ts scripts/audit-hub-sync-writers.ts`

Expected: no matches. Structured operational logging may use the repository logger or `console.error` only where existing worker conventions require it.

- [ ] **Step 6: Run the Linear issue capture gate**

Search Linear for any actionable follow-up discovered during implementation. Update YUK-384 with migration, 25-test, audit, and rollout evidence. Create a separate issue only for a verified out-of-scope defect; otherwise record that no new Linear issue is needed because all discovered work is covered by YUK-384.

- [ ] **Step 7: Commit docs and rollout evidence**

```bash
git add docs/architecture.md docs/adr
git commit -m "docs: record durable hub sync rollout YUK-384"
```

## Completion Criteria

- All 25 ordered RED tests were observed failing for the intended reason before implementation and are GREEN together.
- Trigger DDL covers every specified topology-relevant mutation and ignores non-topology updates.
- There is no direct nightly apply path, no persisted patch payload, and no correctness dependency on pg-boss delivery.
- Generation/token/lease/version/editor fences and apply/block-ref/event/ack atomicity are demonstrated by adversarial DB tests.
- Editing is session-qualified end to end and browser changes passed the design-doc preflight before implementation.
- Writer ownership audit, migration suite, typecheck, lint, full tests, and build all pass with fresh output.
- Shadow/apply rollout and off-mode rollback retain all durable obligations and prohibit mixed old/new workers.
