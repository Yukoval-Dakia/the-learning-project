// Batch-undo orchestration for strength-A auto-applied proposals.
//
// Kernel owns the batch mechanics only: the proposal/apply ledger, proposal-level
// eligibility (auto-applied, batchable kind, applied, not superseded), the
// four-state report and the reverse-causal ordering (batch-retract). The
// domain question — "has later content used this effect?" — belongs to the owner
// of that content, so each batchable kind is dispatched to a guard its owner
// installed through `installAutoAppliedUndoGuardRegistry` at host startup. A new
// auto-apply kind adds its guard beside its accept/retract appliers; the kernel
// is untouched.
//
//   revertable — the owner reported no dependent content; the retract applier
//                restores the pre-apply state
//   blocked    — an owner reported later content that depends on the effect
//   reverted   — a retract correction already landed (idempotent retry)
//   failed     — the proposal or its apply record cannot be read
//
// `clears_in_batch` marks the one block an earlier item of the same batch can
// remove (a child node the batch itself retracts first). Everything else is
// reported before the batch opens a transaction, so a doomed item never starts
// one.

import { and, desc, eq, inArray } from 'drizzle-orm';

import { type AiProposalPayloadT, parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';
import { findExistingRateEvent } from './applier-helpers';
import { PROPOSAL_AUTOAPPLY_ACTION } from './auto-apply';

export type DbLike = Db | Tx;

export type AutoAppliedUndoStatus = 'revertable' | 'blocked' | 'reverted' | 'failed';

/** One owner guard's refusal for one applied item. */
export interface AutoAppliedUndoBlock {
  readonly status: 'blocked' | 'failed';
  /** Stable machine code for the UI; the owner owns its vocabulary. */
  readonly code: string;
  /** Learner-facing explanation; never contains ids, field names or tool names. */
  readonly reason_md: string;
  /**
   * True only when an earlier item of the same batch can clear this block
   * (a child node this batch retracts before its parent). Defaults to a
   * permanent block.
   */
  readonly clears_in_batch?: true;
}

/** What an owner guard reads: the applied proposal plus the owner's apply facts. */
export interface AutoAppliedUndoGuardInput {
  readonly proposalId: string;
  readonly payload: AiProposalPayloadT;
  /** Latest decision rate payload; the owner reads its own materialization facts from it. */
  readonly ratePayload: unknown;
  /** Latest decision rate time: apply time for ordering and "later content" comparisons. */
  readonly appliedAt: Date;
}

/**
 * Inspect a batch of same-kind items. Missing ids mean "no later content"; an
 * owner that cannot read its apply facts reports `failed` instead.
 */
export type AutoAppliedUndoInspect = (
  db: DbLike,
  inputs: readonly AutoAppliedUndoGuardInput[],
) => Promise<Map<string, AutoAppliedUndoBlock>>;

/** Later-content rules for one batchable proposal kind, owned with the content. */
export interface AutoAppliedUndoOwnerGuard {
  /**
   * Whether this proposal's accept path may enter batch undo at all. Runs before
   * the applied/rate gates; a refusal is reported without touching owner rows.
   */
  readonly eligible?: (payload: AiProposalPayloadT) => AutoAppliedUndoBlock | null;
  readonly inspect: AutoAppliedUndoInspect;
  /**
   * Lock the owner rows the retract applier will mutate. Runs inside the retract
   * transaction, after the proposal decision lock, before `inspect`.
   */
  readonly lock?: (tx: Tx, input: AutoAppliedUndoGuardInput) => Promise<void>;
}

export type AutoAppliedUndoGuardRegistry = ReadonlyMap<string, AutoAppliedUndoOwnerGuard>;

export interface AutoAppliedUndoDecision {
  readonly status: AutoAppliedUndoStatus;
  /** Stable machine code for the UI; null exactly when revertable or reverted. */
  readonly code: string | null;
  /** Learner-facing explanation; never contains ids, field names or tool names. */
  readonly reason_md: string | null;
  /** Existing retract correction when status === 'reverted'. */
  readonly correction_event_id: string | null;
  /** Apply time (accept rate) when readable; used for reverse-causal ordering. */
  readonly applied_at: Date | null;
  /** True when an earlier item of the same batch may clear this block. */
  readonly clears_in_batch: boolean;
}

const GENERIC_REASONS = {
  proposal_not_found: '找不到这条改动。',
  payload_unreadable: '这条改动的内容读不出来，暂时不能撤销。',
  not_auto_applied: '这不是自动应用的改动，需要在收件箱里逐条处理。',
  kind_not_batchable: '这类自动改动暂不支持一键批量撤销。',
  not_applied: '这条改动还没有被应用，不需要撤销。',
  superseded: '这条改动已经被后续更正取代，不能再撤销。',
  apply_record_missing: '这条改动缺少应用记录，暂时不能撤销。',
} as const;

export type GenericUndoCode = keyof typeof GENERIC_REASONS;

/** Owner guards reuse the kernel's copy for proposal-level failures. */
export function genericUndoBlock(
  status: AutoAppliedUndoBlock['status'],
  code: GenericUndoCode,
): AutoAppliedUndoBlock {
  return { status, code, reason_md: GENERIC_REASONS[code] };
}

const GUARD_REGISTRY_SLOT = 'kernel/proposals/auto-applied-undo:guards';

/**
 * Installed once at host startup with the guards assembled from every owning
 * capability. Kernel cannot import a capability, and the shell read model
 * cannot import the platform, so the registry is a process-wide port.
 */
export function installAutoAppliedUndoGuardRegistry(registry: AutoAppliedUndoGuardRegistry): void {
  installHostOperation(GUARD_REGISTRY_SLOT, registry);
}

function requireGuardRegistry(): AutoAppliedUndoGuardRegistry {
  const registry = installedHostOperation<AutoAppliedUndoGuardRegistry>(GUARD_REGISTRY_SLOT);
  if (!registry) {
    throw new HostOperationNotInstalledError(
      'proposal undo guard registry is not installed; call installProposalUndoGuards at host startup',
    );
  }
  return registry;
}

/** Batch-undoable kinds, in registry order: window selection and the report share this set. */
export function autoAppliedBatchUndoKinds(): readonly string[] {
  return [...requireGuardRegistry().keys()];
}

function revertable(appliedAt: Date | null): AutoAppliedUndoDecision {
  return {
    status: 'revertable',
    code: null,
    reason_md: null,
    correction_event_id: null,
    applied_at: appliedAt,
    clears_in_batch: false,
  };
}

function reverted(correctionEventId: string, appliedAt: Date | null): AutoAppliedUndoDecision {
  return {
    status: 'reverted',
    code: null,
    reason_md: null,
    correction_event_id: correctionEventId,
    applied_at: appliedAt,
    clears_in_batch: false,
  };
}

function blocked(code: GenericUndoCode, appliedAt: Date | null = null): AutoAppliedUndoDecision {
  return {
    status: 'blocked',
    code,
    reason_md: GENERIC_REASONS[code],
    correction_event_id: null,
    applied_at: appliedAt,
    clears_in_batch: false,
  };
}

function failed(code: GenericUndoCode, appliedAt: Date | null = null): AutoAppliedUndoDecision {
  return {
    status: 'failed',
    code,
    reason_md: GENERIC_REASONS[code],
    correction_event_id: null,
    applied_at: appliedAt,
    clears_in_batch: false,
  };
}

interface ProposalRow {
  readonly id: string;
  readonly payload: unknown;
}

interface RateRow {
  readonly proposalId: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

function proposalPayload(payload: unknown): AiProposalPayloadT | null {
  const raw = (payload as { ai_proposal?: unknown } | null)?.ai_proposal;
  if (raw === undefined) return null;
  try {
    return parseAiProposalPayload(raw);
  } catch {
    return null;
  }
}

function ratingOf(payload: unknown): string | null {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const rating = record?.rating;
  return typeof rating === 'string' && rating.length > 0 ? rating : null;
}

/**
 * Classify every id. Missing ids are reported, not thrown: a batch report must
 * stay itemized even when a proposal vanished.
 */
export async function classifyAutoAppliedUndoBatch(
  db: DbLike,
  proposalIds: readonly string[],
): Promise<Map<string, AutoAppliedUndoDecision>> {
  const ids = [...new Set(proposalIds)];
  const decisions = new Map<string, AutoAppliedUndoDecision>();
  if (ids.length === 0) return decisions;
  const guards = requireGuardRegistry();

  const proposalRows = (await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, ids))) as ProposalRow[];
  const proposalById = new Map(proposalRows.map((row) => [row.id, row]));

  const anchorRows = await db
    .select({ proposalId: event.caused_by_event_id })
    .from(event)
    .where(
      and(eq(event.action, PROPOSAL_AUTOAPPLY_ACTION), inArray(event.caused_by_event_id, ids)),
    );
  const autoAppliedIds = new Set(
    anchorRows
      .map((row) => row.proposalId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  const corrections = await getCorrectionStatuses(db, ids);

  const rateRows = (await db
    .select({
      proposalId: event.caused_by_event_id,
      payload: event.payload,
      createdAt: event.created_at,
    })
    .from(event)
    .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, ids)))
    .orderBy(desc(event.created_at), desc(event.id))) as Array<{
    proposalId: string | null;
    payload: unknown;
    createdAt: Date;
  }>;
  const rateByProposal = new Map<string, RateRow>();
  for (const row of rateRows) {
    if (!row.proposalId || rateByProposal.has(row.proposalId)) continue;
    rateByProposal.set(row.proposalId, {
      proposalId: row.proposalId,
      payload: row.payload,
      createdAt: row.createdAt,
    });
  }

  const working = new Map<string, AutoAppliedUndoGuardInput>();

  for (const id of ids) {
    const proposal = proposalById.get(id);
    if (!proposal) {
      decisions.set(id, failed('proposal_not_found'));
      continue;
    }
    const payload = proposalPayload(proposal.payload);
    if (!payload) {
      decisions.set(id, failed('payload_unreadable'));
      continue;
    }
    const correction = corrections.get(id);
    const rate = rateByProposal.get(id);
    const appliedAt = rate?.createdAt ?? null;
    if (correction?.state === 'retracted') {
      decisions.set(id, reverted(correction.correction_event_id, appliedAt));
      continue;
    }
    if (correction && correction.state !== 'active') {
      decisions.set(id, blocked('superseded', appliedAt));
      continue;
    }
    if (!autoAppliedIds.has(id)) {
      decisions.set(id, blocked('not_auto_applied', appliedAt));
      continue;
    }
    const guard = guards.get(payload.kind);
    if (!guard) {
      decisions.set(id, blocked('kind_not_batchable', appliedAt));
      continue;
    }
    const ineligible = guard.eligible?.(payload) ?? null;
    if (ineligible) {
      decisions.set(id, {
        status: ineligible.status,
        code: ineligible.code,
        reason_md: ineligible.reason_md,
        correction_event_id: null,
        applied_at: appliedAt,
        clears_in_batch: ineligible.clears_in_batch === true,
      });
      continue;
    }
    if (!rate) {
      decisions.set(id, failed('apply_record_missing', appliedAt));
      continue;
    }
    if (ratingOf(rate.payload) !== 'accept') {
      decisions.set(id, blocked('not_applied', appliedAt));
      continue;
    }
    working.set(id, {
      proposalId: id,
      payload,
      ratePayload: rate.payload,
      appliedAt: rate.createdAt,
    });
  }

  const byKind = new Map<string, AutoAppliedUndoGuardInput[]>();
  for (const input of working.values()) {
    const list = byKind.get(input.payload.kind);
    if (list) list.push(input);
    else byKind.set(input.payload.kind, [input]);
  }

  for (const [kind, inputs] of byKind) {
    const guard = guards.get(kind);
    if (!guard) continue;
    const blocks = await guard.inspect(db, inputs);
    for (const input of inputs) {
      const block = blocks.get(input.proposalId);
      if (!block) continue;
      decisions.set(input.proposalId, {
        status: block.status,
        code: block.code,
        reason_md: block.reason_md,
        correction_event_id: null,
        applied_at: input.appliedAt,
        clears_in_batch: block.clears_in_batch === true,
      });
    }
  }

  for (const input of working.values()) {
    if (decisions.has(input.proposalId)) continue;
    decisions.set(input.proposalId, revertable(input.appliedAt));
  }
  return decisions;
}

