// Sole writer of knowledge_edge propose events. Owns the cooldown-key identity
// (the `(kind, cooldown_key)` slot of `proposal_signals`), the gate lock, the
// live/pending/cooldown dedup, the payload shape, and the validation mode. Dedup
// reads and the write share one `withProposalGateLock` transaction.

import { and, eq, isNull, or } from 'drizzle-orm';
import { isSymmetricKnowledgeRelation } from '@/core/schema/event/blocks';
import type { SuggestionKindT } from '@/core/schema/event/known';
import {
  type AiProposalPayloadInputT,
  type ProposalEvidenceRefT,
  parseAiProposalPayload,
} from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { findActiveProposalCooldown, withProposalGateLock } from '@/kernel/proposals/signals';
import { type WriteAiProposalInput, writeAiProposal } from '@/kernel/proposals/writer';
import { getKnowledgeEdgeById } from './edges';
import { type RubricVerdict, validateProposalQuality } from './rubric-validator';

type DbLike = Db | Tx;

const EDGE_PROPOSAL_KIND = 'knowledge_edge';

/** Equivalent cooldown keys for one create-edge identity; `[0]` is the canonical key. */
export function knowledgeEdgeCooldownKeys(
  fromId: string,
  toId: string,
  relationType: string,
): string[] {
  const directional = `knowledge_edge:${fromId}|${toId}|${relationType}`;
  if (!isSymmetricKnowledgeRelation(relationType)) return [directional];
  const normalized = [fromId, toId].sort().join('|');
  return [
    `knowledge_edge:${normalized}|${relationType}`,
    directional,
    `knowledge_edge:${toId}|${fromId}|${relationType}`,
  ];
}

// One pending archive per edge id; a second call dedups instead of stacking rows.
function knowledgeEdgeArchiveCooldownKey(edgeId: string): string {
  return `knowledge_edge_archive:${edgeId}`;
}

interface ProposalCooldownSkip {
  status: 'skipped:duplicate_pending' | 'skipped:cooldown';
  /** Existing proposal row id: the pending twin, or the latest proposal on the key. */
  proposal_id?: string;
  cooldown_key: string;
  cooldown_until?: string;
}

/**
 * Inbox-pending twin or active dismiss cooldown on any of `cooldownKeys`. Must run
 * inside `withProposalGateLock` on the same keys; also used by the knowledge
 * mutation tool.
 */
export async function checkProposalCooldownGate(
  db: DbLike,
  kind: string,
  cooldownKeys: readonly string[],
): Promise<ProposalCooldownSkip | null> {
  const keys = new Set(cooldownKeys);
  const rows = await listProposalInboxRows(db);
  const onKey = rows.filter(
    (row) =>
      row.kind === kind &&
      row.payload.cooldown_key !== undefined &&
      keys.has(row.payload.cooldown_key),
  );
  const pending = onKey.find((row) => row.status === 'pending');
  if (pending) {
    return {
      status: 'skipped:duplicate_pending',
      proposal_id: pending.id,
      cooldown_key: cooldownKeys[0] ?? (pending.payload.cooldown_key as string),
    };
  }
  const cooling = await findActiveProposalCooldown(db, kind, cooldownKeys);
  if (cooling) {
    // Point at the dismissed proposal that started the cooldown (fallback: latest row).
    const latest = (rows: typeof onKey) =>
      rows.reduce<(typeof onKey)[number] | undefined>(
        (best, row) => (best === undefined || row.proposed_at > best.proposed_at ? row : best),
        undefined,
      );
    const dismissed = onKey.filter((row) => row.status === 'dismissed');
    const source = latest(dismissed) ?? latest(onKey);
    return {
      status: 'skipped:cooldown',
      proposal_id: source?.id,
      cooldown_key: cooling.cooldown_key,
      cooldown_until: cooling.cooldown_until.toISOString(),
    };
  }
  return null;
}

async function findLiveDuplicateEdge(
  db: DbLike,
  fromId: string,
  toId: string,
  relationType: string,
): Promise<string | null> {
  const row = (
    await db
      .select({ id: knowledge_edge.id })
      .from(knowledge_edge)
      .where(
        and(
          isSymmetricKnowledgeRelation(relationType)
            ? or(
                and(
                  eq(knowledge_edge.from_knowledge_id, fromId),
                  eq(knowledge_edge.to_knowledge_id, toId),
                ),
                and(
                  eq(knowledge_edge.from_knowledge_id, toId),
                  eq(knowledge_edge.to_knowledge_id, fromId),
                ),
              )
            : and(
                eq(knowledge_edge.from_knowledge_id, fromId),
                eq(knowledge_edge.to_knowledge_id, toId),
              ),
          eq(knowledge_edge.relation_type, relationType),
          isNull(knowledge_edge.archived_at),
        ),
      )
      .limit(1)
  )[0];
  return row?.id ?? null;
}

