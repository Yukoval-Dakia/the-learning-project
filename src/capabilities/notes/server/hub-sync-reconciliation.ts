// YUK-384 — durable hub-sync reconciliation: claim + renewable lease.
//
// PostgreSQL is authoritative. Topology triggers (drizzle/0071) advance one
// durable `generation` per hub; workers claim EXACTLY one ready cursor at a time
// with `FOR UPDATE SKIP LOCKED` (never pre-leasing a batch tail) and hold a
// 2-minute lease renewed every 30 seconds by the cycle. Generations are
// PostgreSQL `bigint` and cross the TypeScript boundary as decimal strings,
// never JavaScript `number`.

import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'drizzle-orm';

import { listKnowledgeEdges } from '@/capabilities/knowledge/server/edges';
import {
  type HubMeshAtomicInput,
  type HubMeshEdge,
  resolveHubMeshAtomics,
} from '@/capabilities/knowledge/server/hub-mesh';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
// Auto-zone builder + suppression reader are reused verbatim from the nightly
// path (plan Task 4: "Consumes … existing auto-zone builder logic from
// hub_auto_sync_nightly.ts"). The functions are called at runtime only, so the
// forward reference Task 8 will add (nightly → runHubSyncCycle) stays a benign
// ESM cycle; if it ever bites, lift these two helpers into a shared module.
import {
  buildAutoZonePatch,
  suppressedArtifactIds,
} from '@/capabilities/notes/jobs/hub_auto_sync_nightly';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import { applyNotePatch } from '@/core/blocks/apply-note-patch';
import { ArtifactBodyBlocks, type ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';

export interface HubSyncClaim {
  artifactId: string;
  generation: string;
  claimToken: string;
  claimOwner: string;
  leaseExpiresAt: Date;
}

/**
 * Claim the single most-eligible ready cursor for `owner`, or return null when
 * none is claimable. Eligible = a due `pending`/`retry_wait` row, or a
 * `claimed`/`applying` row whose lease has expired (reclaim). `FOR UPDATE SKIP
 * LOCKED` + `LIMIT 1` guarantees two workers never claim the same generation and
 * that no batch tail is pre-leased. Ordering `(next_attempt_at, last_dirty_at,
 * artifact_id)` drains fairly and deterministically.
 */
export async function claimNextHubSync(
  db: Db,
  input: { owner: string },
): Promise<HubSyncClaim | null> {
  const token = randomUUID();
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
    set status = 'claimed',
        claim_owner = ${input.owner},
        claim_token = ${token},
        lease_expires_at = clock_timestamp() + interval '2 minutes',
        last_claimed_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        claim_count = claim_count + 1
    from candidate
    where r.artifact_id = candidate.artifact_id
    returning r.artifact_id, r.generation::text as generation, r.lease_expires_at
  `);
  const row = rows[0];
  return row
    ? {
        artifactId: row.artifact_id,
        generation: row.generation,
        claimToken: token,
        claimOwner: input.owner,
        leaseExpiresAt: row.lease_expires_at,
      }
    : null;
}

/**
 * Extend the claim's lease by another 2 minutes, fencing on the exact
 * `artifact_id + generation + claim_token`, an active (`claimed`/`applying`)
 * status, and an unexpired lease measured by database time. Returns true iff
 * exactly one row matched; a false return means the claim was superseded, lost,
 * or expired, and the cycle must abort compute/finalize immediately.
 */
export async function renewHubSyncLease(db: Db, claim: HubSyncClaim): Promise<boolean> {
  const rows = await db.execute<{ artifact_id: string }>(sql`
    update hub_sync_reconciliation
    set lease_expires_at = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
    where artifact_id = ${claim.artifactId}
      and generation = ${claim.generation}::bigint
      and claim_token = ${claim.claimToken}
      and status in ('claimed', 'applying')
      and lease_expires_at >= clock_timestamp()
    returning artifact_id
  `);
  return rows.length === 1;
}

// ── Deterministic compute + atomic fenced apply (Task 4) ──────────────────────

export type HubSyncReason = 'mutation_wake' | 'recovery' | 'nightly_repair';
export type HubSyncMode = 'off' | 'shadow' | 'apply';

export interface HubDesiredState {
  artifactId: string;
  observedArtifactVersion: number;
  bodyBlocks: ArtifactBodyBlocksT;
  desiredHash: string;
  changed: boolean;
}

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

export type FinalizeOutcome =
  | 'applied'
  | 'acknowledged_noop'
  | 'deferred_editing'
  | 'superseded'
  | 'cancelled'
  | 'shadowed';

// Fault-injection seams for the atomicity + concurrency tests (RED 11 & 13).
// Production callers omit this argument entirely.
type ApplyStage = 'artifact' | 'block_refs' | 'event' | 'ack';
export interface FinalizeHubSyncHooks {
  afterCursorLock?: () => void | Promise<void>;
  beforeStage?: (stage: ApplyStage) => void | Promise<void>;
}

const HUB_TYPE = 'note_hub';
const ATOMIC_TYPE = 'note_atomic';
const ACTOR_REF = 'hub_auto_sync';
const HUB_SYNC_APPLY_ACTION = 'experimental:hub_sync_apply';
const LAST_ERROR_MAX_CODE_POINTS = 2048;

export class HubSyncError extends Error {
  constructor(
    readonly errorClass: string,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? errorClass);
    this.name = 'HubSyncError';
  }
}

export interface ClassifiedHubSyncError {
  errorClass: string;
  code: string;
  message: string;
}

/**
 * Every failure the reconciler recognises is retryable — there is no terminal
 * discard. HubSyncError carries its own class/code; PostgreSQL errors surface as
 * transient; anything else is unknown.
 */
export function classifyHubSyncError(err: unknown): ClassifiedHubSyncError {
  if (err instanceof HubSyncError) {
    return { errorClass: err.errorClass, code: err.code, message: err.message };
  }
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (typeof pgCode === 'string' && pgCode.length > 0) {
    return {
      errorClass: 'pg_transient',
      code: pgCode,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    errorClass: 'unknown',
    code: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };
}

// Deterministic key-sorted serialization so `desiredHash` is stable regardless
// of object key order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

function isValidHubDocument(bodyBlocks: unknown): boolean {
  return ArtifactBodyBlocks.safeParse(bodyBlocks).success;
}

function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

function workerOwner(): string {
  return `hub-sync:${hostname()}:${process.pid}`;
}

// `type` (not `interface`) so it satisfies drizzle `execute`'s
// `Record<string, unknown>` row constraint via the implicit index signature.
type HubComputeRow = {
  id: string;
  type: string;
  archived_at: Date | null;
  version: number;
  body_blocks: unknown;
  knowledge_ids: string[];
  attrs: Record<string, unknown> | null;
};

async function loadAtomicInputs(db: Db | Tx): Promise<HubMeshAtomicInput[]> {
  const rows = await db.execute<{ id: string; title: string; knowledge_ids: string[] }>(sql`
    select id, title, knowledge_ids
    from artifact
    where type = ${ATOMIC_TYPE} and archived_at is null
  `);
  return rows.map((r) => ({
    artifact_id: r.id,
    title: r.title,
    knowledge_ids: r.knowledge_ids ?? [],
  }));
}

async function loadEdgeInputs(db: Db): Promise<HubMeshEdge[]> {
  const rows = await listKnowledgeEdges(db);
  return rows.map((r) => ({
    from_knowledge_id: r.from_knowledge_id,
    to_knowledge_id: r.to_knowledge_id,
    relation_type: r.relation_type,
  }));
}

/**
 * Recompute the hub's desired body deterministically, OUTSIDE any row/advisory
 * lock, reusing the retained `resolveHubMeshAtomics` + `buildAutoZonePatch` +
 * `applyNotePatch`. Suppression (`attrs.suppressed_block_refs[]`) is honoured
 * exactly as the nightly path does. `changed` is true iff a patch was produced;
 * the patch itself is never stored.
 */
export async function computeHubDesiredState(
  db: Db,
  claim: HubSyncClaim,
): Promise<HubDesiredState> {
  const rows = await db.execute<HubComputeRow>(sql`
    select id, type, archived_at, version, body_blocks, knowledge_ids, attrs
    from artifact where id = ${claim.artifactId}
  `);
  const hub = rows[0];
  if (!hub) {
    throw new HubSyncError(
      'desired_state_error',
      'HUB_NOT_FOUND',
      `hub ${claim.artifactId} missing`,
    );
  }

  const nodes = await loadTreeSnapshot(db);
  const edges = await loadEdgeInputs(db);
  const atomics = await loadAtomicInputs(db);

  const suppressed = suppressedArtifactIds(hub.attrs);
  const curated = resolveHubMeshAtomics(
    nodes,
    edges,
    { hub_artifact_id: hub.id, knowledge_ids: hub.knowledge_ids ?? [] },
    atomics,
  ).filter((candidate) => !suppressed.has(candidate.artifact_id));

  const patch = buildAutoZonePatch(hub.body_blocks, hub.id, curated);
  const bodyBlocks = (
    patch ? applyNotePatch(hub.body_blocks, patch) : hub.body_blocks
  ) as ArtifactBodyBlocksT;

  return {
    artifactId: hub.id,
    observedArtifactVersion: hub.version,
    bodyBlocks,
    desiredHash: createHash('sha256').update(stableStringify(bodyBlocks)).digest('hex'),
    changed: patch !== null,
  };
}

// The exact generation + token + active-status + unexpired-lease predicate every
// cursor write must carry so a stale/superseded claim can never win a race.
function claimFence(claim: HubSyncClaim) {
  return sql`
    artifact_id = ${claim.artifactId}
    and generation = ${claim.generation}::bigint
    and claim_token = ${claim.claimToken}
    and status in ('claimed', 'applying')
    and lease_expires_at >= clock_timestamp()
  `;
}

type CursorLockRow = {
  generation: string;
  claim_token: string | null;
  status: string;
  lease_expired: boolean;
};

/**
 * The single fenced finalization transaction. Lock order is fixed: transaction
 * advisory lock → artifact row → reconciliation cursor → edit-session inspection.
 * Outcomes are evaluated in the exact order the plan prescribes; every mutating
 * branch carries the claim fence so it is a no-op under any concurrent win.
 */
export async function finalizeHubSync(
  db: Db,
  input: { claim: HubSyncClaim; desired: HubDesiredState; mode: HubSyncMode },
  hooks: FinalizeHubSyncHooks = {},
): Promise<FinalizeOutcome> {
  const { claim, desired, mode } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${claim.artifactId}, 0))`);

    const hubRows = await tx.execute<{
      type: string;
      archived_at: Date | null;
      version: number;
    }>(sql`
      select type, archived_at, version from artifact
      where id = ${claim.artifactId} for update
    `);
    const hub = hubRows[0];

    // Reconciliation cursor lock; database time is read here (after the lock
    // wait) so lease expiry is judged against the same instant.
    const cursorRows = await tx.execute<CursorLockRow>(sql`
      select generation::text as generation, claim_token, status,
             (lease_expires_at is null or lease_expires_at < clock_timestamp()) as lease_expired
      from hub_sync_reconciliation
      where artifact_id = ${claim.artifactId} for update
    `);
    const cursor = cursorRows[0];

    await hooks.afterCursorLock?.();

    const editorRows = await tx.execute<{ session_id: string }>(sql`
      select session_id from artifact_edit_session
      where artifact_id = ${claim.artifactId}
        and clock_timestamp() - last_heartbeat_at <= interval '30 seconds'
    `);

    const fenceMatches =
      cursor !== undefined &&
      cursor.claim_token === claim.claimToken &&
      cursor.generation === claim.generation &&
      (cursor.status === 'claimed' || cursor.status === 'applying');
    if (!fenceMatches || cursor.lease_expired) return 'superseded';

    if (!hub || hub.type !== HUB_TYPE || hub.archived_at !== null) {
      await tx.execute(sql`
        update hub_sync_reconciliation
        set status = 'cancelled', claim_owner = null, claim_token = null, lease_expires_at = null,
            last_outcome = 'cancelled', updated_at = clock_timestamp()
        where ${claimFence(claim)}
      `);
      return 'cancelled';
    }

    if (editorRows.length > 0) return deferClaimedCursor(tx, claim, 'active_editor');
    if (hub.version !== desired.observedArtifactVersion) {
      return deferClaimedCursor(tx, claim, 'artifact_version_changed');
    }
    if (!isValidHubDocument(desired.bodyBlocks)) {
      throw new HubSyncError(
        'invalid_document',
        'INVALID_DOCUMENT',
        'desired hub document is invalid',
      );
    }
    if (!desired.changed) return acknowledgeNoop(tx, claim, desired, 'acknowledged_noop');
    if (mode === 'shadow') return acknowledgeNoop(tx, claim, desired, 'shadowed');

    // Apply. The reconciler-owned body write MUST NOT self-dirty.
    await tx.execute(sql`set local app.hub_sync_internal_apply = '1'`);
    await tx.execute(sql`
      update hub_sync_reconciliation set status = 'applying', updated_at = clock_timestamp()
      where ${claimFence(claim)}
    `);

    await hooks.beforeStage?.('artifact');
    const appliedRows = await tx.execute<{ version: number }>(sql`
      update artifact
      set body_blocks = ${JSON.stringify(desired.bodyBlocks)}::jsonb,
          version = version + 1,
          updated_at = clock_timestamp()
      where id = ${claim.artifactId} and version = ${desired.observedArtifactVersion}
      returning version
    `);
    if (appliedRows.length !== 1) {
      throw new HubSyncError(
        'apply_validation_error',
        'ARTIFACT_CAS_FAILED',
        'artifact version CAS failed',
      );
    }
    const appliedVersion = appliedRows[0].version;

    await hooks.beforeStage?.('block_refs');
    await syncBlockRefsForArtifact(tx, claim.artifactId, desired.bodyBlocks);

    await hooks.beforeStage?.('event');
    await writeEvent(tx, {
      id: randomUUID(),
      session_id: null,
      actor_kind: 'system',
      actor_ref: ACTOR_REF,
      action: HUB_SYNC_APPLY_ACTION,
      subject_kind: 'artifact',
      subject_id: claim.artifactId,
      outcome: 'success',
      payload: {
        artifact_id: claim.artifactId,
        generation: claim.generation,
        desired_hash: desired.desiredHash,
        reason: 'hub_desired_state_reconciled',
        applied_artifact_version: appliedVersion,
      },
      caused_by_event_id: null,
      created_at: new Date(),
    });

    await hooks.beforeStage?.('ack');
    await tx.execute(sql`
      update hub_sync_reconciliation
      set status = 'acknowledged',
          acknowledged_generation = generation,
          acknowledged_at = clock_timestamp(),
          claim_owner = null, claim_token = null, lease_expires_at = null,
          consecutive_failure_count = 0,
          last_outcome = 'applied',
          last_desired_hash = ${desired.desiredHash},
          last_observed_artifact_version = ${desired.observedArtifactVersion},
          last_applied_artifact_version = ${appliedVersion},
          updated_at = clock_timestamp()
      where ${claimFence(claim)}
    `);
    return 'applied';
  });
}