/**
 * Take the owner row locks the retract applier will need, before the batch guard
 * reads owner state. Lock order is fixed by the caller: proposal decision lock →
 * shared learning-state write lock → owner rows (ascending id) → the applier's
 * own locks, which are already held or re-entrant.
 *
 * Only the row set the applier will mutate is locked. Content that references the
 * target through JSONB (questions, records, goals, note labels) has no row to lock;
 * that residual race is documented in the batch retract contract instead of being
 * hidden here.
 */
export async function lockAutoAppliedUndoOwnerRows(tx: Tx, proposalId: string): Promise<void> {
  const guards = requireGuardRegistry();
  const input = await loadGuardInput(tx, proposalId);
  if (!input) return;
  const guard = guards.get(input.payload.kind);
  if (!guard?.lock) return;
  await guard.lock(tx, input);
}

async function loadGuardInput(
  tx: Tx,
  proposalId: string,
): Promise<AutoAppliedUndoGuardInput | null> {
  const [proposal] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  if (!proposal) return null;
  const payload = proposalPayload(proposal.payload);
  if (!payload) return null;
  const rate = await findExistingRateEvent(tx, proposalId);
  if (!rate) return null;
  return {
    proposalId,
    payload,
    ratePayload: rate.payload,
    appliedAt: rate.created_at,
  };
}
