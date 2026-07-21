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
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
// Auto-zone builder + suppression reader live in a neutral module (YUK-384 Task 8
// ESM-cycle lift) so both the reconciler and the nightly job — which now imports
// runHubSyncCycle from here — depend on them without a cycle.
import {
  buildAutoZonePatch,
  normalizeMalformedAutoZoneContainer,
  suppressedArtifactIds,
} from '@/capabilities/notes/server/hub-auto-zone';
import { NoteRefineApplyError, applyNotePatch } from '@/core/blocks/apply-note-patch';
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
  // Test-only seam: fired after each per-claim reconcile so a test can commit a topology
  // mutation MID-cycle (e.g. between two claims) and assert the next hub reconciles
  // against a graph current as of ITS claim — not a stale cycle-start snapshot. Production
  // callers omit it.
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
  // Claimed but not processed to a finalize outcome: the lease was lost before finalize
  // (lost_lease) or recording the classified retry itself failed (retry_record_failed).
  // Counting them keeps `claimed` reconcilable with the sum of outcome buckets.
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
  // NoteRefineApplyError carries a BUSINESS code ('target_not_found' /
  // 'invalid_body_blocks' / 'user_verified_protected'), not a SQLSTATE. It was being
  // swept into pg_transient by the `.code` duck-type below, polluting the classification
  // taxonomy. Map it to a dedicated apply-validation class.
  if (err instanceof NoteRefineApplyError) {
    return { errorClass: 'apply_validation_error', code: err.code, message: err.message };
  }
  // Only a genuine Postgres error shape (5-char SQLSTATE, e.g. '40001') is pg_transient —
  // not any object that happens to expose a string `.code`.
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

// The tree/edges/atomics graph inputs. computeHubDesiredState loads these fresh per call
// by default; the optional param exists ONLY so a direct test can inject a controlled
// graph. runHubSyncCycle never passes it — each claim reloads fresh (see the revert of the
// per-cycle snapshot in runHubSyncCycle for why a shared snapshot was a stale-win).
export type HubMeshGraphInputs = {
  nodes: Awaited<ReturnType<typeof loadTreeSnapshot>>;
  edges: Awaited<ReturnType<typeof loadEdgeInputs>>;
  atomics: Awaited<ReturnType<typeof loadAtomicInputs>>;
};

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

  // Load the tree/edges/atomics graph FRESH (unless a test injects one) so the desired
  // state reflects topology as of THIS claim. A shared per-cycle snapshot was a stale-win:
  // a hub claimed at a mid-cycle-bumped generation would pass the write-side fence yet
  // compute from an older graph and apply a stale body (see runHubSyncCycle). The `graph`
  // param exists only for direct tests; runHubSyncCycle never passes it.
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

  // Poison-pill guard: heal a malformed auto-links container (missing/non-string id)
  // BEFORE building the patch, so the replace_block always targets an existing block
  // instead of throwing target_not_found → infinite retry. Compute the patch and the
  // desired body against the healed doc.
  const healed = normalizeMalformedAutoZoneContainer(hub.body_blocks, hub.id);
  const patch = buildAutoZonePatch(healed.bodyBlocks, hub.id, curated);
  // The reconciler IS the auto-zone owner (this is the system's own automatic region), so
  // it must be able to replace the auto-links container even if it carries user_verified
  // attrs — otherwise replace_block throws 'user_verified_protected' → permanent poison.
  // The guard defends USER-authored edits from AI refine jobs, a different caller.
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