async function deferClaimedCursor(
  tx: Tx,
  claim: HubSyncClaim,
  reason: 'active_editor' | 'artifact_version_changed',
): Promise<FinalizeOutcome> {
  // Release the claim back to pending WITHOUT touching consecutive_failure_count
  // (deferral and CAS conflict are non-failures).
  await tx.execute(sql`
    update hub_sync_reconciliation
    set status = 'pending', claim_owner = null, claim_token = null, lease_expires_at = null,
        next_attempt_at = clock_timestamp(), last_outcome = ${reason}, updated_at = clock_timestamp()
    where ${claimFence(claim)}
  `);
  return reason === 'active_editor' ? 'deferred_editing' : 'superseded';
}

async function acknowledgeNoop(
  tx: Tx,
  claim: HubSyncClaim,
  desired: HubDesiredState,
  outcome: 'acknowledged_noop' | 'shadowed',
): Promise<FinalizeOutcome> {
  await tx.execute(sql`
    update hub_sync_reconciliation
    set status = 'acknowledged',
        acknowledged_generation = generation,
        acknowledged_at = clock_timestamp(),
        claim_owner = null, claim_token = null, lease_expires_at = null,
        consecutive_failure_count = 0,
        last_outcome = ${outcome},
        last_desired_hash = ${desired.desiredHash},
        last_observed_artifact_version = ${desired.observedArtifactVersion},
        updated_at = clock_timestamp()
    where ${claimFence(claim)}
  `);
  return outcome;
}