interface EdgeCreateChange {
  edge_op: 'create';
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  weight: number;
}

interface EdgeArchiveChange {
  edge_op: 'archive';
  edge_id: string;
}

interface EdgeProposalProvenance {
  reason_md: string;
  evidence_refs: ProposalEvidenceRefT[];
  suggestion_kind?: SuggestionKindT;
  actor_ref: string;
  task_run_id?: string | null;
  caused_by_event_id?: string | null;
  cost_usd?: number | null;
  created_at?: Date;
}

/**
 * `rubric`: inbox-pending + dismiss-cooldown gate, then the shared structural
 * rubric; a rejected create is still written as a folded audit event.
 */
export interface RubricEdgeProposalInput extends EdgeProposalProvenance {
  validate: 'rubric';
  change: EdgeCreateChange | EdgeArchiveChange;
}

/**
 * `bootstrap`: cold-start placeholder edges with no evidence by design. No rubric;
 * the same inbox-pending + dismiss-cooldown gate as `rubric`, so a dismissed pair
 * is not re-proposed the next night.
 */
export interface BootstrapEdgeProposalInput extends EdgeProposalProvenance {
  validate: 'bootstrap';
  change: EdgeCreateChange;
}

type ProposedResult = { status: 'proposed'; proposal_id: string; cooldown_key: string };
type LiveDuplicateResult = {
  status: 'skipped:duplicate_live_edge';
  edge_id: string;
  reason: string;
};

export type BootstrapEdgeProposalResult =
  | ProposedResult
  | LiveDuplicateResult
  | ProposalCooldownSkip;

export type RubricEdgeProposalResult =
  | ProposedResult
  | LiveDuplicateResult
  | { status: 'skipped:edge_not_found'; edge_id: string; reason: string }
  | ProposalCooldownSkip
  | {
      status: 'skipped:rubric_rejected';
      proposal_id?: string;
      cooldown_key: string;
      gate: string;
      reason: string;
    };

function cooldownKeysFor(change: EdgeCreateChange | EdgeArchiveChange): string[] {
  return change.edge_op === 'archive'
    ? [knowledgeEdgeArchiveCooldownKey(change.edge_id)]
    : knowledgeEdgeCooldownKeys(
        change.from_knowledge_id,
        change.to_knowledge_id,
        change.relation_type,
      );
}

type EdgeProposalPayload = Extract<AiProposalPayloadInputT, { kind: 'knowledge_edge' }>;

function edgeProposalPayload(
  input: EdgeProposalProvenance,
  subjectId: string | null,
  proposedChange: EdgeProposalPayload['proposed_change'],
  cooldownKey: string,
): EdgeProposalPayload {
  return {
    kind: 'knowledge_edge',
    target: { subject_kind: 'knowledge_edge', subject_id: subjectId },
    reason_md: input.reason_md,
    evidence_refs: input.evidence_refs,
    proposed_change: proposedChange,
    cooldown_key: cooldownKey,
    ...(input.suggestion_kind !== undefined ? { suggestion_kind: input.suggestion_kind } : {}),
  };
}

function writeProposalEvent(
  tx: DbLike,
  input: EdgeProposalProvenance,
  payload: EdgeProposalPayload,
  eventOverride?: WriteAiProposalInput['event_override'],
): Promise<string> {
  return writeAiProposal(tx, {
    actor_ref: input.actor_ref,
    outcome: 'success',
    payload,
    event_override: eventOverride,
    task_run_id: input.task_run_id ?? null,
    caused_by_event_id: input.caused_by_event_id ?? null,
    cost_usd: input.cost_usd,
    created_at: input.created_at,
  });
}

export async function writeKnowledgeEdgeProposal(
  db: DbLike,
  input: BootstrapEdgeProposalInput,
): Promise<BootstrapEdgeProposalResult>;
export async function writeKnowledgeEdgeProposal(
  db: DbLike,
  input: RubricEdgeProposalInput,
): Promise<RubricEdgeProposalResult>;
export async function writeKnowledgeEdgeProposal(
  db: DbLike,
  input: BootstrapEdgeProposalInput | RubricEdgeProposalInput,
): Promise<BootstrapEdgeProposalResult | RubricEdgeProposalResult> {
  const cooldownKeys = cooldownKeysFor(input.change);
  const cooldownKey = cooldownKeys[0] as string;
  return await withProposalGateLock(db, EDGE_PROPOSAL_KIND, cooldownKeys, async (tx) => {
    if (input.validate === 'bootstrap') {
      return await writeBootstrapCreate(tx, input, cooldownKey, cooldownKeys);
    }
    return input.change.edge_op === 'archive'
      ? await writeRubricArchive(tx, input, input.change, cooldownKey, cooldownKeys)
      : await writeRubricCreate(tx, input, input.change, cooldownKey, cooldownKeys);
  });
}

