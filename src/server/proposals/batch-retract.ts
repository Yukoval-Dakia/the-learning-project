// Batch retraction for strength-A auto-applied proposals.
//
// Not a second retract implementation: every item still goes through the one
// canonical `retractAiProposal` path (correction event + owner applier, one
// transaction per item). This module adds three things the single-card lane
// does not need:
//
//   1. Reverse-causal order. A later proposal may depend on something an
//      earlier one created (a child node under an auto-created root is the
//      concrete case). Dependents are retracted first, so retracting the
//      dependency is not blocked by content that the same batch is about to
//      remove. Edges come from the event graph's `caused_by_event_id` chain:
//      a proposal depends on another selected proposal when walking its causal
//      ancestors reaches that proposal (directly, through its accept rate, or
//      through any intermediate event). Independent items fall back to newest
//      apply first.
//   2. A per-item four-state report. One failure never rolls back another
//      item's committed retraction.
//   3. Idempotency at the retraction boundary: an already-retracted item is
//      reported as such before any write, and the in-transaction guard repeats
//      that check under the decision lock, so a retried batch never writes a
//      second correction event.
//
// The in-transaction guard re-classifies the item instead of trusting the
// pre-scan: state that only the batch itself can change (a dependent child
// removed earlier in the same run) must be visible at retraction time.

import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';

import {
  PROPOSAL_BATCH_RETRACT_MAX_IDS,
  ProposalBatchRetractInput,
  type ProposalBatchRetractInputT,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  AUTO_APPLIED_BATCH_UNDO_KINDS,
  type AutoAppliedUndoDecision,
  classifyAutoAppliedUndoBatch,
  isNonTransientUndoBlock,
} from '@/kernel/proposals/auto-applied-undo';
import { PROPOSAL_AUTOAPPLY_ACTION } from '@/kernel/proposals/auto-apply';
import { retractAiProposal } from './retract-action';

export type BatchRetractItemStatus = 'reverted' | 'blocked' | 'already_reverted' | 'failed';

export interface BatchRetractItem {
  readonly proposal_id: string;
  readonly kind: string;
  readonly status: BatchRetractItemStatus;
  readonly code: string | null;
  readonly reason_md: string | null;
  readonly correction_event_id: string | null;
}

export interface BatchRetractResult {
  readonly items: BatchRetractItem[];
  readonly summary: {
    readonly requested: number;
    readonly reverted: number;
    readonly blocked: number;
    readonly already_reverted: number;
    readonly failed: number;
    readonly truncated: boolean;
  };
  readonly window: { readonly from: string; readonly to: string } | null;
}

interface ProposalMeta {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: Date;
  readonly causedByEventId: string | null;
}

/** Signals a guard refusal without writing anything (the retract tx rolls back). */
class BatchUndoGuardSignal extends Error {
  constructor(
    readonly status: 'blocked' | 'already_reverted' | 'failed',
    readonly code: string | null,
    readonly correctionEventId: string | null = null,
    message?: string | null,
  ) {
    super(message ?? code ?? status);
    this.name = 'BatchUndoGuardSignal';
  }
}

function validationError(message: string): ApiError {
  return new ApiError('validation_error', message, 400);
}

function parseInput(input: unknown): ProposalBatchRetractInputT {
  const parsed = ProposalBatchRetractInput.safeParse(input);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

function kindOf(payload: unknown): string {
  const ai = (payload as { ai_proposal?: unknown } | null)?.ai_proposal;
  if (!ai || typeof ai !== 'object') return 'unknown';
  const kind = (ai as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : 'unknown';
}

/** Window selection: only the three batch-undoable categories enter the run. */
async function selectWindowProposalIds(
  db: Db,
  input: ProposalBatchRetractInputT,
): Promise<{ ids: string[]; truncated: boolean; window: { from: string; to: string } }> {
  const from = new Date(input.from as string);
  const to = input.to ? new Date(input.to) : new Date();
  const rows = await db
    .select({ proposalId: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, PROPOSAL_AUTOAPPLY_ACTION),
        gte(event.created_at, from),
        lte(event.created_at, to),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id))
    .limit(PROPOSAL_BATCH_RETRACT_MAX_IDS + 1);

  const orderedIds = rows
    .map((row) => row.proposalId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const truncated = orderedIds.length > PROPOSAL_BATCH_RETRACT_MAX_IDS;
  const ids = orderedIds.slice(0, PROPOSAL_BATCH_RETRACT_MAX_IDS);
  if (ids.length === 0) {
    return { ids, truncated, window: { from: from.toISOString(), to: to.toISOString() } };
  }

  const proposals = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, ids));
  const allowed = new Set<string>(AUTO_APPLIED_BATCH_UNDO_KINDS);
  const allowedIds = new Set(
    proposals.filter((row) => allowed.has(kindOf(row.payload))).map((row) => row.id),
  );
  return {
    ids: ids.filter((id) => allowedIds.has(id)),
    truncated,
    window: { from: from.toISOString(), to: to.toISOString() },
  };
}