function readHubSyncMode(): HubSyncMode {
  const raw = process.env.HUB_SYNC_MODE;
  return raw === 'apply' || raw === 'shadow' ? raw : 'off';
}

function emptyCycleResult(reason: HubSyncReason, mode: HubSyncMode): HubSyncCycleResult {
  return {
    reason,
    mode,
    claimed: 0,
    applied: 0,
    acknowledged_noop: 0,
    deferred_editing: 0,
    superseded: 0,
    retry_scheduled: 0,
    cancelled: 0,
    continuation_needed: false,
  };
}

async function hasReadyHubSync(db: Db): Promise<boolean> {
  const rows = await db.execute<{ ready: boolean }>(sql`
    select exists(
      select 1 from hub_sync_reconciliation
      where status in ('pending', 'retry_wait') and next_attempt_at <= clock_timestamp()
    ) as ready
  `);
  return rows[0]?.ready === true;
}

async function recordHubSyncRetry(
  db: Db,
  claim: HubSyncClaim,
  classified: ClassifiedHubSyncError,
): Promise<void> {
  // Backoff = min(5s * 2^(newFailureCount - 1), 15m) + 0–20% jitter. The SET
  // expression reads the pre-increment count, so exponent = old count.
  await db.execute(sql`
    update hub_sync_reconciliation
    set status = 'retry_wait',
        consecutive_failure_count = consecutive_failure_count + 1,
        next_attempt_at = clock_timestamp()
          + (least(5.0 * power(2.0, consecutive_failure_count), 900.0) * (1 + random() * 0.2)) * interval '1 second',
        claim_owner = null, claim_token = null, lease_expires_at = null,
        last_error_class = ${classified.errorClass},
        last_error_code = ${classified.code},
        last_error = ${truncateCodePoints(classified.message, LAST_ERROR_MAX_CODE_POINTS)},
        last_error_at = clock_timestamp(),
        last_outcome = 'retry',
        updated_at = clock_timestamp()
    where ${claimFence(claim)}
  `);
}