async function writeBootstrapCreate(
  tx: DbLike,
  input: BootstrapEdgeProposalInput,
  cooldownKey: string,
  cooldownKeys: readonly string[],
): Promise<BootstrapEdgeProposalResult> {
  const { from_knowledge_id: from, to_knowledge_id: to, relation_type: rel } = input.change;
  const liveEdgeId = await findLiveDuplicateEdge(tx, from, to, rel);
  if (liveEdgeId) {
    return { status: 'skipped:duplicate_live_edge', edge_id: liveEdgeId, reason: liveEdgeId };
  }
  const skip = await checkProposalCooldownGate(tx, EDGE_PROPOSAL_KIND, cooldownKeys);
  if (skip) return skip;
  const proposalId = await writeProposalEvent(
    tx,
    input,
    edgeProposalPayload(input, null, input.change, cooldownKey),
  );
  return { status: 'proposed', proposal_id: proposalId, cooldown_key: cooldownKey };
}

async function writeRubricCreate(
  tx: DbLike,
  input: RubricEdgeProposalInput,
  change: EdgeCreateChange,
  cooldownKey: string,
  cooldownKeys: readonly string[],
): Promise<RubricEdgeProposalResult> {
  const liveEdgeId = await findLiveDuplicateEdge(
    tx,
    change.from_knowledge_id,
    change.to_knowledge_id,
    change.relation_type,
  );
  if (liveEdgeId) {
    return { status: 'skipped:duplicate_live_edge', edge_id: liveEdgeId, reason: liveEdgeId };
  }
  const skip = await checkProposalCooldownGate(tx, EDGE_PROPOSAL_KIND, cooldownKeys);
  if (skip) return skip;

  const payload = edgeProposalPayload(input, null, change, cooldownKey);
  const verdict = await validateProposalQuality(parseAiProposalPayload(payload), tx);
  if (!verdict.ok) {
    return await foldRubricRejectedCreate(tx, input, payload, change, cooldownKey, verdict);
  }
  const proposalId = await writeProposalEvent(tx, input, payload);
  return { status: 'proposed', proposal_id: proposalId, cooldown_key: cooldownKey };
}

// A rejected create is still written, marked rubric-rejected: it folds as an
// audit/L2 signal and the inbox derives a terminal status, so it never occupies
// live-pending dedup. No tool_call_log here: the DomainTool wrapper logs once.
async function foldRubricRejectedCreate(
  tx: DbLike,
  input: RubricEdgeProposalInput,
  payload: EdgeProposalPayload,
  change: EdgeCreateChange,
  cooldownKey: string,
  verdict: Extract<RubricVerdict, { ok: false }>,
): Promise<RubricEdgeProposalResult> {
  const proposalId = await writeProposalEvent(tx, input, payload, {
    action: 'propose',
    subject_kind: 'knowledge_edge',
    payload: {
      edge_op: 'create',
      from_knowledge_id: change.from_knowledge_id,
      to_knowledge_id: change.to_knowledge_id,
      relation_type: change.relation_type,
      weight: change.weight,
      reasoning: input.reason_md,
      rubric_verdict: { ok: false, gate: verdict.gate, reason: verdict.reason },
    },
  });
  return {
    status: 'skipped:rubric_rejected',
    proposal_id: proposalId,
    cooldown_key: cooldownKey,
    gate: verdict.gate,
    reason: verdict.reason,
  };
}

async function writeRubricArchive(
  tx: DbLike,
  input: RubricEdgeProposalInput,
  change: EdgeArchiveChange,
  cooldownKey: string,
  cooldownKeys: readonly string[],
): Promise<RubricEdgeProposalResult> {
  const edge = await getKnowledgeEdgeById(tx, change.edge_id);
  if (!edge || edge.archived_at !== null) {
    return { status: 'skipped:edge_not_found', edge_id: change.edge_id, reason: change.edge_id };
  }
  const skip = await checkProposalCooldownGate(tx, EDGE_PROPOSAL_KIND, cooldownKeys);
  if (skip) return skip;

  const payload = edgeProposalPayload(
    input,
    change.edge_id,
    {
      edge_op: 'archive',
      // Endpoints describe the archived edge; archive_edge_id is the target the
      // accept applier flips.
      from_knowledge_id: edge.from_knowledge_id,
      to_knowledge_id: edge.to_knowledge_id,
      relation_type: edge.relation_type,
      weight: edge.weight,
      archive_edge_id: change.edge_id,
    },
    cooldownKey,
  );
  // Archive short-circuits the create gates; a structural reject is surfaced
  // without folding a create-shaped event.
  const verdict = await validateProposalQuality(parseAiProposalPayload(payload), tx);
  if (!verdict.ok) {
    return {
      status: 'skipped:rubric_rejected',
      cooldown_key: cooldownKey,
      gate: verdict.gate,
      reason: verdict.reason,
    };
  }
  const proposalId = await writeProposalEvent(tx, input, payload);
  return { status: 'proposed', proposal_id: proposalId, cooldown_key: cooldownKey };
}