async function loadProposalMeta(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, ProposalMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: event.id,
      payload: event.payload,
      createdAt: event.created_at,
      causedByEventId: event.caused_by_event_id,
    })
    .from(event)
    .where(inArray(event.id, ids));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: kindOf(row.payload),
        createdAt: row.createdAt,
        causedByEventId: row.causedByEventId,
      },
    ]),
  );
}

/**
 * Load the causal ancestor graph once for the whole selection. Expansion is
 * bounded (depth 12, 2000 events) so a pathological chain cannot turn one undo
 * click into an unbounded walk; exceeding the bound only loses an ordering
 * preference, never correctness, because each item is still guard-checked.
 */
async function loadAncestorGraph(
  db: Db,
  metas: Iterable<ProposalMeta>,
): Promise<Map<string, string | null>> {
  const graph = new Map<string, string | null>();
  let frontier = [
    ...new Set(
      [...metas]
        .map((meta) => meta.causedByEventId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const depthCap = 12;
  const eventCap = 2_000;
  for (let depth = 0; depth < depthCap && frontier.length > 0; depth += 1) {
    if (graph.size >= eventCap) break;
    const rows = await db
      .select({ id: event.id, causedByEventId: event.caused_by_event_id })
      .from(event)
      .where(inArray(event.id, frontier));
    const next: string[] = [];
    for (const row of rows) {
      if (graph.has(row.id)) continue;
      graph.set(row.id, row.causedByEventId);
      if (row.causedByEventId) next.push(row.causedByEventId);
    }
    frontier = [...new Set(next.filter((id) => !graph.has(id)))];
  }
  return graph;
}

/**
 * Emit dependents before their dependencies, newest apply first within a layer.
 * A cycle (which the causal graph should never contain) degrades to the base
 * order instead of dropping items.
 */
function orderReverseCausal(
  ids: readonly string[],
  metas: Map<string, ProposalMeta>,
  decisions: Map<string, AutoAppliedUndoDecision>,
  ancestorGraph: Map<string, string | null>,
): string[] {
  const selected = new Set(ids);
  const dependsOn = new Map<string, Set<string>>();
  for (const id of ids) {
    const deps = new Set<string>();
    let cursor = metas.get(id)?.causedByEventId ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      if (selected.has(cursor) && cursor !== id) deps.add(cursor);
      cursor = ancestorGraph.get(cursor) ?? null;
    }
    dependsOn.set(id, deps);
  }
  const dependents = new Map<string, Set<string>>();
  for (const [id, deps] of dependsOn) {
    for (const dep of deps) {
      const set = dependents.get(dep);
      if (set) set.add(id);
      else dependents.set(dep, new Set([id]));
    }
  }

  const baseTime = (id: string): number => {
    const applied = decisions.get(id)?.applied_at;
    const time = applied ?? metas.get(id)?.createdAt;
    return time ? time.getTime() : 0;
  };
  const byFreshness = (left: string, right: string): number => {
    const delta = baseTime(right) - baseTime(left);
    if (delta !== 0) return delta;
    return right.localeCompare(left);
  };

  const remaining = new Set(ids);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const candidates = [...remaining].filter((id) => {
      const waiters = dependents.get(id);
      if (!waiters) return true;
      return [...waiters].every((waiter) => !remaining.has(waiter));
    });
    if (candidates.length === 0) {
      ordered.push(...[...remaining].sort(byFreshness));
      break;
    }
    const next = candidates.sort(byFreshness)[0];
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered;
}

function item(
  proposalId: string,
  kind: string,
  status: BatchRetractItemStatus,
  code: string | null,
  reasonMd: string | null,
  correctionEventId: string | null,
): BatchRetractItem {
  return {
    proposal_id: proposalId,
    kind,
    status,
    code,
    reason_md: reasonMd,
    correction_event_id: correctionEventId,
  };
}

function fromDecision(
  proposalId: string,
  kind: string,
  decision: AutoAppliedUndoDecision,
): BatchRetractItem {
  if (decision.status === 'reverted') {
    return item(proposalId, kind, 'already_reverted', null, null, decision.correction_event_id);
  }
  if (decision.status === 'failed') {
    return item(proposalId, kind, 'failed', decision.code, decision.reason_md, null);
  }
  return item(proposalId, kind, 'blocked', decision.code, decision.reason_md, null);
}

/**
 * Undo an auto-applied batch. `input` is the raw HTTP body; the canonical
 * schema owns validation so the route and future callers share one contract.
 */
export async function batchRetractAutoAppliedProposals(
  db: Db,
  input: unknown,
): Promise<BatchRetractResult> {
  const parsed = parseInput(input);
  const selection = parsed.proposal_ids
    ? {
        ids: [...new Set(parsed.proposal_ids)],
        truncated: false,
        window: null as { from: string; to: string } | null,
      }
    : await selectWindowProposalIds(db, parsed);

  const metas = await loadProposalMeta(db, selection.ids);
  const decisions = await classifyAutoAppliedUndoBatch(db, selection.ids);
  const ancestorGraph = await loadAncestorGraph(db, metas.values());
  const orderedIds = orderReverseCausal(selection.ids, metas, decisions, ancestorGraph);

  const items: BatchRetractItem[] = [];
  for (const proposalId of orderedIds) {
    const kind = metas.get(proposalId)?.kind ?? 'unknown';
    const decision = decisions.get(proposalId);
    if (!decision) {
      items.push(item(proposalId, kind, 'failed', 'proposal_not_found', '找不到这条改动。', null));
      continue;
    }
    if (decision.status === 'reverted' || decision.status === 'failed') {
      items.push(fromDecision(proposalId, kind, decision));
      continue;
    }
    if (decision.status === 'blocked' && isNonTransientUndoBlock(decision.code)) {
      items.push(fromDecision(proposalId, kind, decision));
      continue;
    }

    try {
      const result = await retractAiProposal(db, proposalId, {
        ...(parsed.reason_md ? { reason_md: parsed.reason_md } : {}),
        guard: async (tx: Tx) => {
          const fresh = (await classifyAutoAppliedUndoBatch(tx, [proposalId])).get(proposalId);
          if (!fresh) {
            throw new BatchUndoGuardSignal(
              'failed',
              'proposal_not_found',
              null,
              '找不到这条改动。',
            );
          }
          if (fresh.status === 'reverted') {
            throw new BatchUndoGuardSignal('already_reverted', null, fresh.correction_event_id);
          }
          if (fresh.status === 'blocked' || fresh.status === 'failed') {
            throw new BatchUndoGuardSignal(fresh.status, fresh.code, null, fresh.reason_md);
          }
        },
      });
      items.push(item(proposalId, kind, 'reverted', null, null, result.correction_event_id));
    } catch (err) {
      if (err instanceof BatchUndoGuardSignal) {
        items.push(
          item(
            proposalId,
            kind,
            err.status,
            err.code,
            err.status === 'already_reverted' ? null : err.message,
            err.correctionEventId,
          ),
        );
        continue;
      }
      console.warn('[proposal-batch-retract] retraction failed', {
        proposal_id: proposalId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
      items.push(
        item(proposalId, kind, 'failed', 'retract_failed', '撤销没有完成，请稍后再试。', null),
      );
    }
  }

  const summary = {
    requested: orderedIds.length,
    reverted: items.filter((entry) => entry.status === 'reverted').length,
    blocked: items.filter((entry) => entry.status === 'blocked').length,
    already_reverted: items.filter((entry) => entry.status === 'already_reverted').length,
    failed: items.filter((entry) => entry.status === 'failed').length,
    truncated: selection.truncated,
  };

  return { items, summary, window: selection.window };
}