function tallyOutcome(result: HubSyncCycleResult, outcome: FinalizeOutcome): void {
  switch (outcome) {
    case 'applied':
      result.applied += 1;
      break;
    case 'acknowledged_noop':
      result.acknowledged_noop += 1;
      break;
    case 'deferred_editing':
      result.deferred_editing += 1;
      break;
    case 'superseded':
      result.superseded += 1;
      break;
    case 'cancelled':
      result.cancelled += 1;
      break;
    case 'shadowed':
      break;
  }
}

// A 30-second lease-renewal timer; if renewal ever returns false the claim was
// lost/superseded and compute/finalize must abort. Unref'd so it never keeps the
// process alive, and always cleared by the caller.
function startLeaseRenewal(db: Db, claim: HubSyncClaim): { lost: () => boolean; stop: () => void } {
  let lost = false;
  const timer = setInterval(() => {
    void renewHubSyncLease(db, claim).then((ok) => {
      if (!ok) lost = true;
    });
  }, 30_000);
  (timer as { unref?: () => void }).unref?.();
  return { lost: () => lost, stop: () => clearInterval(timer) };
}

async function reconcileClaim(
  db: Db,
  claim: HubSyncClaim,
  mode: HubSyncMode,
  result: HubSyncCycleResult,
): Promise<void> {
  const renewal = startLeaseRenewal(db, claim);
  try {
    const desired = await computeHubDesiredState(db, claim);
    if (renewal.lost()) return; // lost lease is a non-failure; another worker reclaims after expiry
    const outcome = await finalizeHubSync(db, { claim, desired, mode });
    tallyOutcome(result, outcome);
  } catch (err) {
    await recordHubSyncRetry(db, claim, classifyHubSyncError(err));
    result.retry_scheduled += 1;
  } finally {
    renewal.stop();
  }
}