// Ownership fence: generation + token + active-status, NO lease predicate. The per-claim
// token (a fresh randomUUID minted by claimNextHubSync on every claim/reclaim) is what
// actually proves ownership — a worker that reclaimed this cursor changed the token, so a
// stale writer matches 0 rows. Used by EVERY post-claim cursor write:
//   • finalize's in-transaction writes — additionally exclusive under the cursor row lock;
//   • recordHubSyncRetry — cross-transaction, protected by token rotation alone.
// The lease is deliberately NOT checked here. It is a CLAIM-ELIGIBILITY concept (which
// cursors claimNextHubSync may reclaim) and gates the INITIAL post-lock superseded decision
// — it is not a write-time guard. Checking it on writes caused two poison loops on a
// big-hub / slow-DB (degraded fsync): (1) finalize's apply (block-ref sync + event write)
// outran the ~2min lease → the ack matched 0 rows (the renewer is blocked on the same row
// lock) → ACK_FENCE_LOST rollback → re-claim → repeat; (2) after finalize threw, the
// lease-fenced recordHubSyncRetry matched 0 rows → no backoff / failure_count / last_error
// written → the reclaim arm saw only an expired lease → hot loop with blind alerts.
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
      // X1: previous body + history for the full-snapshot body_blocks_edit event (below).
      body_blocks: ArtifactBodyBlocksT;
      history: unknown[];
    }>(sql`
      select type, archived_at, version, body_blocks, history from artifact
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
      // The claim fence (generation/token/status/unexpired-lease) was lost between
      // the cursor lock and here (e.g. lease expired by database time). Roll the
      // whole apply back into a classified retry rather than proceeding.
      throw new HubSyncError(
        'apply_validation_error',
        'APPLYING_FENCE_LOST',
        'claim fence lost before applying',
      );
    }

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
    // X1: write a FULL-SNAPSHOT body_blocks_edit event (fork #1) so foldArtifact REPLAYS the
    // hub-sync apply. The op-replay note_refine_apply path is FORBIDDEN for new writes (B4 铁律,
    // artifact.ts) and would drift on the container-heal case (replaying ops on the un-healed
    // row body throws target_not_found). The old experimental:hub_sync_apply event was ignored
    // by the fold → projection rebuild reverted the hub body → fold≠row. Actor is
    // 'agent'/'hub_auto_sync' (an AI-curated structural write). generation/desiredHash live in
    // the cursor columns + the NDJSON attempt log (the body_blocks_edit payload is .strict()).
    // The reconciler UPDATE leaves `history` untouched, so history_after = the pre-apply history.
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
      created_at: new Date(),
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
      // Defense-in-depth: under a pathological >90s mid-transaction lease expiry the
      // body version-CAS can commit while the ack matches 0 rows. Throwing here rolls
      // the ENTIRE apply (body + block-refs + event + applying-set) back and reclassifies
      // as a retry, so we never return 'applied' without actually acknowledging.
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
  // Release the claim back to pending WITHOUT touching consecutive_failure_count
  // (deferral and CAS conflict are non-failures). For an ACTIVE EDITOR, back next_attempt_at
  // off by 30s — symmetric with the 30s active-session window — so an in-progress edit does
  // not trigger a tight ~100ms reclaim → full-KG reload → back-to-back continuation churn
  // loop; convergence still follows within ≤30s of the editor going idle.
  // artifact_version_changed stays `now`: it is a one-shot CAS condition and the body-change
  // trigger already re-dirtied the cursor, so an immediate re-claim converges the new body.
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

// Shadow re-observe backoff: after a shadow observation the claim is released back to
// pending but pushed OUT of the immediately-ready window by this interval. Without it a
// shadow cycle would re-claim the same never-draining hub every loop iteration and
// dispatch an endless continuation (hasReadyHubSync would stay true forever). A real
// topology change re-dirties via mark_hub_sync_dirty (next_attempt_at = now), and
// nightly repair re-dirties everything, so apply-mode convergence is never blocked by it.
// X3: kept at 2min — comfortably ≥ the 1-minute recovery tick (enough to stop the shadow
// hot loop) yet short enough that flipping shadow→apply converges shadow-observed hubs
// within ~2–3min (or immediately via one nightly repair / any topology change), so it no
// longer contradicts the ADR's per-minute recovery-drain cadence.
const SHADOW_REOBSERVE_BACKOFF = sql`interval '2 minutes'`;

// Shadow mode OBSERVES the desired state (records the hash/version for operators)
// WITHOUT applying it and, crucially, WITHOUT consuming the obligation: the claim is
// released back to pending with acknowledged_generation UNCHANGED. Advancing ack in
// shadow (the old acknowledgeNoop path) meant a shadow-period change was never applied
// after flipping to apply — recovery only claims pending/retry_wait, so the acknowledged
// cursor was skipped until the next topology change. Leaving it pending lets apply mode
// re-claim and converge it.
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
    shadowed: 0,
    lost_lease: 0,
    retry_record_failed: 0,
    continuation_needed: false,
  };
}

async function hasReadyHubSync(db: Db): Promise<boolean> {
  // Mirror claimNextHubSync's eligibility EXACTLY: pending/retry_wait past their
  // next_attempt_at OR claimed/applying whose lease has expired (reclaimable). Missing
  // the expired-lease arm made continuation_needed under-report a backlog of dead-lease
  // cursors, so a stuck batch would not trigger the continuation that drains it.
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
  // Backoff = min(5s * 2^(newFailureCount - 1), 15m) + 0–20% jitter. The SET
  // expression reads the pre-increment count, so exponent = old count = new-1.
  // `now()` (statement-stable) anchors BOTH next_attempt_at and last_error_at so
  // their difference is exactly the scheduled delay (deterministic for tests).
  // Fenced on token (NOT lease): finalize may throw AFTER a long apply expired the lease,
  // and this write runs post-rollback; the token still proves we own the claim (a reclaim
  // would have rotated it). Returns the rowcount so the caller only tallies a scheduled
  // retry when the write actually landed.
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

// A 30-second lease-renewal timer; if renewal ever returns false the claim was
// lost/superseded and compute/finalize must abort. Unref'd so it never keeps the
// process alive, and always cleared by the caller.
function startLeaseRenewal(db: Db, claim: HubSyncClaim): { lost: () => boolean; stop: () => void } {
  let lost = false;
  const timer = setInterval(() => {
    void renewHubSyncLease(db, claim)
      .then((ok) => {
        if (!ok) lost = true;
      })
      .catch(() => {
        // A rejected renewal query (transient DB error) must NOT surface as an
        // unhandled promise rejection — under `--unhandled-rejections=throw` that
        // crashes the worker. Treat a failed renewal as a lost lease: compute/finalize
        // aborts and another worker reclaims after the lease expires.
        lost = true;
      });
  }, 30_000);
  (timer as { unref?: () => void }).unref?.();
  return { lost: () => lost, stop: () => clearInterval(timer) };
}

// One structured line per attempt for operators — ids + metadata ONLY, never
// document bodies. NDJSON on stdout so the worker log ships it verbatim.
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
    // Load fresh per claim (NOT a per-cycle snapshot) — see runHubSyncCycle for why.
    const desired = await computeHubDesiredState(db, claim);
    if (renewal.lost()) {
      // Lost lease is a non-failure; another worker reclaims after expiry. Count it so
      // `claimed` reconciles (we already incremented claimed but produce no finalize outcome).
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
        // The claim was superseded (token rotated by a reclaim) before we could record the
        // retry — a non-failure supersession, not a scheduled retry. Do not over-count.
        outcome = 'superseded';
        result.superseded += 1;
      }
    } catch (retryErr) {
      // Recording the retry is itself a DB write and can fail transiently. It must NOT
      // escape reconcileClaim — otherwise the cycle's for-loop (which has no per-claim
      // guard) aborts and every OTHER claimed hub is abandoned until its lease expires.
      // Log and move on; this hub's lease expires and another worker reclaims it.
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
  input: { repairKey: string; pageSize: number; afterId?: string | null },
  hooks: RepairHubSyncHooks = {},
): Promise<{ dirtied: number; cancelled: number; hasMore: boolean; lastId: string | null }> {
  if (!/^nightly:\d{4}-\d{2}-\d{2}$/.test(input.repairKey)) {
    throw new Error(`invalid nightly repair key: ${input.repairKey}`);
  }
  // KEYSET page: scan strictly past the last id the previous page returned. Without
  // this the `order by id limit pageSize` scan returns the same head every call, so
  // hubs beyond pageSize are never dirtied/cancelled and coverage repair is not
  // convergent. The caller (nightly path) loops pages until hasMore is false.
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

// Bounded guard so a pathological coverage set (or a stuck cursor) can never spin the
// nightly page loop forever. pageSize is maxArtifacts (default 25); 10_000 pages is
// ~250k artifacts — orders of magnitude above any real hub population for this tool.
const MAX_NIGHTLY_REPAIR_PAGES = 10_000;

// Abandoned editor sessions older than this are swept by the nightly job. Far larger
// than the 30s active-session window so a session merely between heartbeats is never
// deleted; only genuinely abandoned rows (browser crash → no blur) are reaped.
const ABANDONED_EDIT_SESSION_TTL = sql`interval '1 hour'`;

/**
 * Presence hygiene (bounded, best-effort): abandoned artifact_edit_session rows (browser
 * crash → no blur) are never deleted and bloat the table. The 30s active window keeps them
 * from reading as active, so this is cleanup-only. Runs from the NIGHTLY JOB, NOT gated by
 * HUB_SYNC_MODE — presence hygiene must continue even when the reconciler is 'off' or rolled
 * back, or zombie rows grow unbounded exactly in the disabled state. A sweep failure must
 * never abort the caller.
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

  // Nightly repair sweeps coverage FIRST (dirties/cancels cursors), then the same
  // claim→compute→finalize loop converges them. No scheduled path applies directly.
  if (options.reason === 'nightly_repair') {
    if (!options.repairKey) throw new Error('nightly_repair requires repairKey');
    // LOOP keyset pages until the coverage set is exhausted, so EVERY live hub is
    // dirtied/cancelled even when the population exceeds one page. Bounded by
    // MAX_NIGHTLY_REPAIR_PAGES against runaway.
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
    // Each claim reloads the tree/edges/atomics graph fresh inside computeHubDesiredState.
    // A per-cycle snapshot was a MEDIUM stale-win: a hub claimed at a generation bumped by a
    // mid-cycle topology commit passes the write-side generation/token/lease fence (its claim
    // was taken at the new generation) yet computes its body from the STALE cycle-start graph
    // → applies a stale body and acks the bump (GUC suppression prevents self-dirty),
    // persisting staleness until the ≤24h nightly. The fence guards the write side, not
    // read-side graph freshness. Reloading per claim keeps the desired state consistent with
    // the topology as of the claim (the exact stale-win this reconciler exists to prevent).
    try {
      await reconcileClaim(db, claim, options.reason, mode, result);
    } catch (err) {
      // Defense-in-depth: reconcileClaim handles its own errors, but one hub's
      // unexpected throw must never abort the whole cycle and abandon the rest.
      // Worst case is this hub's lease expiring and being reclaimed — not a cycle abort.
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
