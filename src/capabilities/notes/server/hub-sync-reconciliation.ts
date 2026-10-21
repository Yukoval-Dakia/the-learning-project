// Durable hub-sync reconciliation. One cursor per hub; a worker claims one ready
// cursor at a time (never a batch tail) and holds a lease renewed every 30s.
// Generations are bigint and cross into TypeScript as decimal strings.

import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { sql } from 'drizzle-orm';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
// Shared with the nightly job without an import cycle.
import {
  buildAutoZonePatch,
  normalizeMalformedAutoZoneContainer,
  suppressedArtifactIds,
} from '@/capabilities/notes/server/hub-auto-zone';
import { NoteRefineApplyError, applyNotePatch } from '@/core/blocks/apply-note-patch';
import { getConfig } from '@/core/config/store';
import { ArtifactBodyBlocks, type ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import {
  type HubMeshAtomicInput,
  type HubMeshEdge,
  resolveHubMeshAtomics,
} from '@/kernel/hub-mesh';
import { listKnowledgeMeshEdges, loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';

export interface HubSyncClaim {
  artifactId: string;
  generation: string;
  claimToken: string;
  claimOwner: string;
  leaseExpiresAt: Date;
}

/**
 * Claim the single most-eligible cursor, or null. Eligible means due
 * pending/retry_wait or an expired claimed/applying lease. SKIP LOCKED + LIMIT 1
 * keeps two workers off one generation and avoids pre-leasing a tail.
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
 * Extend the lease, fencing on id + generation + token, active status, and an
 * unexpired lease. False means the claim was lost and compute/finalize must stop.
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
  // Test seam: runs after each claim so a test can mutate topology mid-cycle and
  // assert the next claim sees it.
  afterReconcile?: (claim: HubSyncClaim) => void | Promise<void>;
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
  shadowed: number;
  // Claimed without a finalize outcome: lost lease or a failed retry record.
  // Counted so the buckets reconcile with `claimed`.
  lost_lease: number;
  retry_record_failed: number;
  continuation_needed: boolean;
}

export type FinalizeOutcome =
  | 'applied'
  | 'acknowledged_noop'
  | 'deferred_editing'
  | 'superseded'
  | 'cancelled'
  | 'shadowed';

// Fault-injection seams for atomicity and concurrency tests.
type ApplyStage = 'artifact' | 'block_refs' | 'event' | 'ack';
export interface FinalizeHubSyncHooks {
  afterCursorLock?: () => void | Promise<void>;
  beforeStage?: (stage: ApplyStage) => void | Promise<void>;
}

const HUB_TYPE = 'note_hub';
const ATOMIC_TYPE = 'note_atomic';
const ACTOR_REF = 'hub_auto_sync';
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
 * All failures are retryable; there is no terminal discard. Known errors carry a
 * class; PostgreSQL surfaces as transient; anything else is unknown.
 */
export function classifyHubSyncError(err: unknown): ClassifiedHubSyncError {
  if (err instanceof HubSyncError) {
    return { errorClass: err.errorClass, code: err.code, message: err.message };
  }
  // A business code, not a SQLSTATE; keep it out of pg_transient.
  if (err instanceof NoteRefineApplyError) {
    return { errorClass: 'apply_validation_error', code: err.code, message: err.message };
  }
  // Require a real SQLSTATE shape, not any object with a string `.code`.
  const pgCode = (err as { code?: unknown } | null)?.code;
  if (typeof pgCode === 'string' && /^[0-9A-Z]{5}$/.test(pgCode)) {
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

// Key-sorted so the desired hash ignores object key order.
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

// `type` gives the implicit index signature drizzle's execute row constraint needs.
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
  const rows = await listKnowledgeMeshEdges(db);
  return rows.map((r) => ({
    from_knowledge_id: r.from_knowledge_id,
    to_knowledge_id: r.to_knowledge_id,
    relation_type: r.relation_type,
  }));
}

// The graph inputs. computeHubDesiredState reloads them per call; the optional
// parameter exists only for direct tests.
export type HubMeshGraphInputs = {
  nodes: Awaited<ReturnType<typeof loadTreeSnapshot>>;
  edges: Awaited<ReturnType<typeof loadEdgeInputs>>;
  atomics: Awaited<ReturnType<typeof loadAtomicInputs>>;
};

/**
 * Recompute the hub's desired body deterministically outside any lock, honouring
 * suppressions like the nightly path. `changed` means a patch was produced; the
 * patch itself is never stored.
 */
export async function computeHubDesiredState(
  db: Db,
  claim: HubSyncClaim,
  graph?: HubMeshGraphInputs,
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

  // Reload per claim so the desired state reflects topology as of this claim. A
  // shared cycle-start snapshot would pass the write fence yet apply a stale body.
  const { nodes, edges, atomics } = graph ?? {
    nodes: await loadTreeSnapshot(db),
    edges: await loadEdgeInputs(db),
    atomics: await loadAtomicInputs(db),
  };

  const suppressed = suppressedArtifactIds(hub.attrs);
  const curated = resolveHubMeshAtomics(
    nodes,
    edges,
    { hub_artifact_id: hub.id, knowledge_ids: hub.knowledge_ids ?? [] },
    atomics,
  ).filter((candidate) => !suppressed.has(candidate.artifact_id));

  // Heal a malformed container first, or the replace can never match and the hub
  // retries forever. Build the patch against the healed doc.
  const healed = normalizeMalformedAutoZoneContainer(hub.body_blocks, hub.id);
  const patch = buildAutoZonePatch(healed.bodyBlocks, hub.id, curated);
  // This is the system's own auto region, so it may replace the container even if
  // marked verified; the guard protects user edits from AI refine, a different caller.
  const bodyBlocks = (
    patch
      ? applyNotePatch(healed.bodyBlocks, patch, { enforceUserVerifiedGuard: false })
      : healed.bodyBlocks
  ) as ArtifactBodyBlocksT;

  return {
    artifactId: hub.id,
    observedArtifactVersion: hub.version,
    bodyBlocks,
    desiredHash: createHash('sha256').update(stableStringify(bodyBlocks)).digest('hex'),
    // `healed` counts as a change so the id fix is persisted on the next apply.
    changed: patch !== null || healed.healed,
  };
}

// Ownership fence: generation + token + active status, never the lease. The
// per-claim token proves ownership because any reclaim rotates it. The lease is
// a claim-eligibility concept; fencing writes on it caused poison loops on slow
// applies (ack matched 0 rows, then retries lost their backoff).
function claimTokenFence(claim: HubSyncClaim) {
  return sql`
    artifact_id = ${claim.artifactId}
    and generation = ${claim.generation}::bigint
    and claim_token = ${claim.claimToken}
    and status in ('claimed', 'applying')
  `;
}

type CursorLockRow = {
  generation: string;
  claim_token: string | null;
  status: string;
  lease_expired: boolean;
};

/**
 * The fenced finalization transaction. Lock order: advisory → artifact → cursor →
 * edit-session read. Every mutating branch carries the claim fence, so a
 * concurrent win turns it into a no-op.
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
      // The before body and history ride the full-snapshot event below.
      body_blocks: ArtifactBodyBlocksT;
      history: unknown[];
    }>(sql`
      select type, archived_at, version, body_blocks, history from artifact
      where id = ${claim.artifactId} for update
    `);
    const hub = hubRows[0];

    // Read database time after the lock wait so lease expiry uses the same instant.
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
        where ${claimTokenFence(claim)}
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
    if (mode === 'shadow') return observeShadowNoApply(tx, claim, desired);

    // Apply. The reconciler-owned body write MUST NOT self-dirty.
    await tx.execute(sql`set local app.hub_sync_internal_apply = '1'`);
    const applyingRows = await tx.execute<{ artifact_id: string }>(sql`
      update hub_sync_reconciliation set status = 'applying', updated_at = clock_timestamp()
      where ${claimTokenFence(claim)}
      returning artifact_id
    `);
    if (applyingRows.length !== 1) {
      // Fence lost after the cursor lock: roll the apply back into a classified retry.
      throw new HubSyncError(
        'apply_validation_error',
        'APPLYING_FENCE_LOST',
        'claim fence lost before applying',
      );
    }

    await hooks.beforeStage?.('artifact');
    // One millisecond database timestamp for the row and its event; a second clock
    // after block-ref work made replay change updated_at.
    const appliedRows = await tx.execute<{ version: number; updated_at: Date | string }>(sql`
      update artifact
      set body_blocks = ${JSON.stringify(desired.bodyBlocks)}::jsonb,
          version = version + 1,
          updated_at = greatest(
            date_trunc('milliseconds', clock_timestamp()),
            date_trunc('milliseconds', updated_at) + interval '1 millisecond'
          )
      where id = ${claim.artifactId} and version = ${desired.observedArtifactVersion}
      returning version, updated_at
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
    // Full-snapshot event, not op replay: the heal case would not replay cleanly,
    // and the fold must reproduce the body. History is untouched, so carry the
    // pre-apply value.
    await writeEvent(tx, {
      id: randomUUID(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: ACTOR_REF,
      action: 'experimental:body_blocks_edit',
      subject_kind: 'artifact',
      subject_id: claim.artifactId,
      outcome: 'success',
      payload: {
        previous_artifact_version: desired.observedArtifactVersion,
        next_artifact_version: appliedVersion,
        body_blocks: desired.bodyBlocks,
        previous_body_blocks: hub.body_blocks,
        history_after: hub.history,
      },
      caused_by_event_id: null,
      created_at: new Date(appliedRows[0].updated_at),
    });

    await hooks.beforeStage?.('ack');
    const ackRows = await tx.execute<{ artifact_id: string }>(sql`
      update hub_sync_reconciliation
      set status = 'acknowledged',
          acknowledged_generation = generation,
          acknowledged_at = clock_timestamp(),
          claim_owner = null, claim_token = null, lease_expires_at = null,
          consecutive_failure_count = 0,
          -- Success convergence: clear the last_error_* so they mean "most recent STILL-
          -- UNRESOLVED failure". Otherwise a hub that recovered from invalid_document (or
          -- any error) keeps last_error_class set forever → permanent false invalid_document
          -- backlog gauges / operator alerts.
          last_error_class = null, last_error_code = null, last_error = null, last_error_at = null,
          last_outcome = 'applied',
          last_desired_hash = ${desired.desiredHash},
          last_observed_artifact_version = ${desired.observedArtifactVersion},
          last_applied_artifact_version = ${appliedVersion},
          updated_at = clock_timestamp()
      where ${claimTokenFence(claim)}
      returning artifact_id
    `);
    if (ackRows.length !== 1) {
      // A pathological mid-transaction lease expiry can commit the body while the ack
      // matches 0 rows. Throw so the whole apply rolls back and retries.
      throw new HubSyncError(
        'apply_validation_error',
        'ACK_FENCE_LOST',
        'claim fence lost before ack (lease expiry mid-apply)',
      );
    }
    return 'applied';
  });
}

async function deferClaimedCursor(
  tx: Tx,
  claim: HubSyncClaim,
  reason: 'active_editor' | 'artifact_version_changed',
): Promise<FinalizeOutcome> {
  // Deferrals are not failures, so the failure count is untouched. An active
  // editor waits 30s (the active-session window) to avoid a reclaim/reload churn
  // loop; a version change retries immediately because the trigger re-dirtied it.
  const nextAttempt =
    reason === 'active_editor'
      ? sql`clock_timestamp() + interval '30 seconds'`
      : sql`clock_timestamp()`;
  await tx.execute(sql`
    update hub_sync_reconciliation
    set status = 'pending', claim_owner = null, claim_token = null, lease_expires_at = null,
        next_attempt_at = ${nextAttempt}, last_outcome = ${reason}, updated_at = clock_timestamp()
    where ${claimTokenFence(claim)}
  `);
  return reason === 'active_editor' ? 'deferred_editing' : 'superseded';
}

async function acknowledgeNoop(
  tx: Tx,
  claim: HubSyncClaim,
  desired: HubDesiredState,
  outcome: 'acknowledged_noop',
): Promise<FinalizeOutcome> {
  await tx.execute(sql`
    update hub_sync_reconciliation
    set status = 'acknowledged',
        acknowledged_generation = generation,
        acknowledged_at = clock_timestamp(),
        claim_owner = null, claim_token = null, lease_expires_at = null,
        consecutive_failure_count = 0,
        -- Success convergence (valid no-op): clear last_error_* so a recovered hub stops
        -- being counted as a live failure (see the apply-success ack for the full rationale).
        last_error_class = null, last_error_code = null, last_error = null, last_error_at = null,
        last_outcome = ${outcome},
        last_desired_hash = ${desired.desiredHash},
        last_observed_artifact_version = ${desired.observedArtifactVersion},
        updated_at = clock_timestamp()
    where ${claimTokenFence(claim)}
  `);
  return outcome;
}

// Pushes a shadow-observed cursor out of the ready window so it cannot re-claim in
// a hot loop. 2min is above the 1min recovery tick yet lets an apply flip converge
// soon; any real topology change or nightly repair re-dirties immediately.
const SHADOW_REOBSERVE_BACKOFF = sql`interval '2 minutes'`;

// Shadow mode records the desired hash/version without applying and without
// consuming the obligation: the cursor stays pending with the same acknowledged
// generation, so apply mode can still claim and converge it.
async function observeShadowNoApply(
  tx: Tx,
  claim: HubSyncClaim,
  desired: HubDesiredState,
): Promise<FinalizeOutcome> {
  await tx.execute(sql`
    update hub_sync_reconciliation
    set status = 'pending', claim_owner = null, claim_token = null, lease_expires_at = null,
        next_attempt_at = clock_timestamp() + ${SHADOW_REOBSERVE_BACKOFF},
        -- Shadow observation happens AFTER the validity check, so the desired doc is proven
        -- valid here. Clear the diagnostic state symmetrically with the two success acks: a
        -- hub that previously failed (e.g. invalid_document) but now computes a valid doc must
        -- not keep inflating invalid_document_count / max_consecutive_failure_count while in
        -- shadow. The obligation is untouched (acknowledged_generation unchanged, status still
        -- pending); if apply mode later fails, recordHubSyncRetry re-flags it.
        consecutive_failure_count = 0,
        last_error_class = null, last_error_code = null, last_error = null, last_error_at = null,
        last_outcome = 'shadowed',
        last_desired_hash = ${desired.desiredHash},
        last_observed_artifact_version = ${desired.observedArtifactVersion},
        updated_at = clock_timestamp()
    where ${claimTokenFence(claim)}
  `);
  return 'shadowed';
}

export function readHubSyncMode(): HubSyncMode {
  const raw = getConfig('HUB_SYNC_MODE');
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
    shadowed: 0,
    lost_lease: 0,
    retry_record_failed: 0,
    continuation_needed: false,
  };
}

async function hasReadyHubSync(db: Db): Promise<boolean> {
  // Must match claimNextHubSync's eligibility, including expired leases, or a
  // dead-lease backlog would not trigger the continuation that drains it.
  const rows = await db.execute<{ ready: boolean }>(sql`
    select exists(
      select 1 from hub_sync_reconciliation
      where (
        status in ('pending', 'retry_wait') and next_attempt_at <= clock_timestamp()
      ) or (
        status in ('claimed', 'applying') and lease_expires_at < clock_timestamp()
      )
    ) as ready
  `);
  return rows[0]?.ready === true;
}

export async function recordHubSyncRetry(
  db: Db,
  claim: HubSyncClaim,
  classified: ClassifiedHubSyncError,
): Promise<number> {
  // Exponential backoff with jitter; the SET sees the pre-increment count, so the
  // exponent is the old count. now() anchors both timestamps so the delay is exact.
  // Fenced on token, not lease: this runs after a failed apply whose lease may have
  // expired, but a rotated token still proves the claim was lost.
  const rows = await db.execute<{ artifact_id: string }>(sql`
    update hub_sync_reconciliation
    set status = 'retry_wait',
        consecutive_failure_count = consecutive_failure_count + 1,
        next_attempt_at = now()
          + (least(5.0 * power(2.0, consecutive_failure_count), 900.0) * (1 + random() * 0.2)) * interval '1 second',
        claim_owner = null, claim_token = null, lease_expires_at = null,
        last_error_class = ${classified.errorClass},
        last_error_code = ${classified.code},
        last_error = ${truncateCodePoints(classified.message, LAST_ERROR_MAX_CODE_POINTS)},
        last_error_at = now(),
        last_outcome = 'retry',
        updated_at = clock_timestamp()
    where ${claimTokenFence(claim)}
    returning artifact_id
  `);
  return rows.length;
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
      result.shadowed += 1;
      break;
  }
}

// Renew every 30s. A false renewal means the claim is lost and the cycle must
// abort. Unref'd so it never holds the process open.
function startLeaseRenewal(db: Db, claim: HubSyncClaim): { lost: () => boolean; stop: () => void } {
  let lost = false;
  const timer = setInterval(() => {
    void renewHubSyncLease(db, claim)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {
        // A rejected renewal must not become an unhandled rejection (which crashes
        // the worker); treat it as a lost lease.
        lost = true;
      });
  }, 30_000);
  (timer as { unref?: () => void }).unref?.();
  return { lost: () => lost, stop: () => clearInterval(timer) };
}

// One structured line per attempt, ids and metadata only, never bodies.
function logHubSyncAttempt(entry: {
  artifact_id: string;
  generation: string;
  claim_token: string;
  reason: HubSyncReason;
  mode: HubSyncMode;
  outcome: string;
  duration_ms: number;
  error_class: string | null;
}): void {
  console.log(JSON.stringify({ event: 'hub_sync_attempt', ...entry }));
}

async function reconcileClaim(
  db: Db,
  claim: HubSyncClaim,
  reason: HubSyncReason,
  mode: HubSyncMode,
  result: HubSyncCycleResult,
): Promise<void> {
  const renewal = startLeaseRenewal(db, claim);
  const startedAt = Date.now();
  let outcome = 'lost_lease';
  let errorClass: string | null = null;
  try {
    // Fresh graph per claim, not per cycle; see computeHubDesiredState.
    const desired = await computeHubDesiredState(db, claim);
    if (renewal.lost()) {
      // Non-failure; another worker reclaims after expiry.
      result.lost_lease += 1;
      return;
    }
    outcome = await finalizeHubSync(db, { claim, desired, mode });
    tallyOutcome(result, outcome as FinalizeOutcome);
  } catch (err) {
    const classified = classifyHubSyncError(err);
    errorClass = classified.errorClass;
    outcome = 'retry_wait';
    try {
      const scheduled = await recordHubSyncRetry(db, claim, classified);
      if (scheduled > 0) {
        result.retry_scheduled += 1;
      } else {
        // A rotated token means a reclaim won; count it as superseded, not retried.
        outcome = 'superseded';
        result.superseded += 1;
      }
    } catch (retryErr) {
      // This write can fail transiently. It must not escape, or one hub aborts the
      // whole cycle; the other claims would wait for their leases.
      outcome = 'retry_record_failed';
      result.retry_record_failed += 1;
      console.error(
        JSON.stringify({
          event: 'hub_sync_retry_record_failed',
          artifact_id: claim.artifactId,
          generation: claim.generation,
          error: retryErr instanceof Error ? retryErr.message : String(retryErr),
        }),
      );
    }
  } finally {
    renewal.stop();
    logHubSyncAttempt({
      artifact_id: claim.artifactId,
      generation: claim.generation,
      claim_token: claim.claimToken,
      reason,
      mode,
      outcome,
      duration_ms: Date.now() - startedAt,
      error_class: errorClass,
    });
  }
}

// Test seam: pause before the artifact lock so a test can race a lifecycle change.
export interface RepairHubSyncHooks {
  beforeArtifactLock?: () => void | Promise<void>;
}

/**
 * Bounded, idempotent coverage repair: page ids (cursors ∪ hub artifacts), then
 * under the artifact lock dirty a live hub or cancel a dead one, stamping the
 * repair key in the same write. Never computes or applies a body.
 */
export async function repairHubSyncCoverage(
  db: Db,
  input: { repairKey: string; pageSize: number; afterId?: string | null },
  hooks: RepairHubSyncHooks = {},
): Promise<{ dirtied: number; cancelled: number; hasMore: boolean; lastId: string | null }> {
  if (!/^nightly:\d{4}-\d{2}-\d{2}$/.test(input.repairKey)) {
    throw new Error(`invalid nightly repair key: ${input.repairKey}`);
  }
  // Keyset page past the last id, or every call returns the same head and coverage
  // never converges. The caller loops until hasMore is false.
  const afterId = input.afterId ?? null;
  const ids = await db.execute<{ id: string }>(sql`
    select id from (
      select artifact_id as id from hub_sync_reconciliation
      union
      select id from artifact where type = ${HUB_TYPE}
    ) coverage
    where ${afterId === null ? sql`true` : sql`id > ${afterId}`}
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
  const lastId = ids.length > 0 ? ids[ids.length - 1].id : null;
  return { dirtied, cancelled, hasMore: ids.length === input.pageSize, lastId };
}

// Guard against a pathological coverage set spinning the nightly page loop.
const MAX_NIGHTLY_REPAIR_PAGES = 10_000;

// Far above the 30s active window, so only truly abandoned sessions are reaped.
const ABANDONED_EDIT_SESSION_TTL = sql`interval '1 hour'`;

/**
 * Best-effort cleanup of abandoned edit sessions. Runs from the nightly job, not
 * gated by HUB_SYNC_MODE, so rows are still reaped while the reconciler is off. A
 * sweep failure is logged, never thrown.
 */
export async function sweepAbandonedEditSessions(db: Db): Promise<void> {
  try {
    await db.execute(sql`
      delete from artifact_edit_session
      where last_heartbeat_at < clock_timestamp() - ${ABANDONED_EDIT_SESSION_TTL}
    `);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'hub_sync_abandoned_session_sweep_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Claim → compute → finalize up to maxArtifacts. Wake, recovery, and nightly
 * repair all route here.
 */
export async function runHubSyncCycle(
  db: Db,
  options: HubSyncCycleOptions,
): Promise<HubSyncCycleResult> {
  const mode = options.mode ?? readHubSyncMode();
  const result = emptyCycleResult(options.reason, mode);
  if (mode === 'off') return result;

  // Nightly coverage first, then the same loop converges what it dirtied.
  if (options.reason === 'nightly_repair') {
    if (!options.repairKey) throw new Error('nightly_repair requires repairKey');
    // Page until exhausted, bounded against runaway.
    let afterId: string | null = null;
    for (let page = 0; page < MAX_NIGHTLY_REPAIR_PAGES; page += 1) {
      const { hasMore, lastId } = await repairHubSyncCoverage(db, {
        repairKey: options.repairKey,
        pageSize: options.maxArtifacts,
        afterId,
      });
      if (!hasMore) break;
      afterId = lastId;
    }
  }

  const owner = options.owner ?? workerOwner();
  for (let index = 0; index < options.maxArtifacts; index += 1) {
    const claim = await claimNextHubSync(db, { owner });
    if (!claim) break;
    result.claimed += 1;
    // The graph is reloaded per claim. A cycle-start snapshot could pass the write
    // fence yet compute from older topology, persisting staleness until the nightly.
    try {
      await reconcileClaim(db, claim, options.reason, mode, result);
    } catch (err) {
      // Defensive: reconcileClaim handles its own errors, but one unexpected throw
      // must not abandon the rest of the batch.
      console.error(
        JSON.stringify({
          event: 'hub_sync_reconcile_uncaught',
          artifact_id: claim.artifactId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    await options.afterReconcile?.(claim);
  }
  result.continuation_needed = await hasReadyHubSync(db);
  return result;
}