// Test-only seam: pause each per-hub repair transaction right before it takes
// the artifact lock, so a lifecycle mutation can commit and be re-checked under
// lock (RED 20). Production callers omit it.
export interface RepairHubSyncHooks {
  beforeArtifactLock?: () => void | Promise<void>;
}

/**
 * Bounded, idempotent coverage repair (Task 7). Pages hub IDs ascending — every
 * cursor UNION every note_hub artifact, so cursors whose artifact was archived or
 * lost the hub type are also reconsidered. For each ID it takes the artifact
 * advisory lock, reloads the artifact and cursor under lock (never trusting the
 * page-scan snapshot), and — only when `last_repair_key IS DISTINCT FROM
 * repairKey` — dirties a live hub or cancels a non-live one, stamping the repair
 * key in the SAME write so a duplicate key is a no-op (RED 21). It NEVER computes
 * or applies desired body state; it only advances/cancels cursors.
 */
export async function repairHubSyncCoverage(
  db: Db,
  input: { repairKey: string; pageSize: number },
  hooks: RepairHubSyncHooks = {},
): Promise<{ dirtied: number; cancelled: number; hasMore: boolean }> {
  if (!/^nightly:\d{4}-\d{2}-\d{2}$/.test(input.repairKey)) {
    throw new Error(`invalid nightly repair key: ${input.repairKey}`);
  }
  const ids = await db.execute<{ id: string }>(sql`
    select id from (
      select artifact_id as id from hub_sync_reconciliation
      union
      select id from artifact where type = ${HUB_TYPE}
    ) coverage
    order by id
    limit ${input.pageSize}
  `);

  let dirtied = 0;
  let cancelled = 0;
  for (const { id } of ids) {
    const outcome = await db.transaction(async (tx) => {
      await hooks.beforeArtifactLock?.();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
      const hubRows = await tx.execute<{ type: string; archived_at: Date | null }>(sql`
        select type, archived_at from artifact where id = ${id} for update
      `);
      const hub = hubRows[0];
      const cursorRows = await tx.execute<{ last_repair_key: string | null }>(sql`
        select last_repair_key from hub_sync_reconciliation where artifact_id = ${id} for update
      `);
      const cursor = cursorRows[0];

      // Idempotent: this run already processed the ID.
      if (cursor && cursor.last_repair_key === input.repairKey) return 'skip' as const;

      const isLiveHub = hub !== undefined && hub.type === HUB_TYPE && hub.archived_at === null;
      if (isLiveHub) {
        await tx.execute(sql`
          insert into hub_sync_reconciliation (
            artifact_id, generation, status, next_attempt_at, last_dirty_at, updated_at, last_repair_key
          )
          values (${id}, 1, 'pending', clock_timestamp(), clock_timestamp(), clock_timestamp(), ${input.repairKey})
          on conflict (artifact_id) do update set
            generation = hub_sync_reconciliation.generation + 1,
            status = 'pending',
            claim_owner = null, claim_token = null, lease_expires_at = null,
            consecutive_failure_count = 0,
            next_attempt_at = clock_timestamp(), last_dirty_at = clock_timestamp(),
            updated_at = clock_timestamp(),
            last_repair_key = ${input.repairKey}
        `);
        return 'dirtied' as const;
      }

      if (cursor) {
        await tx.execute(sql`
          update hub_sync_reconciliation set
            generation = generation + 1, status = 'cancelled',
            claim_owner = null, claim_token = null, lease_expires_at = null,
            updated_at = clock_timestamp(), last_repair_key = ${input.repairKey}
          where artifact_id = ${id}
        `);
        return 'cancelled' as const;
      }
      return 'skip' as const;
    });
    if (outcome === 'dirtied') dirtied += 1;
    else if (outcome === 'cancelled') cancelled += 1;
  }
  return { dirtied, cancelled, hasMore: ids.length === input.pageSize };
}

/**
 * Minimal unified cycle (Task 4 scope): claim → compute → finalize up to
 * `maxArtifacts`, recording retries and continuation. Immediate wake, recovery,
 * and nightly repair all route here; Task 8 extends it with repair coverage
 * and continuation dispatch.
 */
export async function runHubSyncCycle(
  db: Db,
  options: HubSyncCycleOptions,
): Promise<HubSyncCycleResult> {
  const mode = options.mode ?? readHubSyncMode();
  const result = emptyCycleResult(options.reason, mode);
  if (mode === 'off') return result;

  const owner = options.owner ?? workerOwner();
  for (let index = 0; index < options.maxArtifacts; index += 1) {
    const claim = await claimNextHubSync(db, { owner });
    if (!claim) break;
    result.claimed += 1;
    await reconcileClaim(db, claim, mode, result);
  }
  result.continuation_needed = await hasReadyHubSync(db);
  return result;
}
