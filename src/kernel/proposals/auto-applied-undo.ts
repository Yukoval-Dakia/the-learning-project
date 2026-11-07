// Batch-undo safety for strength-A auto-applied proposals.
//
// One shared classifier feeds BOTH the summary read model (each card's
// `undo` state) and the batch retraction lane's in-transaction guard, so the
// page can never offer an undo the backend would refuse.
//
// "Can this be undone cleanly?" is a domain question, not a timestamp question:
// the proposal's own apply no longer decides it. The classifier reads the
// owner's live state (knowledge tree, question/record links, overlay row,
// learning items) and reports one of:
//   revertable — the existing retract applier restores the pre-apply state;
//   blocked    — later learner content depends on what would be archived;
//   reverted   — a retract correction already landed (idempotent retry);
//   failed     — the proposal or its apply record cannot be read.
//
// Only the three categories whose retract applier is fully reversible take part
// in batch undo (knowledge_node, cause_category, learning_item 3c). Everything
// else stays a per-card human decision.

import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { type AiProposalPayloadT, parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { artifact, artifact_block_ref } from '@/db/schema/artifacts';
import {
  cause_category_overlay,
  knowledge,
  knowledge_edge,
  misconception_edge,
} from '@/db/schema/knowledge';
import { goal, placement_starter_claim } from '@/db/schema/learner-state';
import { answer, learning_item, learning_record } from '@/db/schema/learning';
import { getCorrectionStatuses } from '@/kernel/events';
import { batchResolveAncestorIds } from '@/kernel/read-models/knowledge-tree';
import { findExistingRateEvent } from './applier-helpers';
import { PROPOSAL_AUTOAPPLY_ACTION } from './auto-apply';
import {
  isAutoOwnedAttachment,
  loadRefileProofMap,
  selectNodeAttachedQuestions,
} from './node-question-attachments';

type DbLike = Db | Tx;

/** Categories a single learner action may undo as one batch. */
export const AUTO_APPLIED_BATCH_UNDO_KINDS = [
  'knowledge_node',
  'cause_category',
  'learning_item',
] as const;

export type AutoAppliedBatchUndoKind = (typeof AUTO_APPLIED_BATCH_UNDO_KINDS)[number];

export type AutoAppliedUndoStatus = 'revertable' | 'blocked' | 'reverted' | 'failed';

export type AutoAppliedUndoCode =
  | 'proposal_not_found'
  | 'payload_unreadable'
  | 'not_auto_applied'
  | 'kind_not_batchable'
  | 'plan_case_not_retractable'
  | 'not_applied'
  | 'superseded'
  | 'apply_record_missing'
  | 'knowledge_not_found'
  | 'knowledge_already_archived'
  | 'knowledge_later_edit'
  | 'knowledge_has_children'
  | 'knowledge_has_edges'
  | 'knowledge_has_questions'
  | 'knowledge_has_records'
  | 'knowledge_has_learning_items'
  | 'knowledge_has_artifacts'
  | 'knowledge_has_goals'
  | 'knowledge_has_placement_claims'
  | 'knowledge_has_misconception_edges'
  | 'cause_not_found'
  | 'cause_not_owned'
  | 'cause_already_archived'
  | 'cause_not_active'
  | 'cause_used_in_attribution'
  | 'learning_item_missing'
  | 'learning_item_already_archived'
  | 'learning_item_partially_archived'
  | 'learning_item_later_changes'
  | 'learning_item_has_records'
  | 'learning_item_artifact_missing'
  | 'learning_item_note_edited'
  | 'learning_item_artifact_referenced'
  | 'learning_item_has_answer_drafts';

export interface AutoAppliedUndoDecision {
  readonly status: AutoAppliedUndoStatus;
  /** Stable machine code for the UI; null exactly when revertable. */
  readonly code: AutoAppliedUndoCode | null;
  /** Learner-facing explanation; never contains ids, field names or tool names. */
  readonly reason_md: string | null;
  /** Existing retract correction when status === 'reverted'. */
  readonly correction_event_id: string | null;
  /** Apply time (accept rate) when readable; used for reverse-causal ordering. */
  readonly applied_at: Date | null;
}

const BLOCKED_REASONS: Record<AutoAppliedUndoCode, string> = {
  proposal_not_found: '找不到这条改动。',
  payload_unreadable: '这条改动的内容读不出来，暂时不能撤销。',
  not_auto_applied: '这不是自动应用的改动，需要在收件箱里逐条处理。',
  kind_not_batchable: '这类自动改动暂不支持一键批量撤销。',
  plan_case_not_retractable: '这条学习路径会新建知识点，批量撤销暂时只支持已有图谱的情况。',
  not_applied: '这条改动还没有被应用，不需要撤销。',
  superseded: '这条改动已经被后续更正取代，不能再撤销。',
  apply_record_missing: '这条改动缺少应用记录，暂时不能撤销。',
  knowledge_not_found: '这个知识点已经找不到了，可能已被删除或合并。',
  knowledge_already_archived: '这个知识点已经被归档，不需要再撤销。',
  knowledge_later_edit: '这个知识点应用后被改过，撤销会覆盖后来的修改，所以先保留了。',
  knowledge_has_children: '这个知识点下已经有新的子知识点，撤销会连带影响它们，所以先保留了。',
  knowledge_has_edges:
    '这个知识点已经和别的知识点建立了关联，撤销会连带删掉这些关联，所以先保留了。',
  knowledge_has_questions: '已经有题目挂在这个知识点上，撤销会让它们失去归属，所以先保留了。',
  knowledge_has_records: '已经有错题或学习记录关联这个知识点，撤销会让它们失去归属，所以先保留了。',
  knowledge_has_learning_items:
    '已经有学习项挂在这个知识点上，撤销会中断正在进行的计划，所以先保留了。',
  knowledge_has_artifacts: '已经有笔记把这个知识点当作标签，撤销会让笔记失去归属，所以先保留了。',
  knowledge_has_goals: '已经有学习目标覆盖这个知识点，撤销会让目标失去依据，所以先保留了。',
  knowledge_has_placement_claims: '起点的出题任务正在使用这个知识点，撤销会打断它，所以先保留了。',
  knowledge_has_misconception_edges:
    '已经有错因关联指向这个知识点，撤销会让关联失去归属，所以先保留了。',
  cause_not_found: '这个错因类目已经找不到了。',
  cause_not_owned: '这个错因类目已经不由这条改动负责，不能再撤销。',
  cause_already_archived: '这个错因类目已经被归档，不需要再撤销。',
  cause_not_active: '这个错因类目当前不在词表里，不能撤销。',
  cause_used_in_attribution: '已经有错因判定用了这个类目，撤销会让这些判定失去解释，所以先保留了。',
  learning_item_missing: '这批学习项已经找不到了。',
  learning_item_already_archived: '这些学习项已经被归档，不需要再撤销。',
  learning_item_partially_archived:
    '其中部分学习项已经被归档，撤销会对不上原来的计划，所以先保留了。',
  learning_item_later_changes: '这些学习项之后有了新的进展，撤销会丢掉进度，所以先保留了。',
  learning_item_has_records: '这些学习项已经产生练习记录，撤销会让记录失去关联，所以先保留了。',
  learning_item_artifact_missing: '这些学习项配对的笔记找不到了，撤销会对不上，所以先保留了。',
  learning_item_note_edited: '这些学习项的笔记之后被编辑过，撤销会覆盖这些修改，所以先保留了。',
  learning_item_artifact_referenced:
    '已经有别的笔记引用了这些学习项的笔记，撤销会让引用失效，所以先保留了。',
  learning_item_has_answer_drafts:
    '这些学习项还有未提交的作答草稿，撤销会打断正在写的答案，所以先保留了。',
};

/** Codes that cannot become revertable during one batch run (batch order never clears them). */
const NON_TRANSIENT_BLOCK_CODES: ReadonlySet<AutoAppliedUndoCode> = new Set(
  (Object.keys(BLOCKED_REASONS) as AutoAppliedUndoCode[]).filter(
    (code) => code !== 'knowledge_has_children',
  ),
);

function revertable(appliedAt: Date | null): AutoAppliedUndoDecision {
  return {
    status: 'revertable',
    code: null,
    reason_md: null,
    correction_event_id: null,
    applied_at: appliedAt,
  };
}

function reverted(correctionEventId: string, appliedAt: Date | null): AutoAppliedUndoDecision {
  return {
    status: 'reverted',
    code: null,
    reason_md: null,
    correction_event_id: correctionEventId,
    applied_at: appliedAt,
  };
}

function blocked(
  code: AutoAppliedUndoCode,
  appliedAt: Date | null = null,
): AutoAppliedUndoDecision {
  return {
    status: 'blocked',
    code,
    reason_md: BLOCKED_REASONS[code],
    correction_event_id: null,
    applied_at: appliedAt,
  };
}

function failed(code: AutoAppliedUndoCode, appliedAt: Date | null = null): AutoAppliedUndoDecision {
  return {
    status: 'failed',
    code,
    reason_md: BLOCKED_REASONS[code],
    correction_event_id: null,
    applied_at: appliedAt,
  };
}

/** True when a pre-checked block can never clear inside the same batch. */
export function isNonTransientUndoBlock(code: AutoAppliedUndoCode | null): boolean {
  return code !== null && NON_TRANSIENT_BLOCK_CODES.has(code);
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

function readString(value: unknown, key: string): string | null {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const field = record?.[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function ratingOf(payload: unknown): string | null {
  return readString(payload, 'rating');
}

/** The node minted by a knowledge_node accept, from the rate's materialization facts. */
export function appliedKnowledgeNodeId(ratePayload: unknown): string | null {
  const record =
    ratePayload && typeof ratePayload === 'object'
      ? (ratePayload as Record<string, unknown>)
      : null;
  const materialized = record?.materialized_ids;
  if (materialized && typeof materialized === 'object') {
    const ids = (materialized as Record<string, unknown>).knowledge;
    if (Array.isArray(ids) && typeof ids[0] === 'string' && ids[0].length > 0) return ids[0];
  }
  const operation = record?.knowledge_operation;
  if (operation && typeof operation === 'object') {
    const op = operation as Record<string, unknown>;
    if (op.kind === 'create' && Array.isArray(op.targets)) {
      for (const target of op.targets) {
        if (!target || typeof target !== 'object') continue;
        const entry = target as Record<string, unknown>;
        if (entry.kind === 'knowledge' && typeof entry.id === 'string' && entry.id.length > 0) {
          return entry.id;
        }
      }
    }
  }
  return null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function planCaseOf(payload: AiProposalPayloadT): string | null {
  const change = payload.proposed_change;
  return readString(change, 'plan_case');
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

  const working = new Map<string, { payload: AiProposalPayloadT; rate: RateRow }>();

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
    if (!isBatchUndoKind(payload.kind)) {
      decisions.set(id, blocked('kind_not_batchable', appliedAt));
      continue;
    }
    if (payload.kind === 'learning_item' && planCaseOf(payload) !== '3c_existing_graph') {
      decisions.set(id, blocked('plan_case_not_retractable', appliedAt));
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
    working.set(id, { payload, rate });
  }

  await classifyKnowledgeNodes(db, working, decisions);
  await classifyCauseCategories(db, working, decisions);
  await classifyLearningItems(db, working, decisions);

  for (const [id, entry] of working) {
    if (decisions.has(id)) continue;
    decisions.set(id, revertable(entry.rate.createdAt));
  }
  return decisions;
}

function isBatchUndoKind(kind: string): kind is AutoAppliedBatchUndoKind {
  return (AUTO_APPLIED_BATCH_UNDO_KINDS as readonly string[]).includes(kind);
}

/**
 * Take the owner row locks the retract appliers will need, before the batch guard
 * reads owner state. Lock order is fixed by the caller: proposal decision lock →
 * owner rows (ascending id) → the applier's own locks, which are already held.
 *
 * Only the row set the applier will mutate is locked. Content that references the
 * target through JSONB (questions, records, goals, note labels) has no row to lock;
 * that residual race is documented in the PR instead of being hidden here.
 */
export async function lockAutoAppliedUndoOwnerRows(tx: Tx, proposalId: string): Promise<void> {
  const [proposal] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  if (!proposal) return;
  const payload = proposalPayload(proposal.payload);
  if (!payload) return;

  if (payload.kind === 'knowledge_node') {
    const rate = await findExistingRateEvent(tx, proposalId);
    const nodeId = rate ? appliedKnowledgeNodeId(rate.payload) : null;
    if (nodeId) {
      await tx
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(eq(knowledge.id, nodeId))
        .for('update');
    }
    return;
  }

  if (payload.kind === 'cause_category') {
    const categoryId = readString(payload.proposed_change, 'category_id');
    if (categoryId) {
      await tx
        .select({ id: cause_category_overlay.id })
        .from(cause_category_overlay)
        .where(eq(cause_category_overlay.id, categoryId))
        .for('update');
    }
    return;
  }

  if (payload.kind === 'learning_item') {
    const items = await tx
      .select({ id: learning_item.id, primaryArtifactId: learning_item.primary_artifact_id })
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId))
      .orderBy(learning_item.id)
      .for('update');
    const primaryIds = items
      .map((row) => row.primaryArtifactId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (primaryIds.length === 0) {
      await tx
        .select({ id: artifact.id })
        .from(artifact)
        .where(eq(artifact.source_ref, proposalId))
        .orderBy(artifact.id)
        .for('update');
      return;
    }
    await tx
      .select({ id: artifact.id })
      .from(artifact)
      .where(or(eq(artifact.source_ref, proposalId), inArray(artifact.id, primaryIds)))
      .orderBy(artifact.id)
      .for('update');
  }
}

interface KnowledgeCheck {
  readonly proposalId: string;
  readonly nodeId: string;
  readonly appliedAt: Date;
}

async function classifyKnowledgeNodes(
  db: DbLike,
  working: Map<string, { payload: AiProposalPayloadT; rate: RateRow }>,
  decisions: Map<string, AutoAppliedUndoDecision>,
): Promise<void> {
  const checks: KnowledgeCheck[] = [];
  for (const [proposalId, entry] of working) {
    if (entry.payload.kind !== 'knowledge_node') continue;
    const nodeId = appliedKnowledgeNodeId(entry.rate.payload);
    if (!nodeId) {
      decisions.set(proposalId, failed('apply_record_missing', entry.rate.createdAt));
      continue;
    }
    checks.push({ proposalId, nodeId, appliedAt: entry.rate.createdAt });
  }
  if (checks.length === 0) return;

  const nodeIds = [...new Set(checks.map((check) => check.nodeId))];
  const nodeRows = await db
    .select({
      id: knowledge.id,
      version: knowledge.version,
      archivedAt: knowledge.archived_at,
    })
    .from(knowledge)
    .where(inArray(knowledge.id, nodeIds));
  const nodeById = new Map(nodeRows.map((row) => [row.id, row]));

  const childRows = (await db
    .select({ nodeId: knowledge.parent_id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .where(and(inArray(knowledge.parent_id, nodeIds), isNull(knowledge.archived_at)))
    .groupBy(knowledge.parent_id)) as Array<{ nodeId: string; count: number }>;
  const childCounts = new Map(childRows.map((row) => [row.nodeId, Number(row.count)]));

  // Auto-ownership replaces birth-metadata counting: an attachment blocks the
  // undo unless it is provably still the automation's own placement — the same
  // rule the retract applier enforces, so the card verdict and the backend
  // cannot disagree.
  const questionCounts = new Map<string, number>();
  const foreignQuestionCounts = new Map<string, number>();
  for (const nodeId of nodeIds) {
    const attached = await selectNodeAttachedQuestions(db, nodeId);
    const proofs = await loadRefileProofMap(
      db,
      nodeId,
      attached.map((row) => row.id),
    );
    questionCounts.set(nodeId, attached.length);
    foreignQuestionCounts.set(
      nodeId,
      attached.filter((row) => !isAutoOwnedAttachment(row, nodeId, proofs)).length,
    );
  }

  // Auto-owned attachments (companion teaching drafts, refiled moves) return to
  // the tree's live root on retraction instead of blocking the undo. Nodes
  // whose only questions are auto-owned still need somewhere to send them:
  // the ancestor walk must end at a live root row.
  const refileRootByNode = new Map<string, string>();
  const refileCandidateIds = checks
    .filter(
      (check) =>
        (questionCounts.get(check.nodeId) ?? 0) > 0 &&
        (foreignQuestionCounts.get(check.nodeId) ?? 0) === 0,
    )
    .map((check) => check.nodeId);
  if (refileCandidateIds.length > 0) {
    const chains = await batchResolveAncestorIds(db, refileCandidateIds);
    const topIds = [
      ...new Set(
        [...chains.values()]
          .map((chain) => chain[chain.length - 1])
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const liveRoots = new Set(
      topIds.length === 0
        ? []
        : (
            await db
              .select({ id: knowledge.id })
              .from(knowledge)
              .where(
                and(
                  inArray(knowledge.id, topIds),
                  isNull(knowledge.parent_id),
                  isNull(knowledge.archived_at),
                ),
              )
          ).map((row) => row.id),
    );
    for (const [nodeId, chain] of chains) {
      const top = chain[chain.length - 1];
      if (top && liveRoots.has(top)) refileRootByNode.set(nodeId, top);
    }
  }

  const recordRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(
      learning_record,
      sql`${learning_record.knowledge_ids} @> jsonb_build_array(${knowledge.id})`,
    )
    .where(and(inArray(knowledge.id, nodeIds), isNull(learning_record.archived_at)))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const recordCounts = new Map(recordRows.map((row) => [row.nodeId, Number(row.count)]));

  const itemRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(
      learning_item,
      sql`${learning_item.knowledge_ids} @> jsonb_build_array(${knowledge.id})`,
    )
    .where(and(inArray(knowledge.id, nodeIds), isNull(learning_item.archived_at)))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const itemCounts = new Map(itemRows.map((row) => [row.nodeId, Number(row.count)]));

  // A later-added mesh edge archives with the node, so any live incident edge is
  // later learner content. The node row lock also blocks new edges: an edge INSERT
  // takes a KEY SHARE lock on both endpoint rows through its foreign keys.
  const edgeRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(
      knowledge_edge,
      sql`(${knowledge_edge.from_knowledge_id} = ${knowledge.id} OR ${knowledge_edge.to_knowledge_id} = ${knowledge.id})`,
    )
    .where(and(inArray(knowledge.id, nodeIds), isNull(knowledge_edge.archived_at)))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const edgeCounts = new Map(edgeRows.map((row) => [row.nodeId, Number(row.count)]));

  const artifactRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(artifact, sql`${artifact.knowledge_ids} @> jsonb_build_array(${knowledge.id})`)
    .where(and(inArray(knowledge.id, nodeIds), isNull(artifact.archived_at)))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const artifactCounts = new Map(artifactRows.map((row) => [row.nodeId, Number(row.count)]));

  const goalRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(goal, sql`${goal.scope_knowledge_ids} @> jsonb_build_array(${knowledge.id})`)
    .where(inArray(knowledge.id, nodeIds))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const goalCounts = new Map(goalRows.map((row) => [row.nodeId, Number(row.count)]));

  const claimRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(placement_starter_claim, eq(placement_starter_claim.knowledge_id, knowledge.id))
    .where(inArray(knowledge.id, nodeIds))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const claimCounts = new Map(claimRows.map((row) => [row.nodeId, Number(row.count)]));

  const misconceptionRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(
      misconception_edge,
      and(eq(misconception_edge.to_kind, 'knowledge'), eq(misconception_edge.to_id, knowledge.id)),
    )
    .where(and(inArray(knowledge.id, nodeIds), isNull(misconception_edge.archived_at)))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const misconceptionCounts = new Map(
    misconceptionRows.map((row) => [row.nodeId, Number(row.count)]),
  );

  for (const check of checks) {
    const node = nodeById.get(check.nodeId);
    if (!node) {
      decisions.set(check.proposalId, blocked('knowledge_not_found', check.appliedAt));
      continue;
    }
    if (node.archivedAt !== null) {
      decisions.set(check.proposalId, blocked('knowledge_already_archived', check.appliedAt));
      continue;
    }
    if (node.version > 0) {
      decisions.set(check.proposalId, blocked('knowledge_later_edit', check.appliedAt));
      continue;
    }
    if ((childCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_children', check.appliedAt));
      continue;
    }
    if ((edgeCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_edges', check.appliedAt));
      continue;
    }
    if ((questionCounts.get(check.nodeId) ?? 0) > 0) {
      // Any non-companion attachment (a learner's own placement, a sourcing
      // merge) keeps blocking — retracting under it would silently refile work
      // the owner did not ask to move. Companion-authored questions are
      // undoable only while a live root ancestor exists to refile onto.
      if (
        (foreignQuestionCounts.get(check.nodeId) ?? 0) > 0 ||
        !refileRootByNode.has(check.nodeId)
      ) {
        decisions.set(check.proposalId, blocked('knowledge_has_questions', check.appliedAt));
        continue;
      }
    }
    if ((recordCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_records', check.appliedAt));
      continue;
    }
    if ((itemCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_learning_items', check.appliedAt));
      continue;
    }
    if ((artifactCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_artifacts', check.appliedAt));
      continue;
    }
    if ((goalCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_goals', check.appliedAt));
      continue;
    }
    if ((claimCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_placement_claims', check.appliedAt));
      continue;
    }
    if ((misconceptionCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(
        check.proposalId,
        blocked('knowledge_has_misconception_edges', check.appliedAt),
      );
    }
  }
}

interface CauseCheck {
  readonly proposalId: string;
  readonly categoryId: string;
  readonly appliedAt: Date;
}

async function classifyCauseCategories(
  db: DbLike,
  working: Map<string, { payload: AiProposalPayloadT; rate: RateRow }>,
  decisions: Map<string, AutoAppliedUndoDecision>,
): Promise<void> {
  const checks: CauseCheck[] = [];
  for (const [proposalId, entry] of working) {
    if (entry.payload.kind !== 'cause_category') continue;
    const categoryId = readString(entry.payload.proposed_change, 'category_id');
    if (!categoryId) {
      decisions.set(proposalId, failed('apply_record_missing', entry.rate.createdAt));
      continue;
    }
    checks.push({ proposalId, categoryId, appliedAt: entry.rate.createdAt });
  }
  if (checks.length === 0) return;

  const categoryIds = [...new Set(checks.map((check) => check.categoryId))];
  const rows = await db
    .select({
      id: cause_category_overlay.id,
      status: cause_category_overlay.status,
      archivedAt: cause_category_overlay.archived_at,
      proposalEventId: cause_category_overlay.proposal_event_id,
    })
    .from(cause_category_overlay)
    .where(inArray(cause_category_overlay.id, categoryIds));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  // A category already used by an attribution is load-bearing history: retracting it
  // makes later variant generation treat the cited cause as not targetable
  // (failure-learning-variant.ts). Judge events store it under `cause`; manual user
  // causes store it at the payload root.
  const usedCategoryIds = new Set<string>();
  for (const categoryId of categoryIds) {
    const [hit] = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          inArray(event.action, ['judge', 'experimental:user_cause']),
          sql`(
            ${event.payload} -> 'cause' ->> 'primary_category' = ${categoryId}
            OR ${event.payload} -> 'cause' -> 'secondary_categories' ? ${categoryId}
            OR ${event.payload} ->> 'primary_category' = ${categoryId}
          )`,
        ),
      )
      .limit(1);
    if (hit) usedCategoryIds.add(categoryId);
  }

  for (const check of checks) {
    const row = rowById.get(check.categoryId);
    if (!row) {
      decisions.set(check.proposalId, blocked('cause_not_found', check.appliedAt));
      continue;
    }
    if (row.proposalEventId !== check.proposalId) {
      decisions.set(check.proposalId, blocked('cause_not_owned', check.appliedAt));
      continue;
    }
    if (row.archivedAt !== null) {
      decisions.set(check.proposalId, blocked('cause_already_archived', check.appliedAt));
      continue;
    }
    if (row.status !== 'active') {
      decisions.set(check.proposalId, blocked('cause_not_active', check.appliedAt));
      continue;
    }
    if (usedCategoryIds.has(check.categoryId)) {
      decisions.set(check.proposalId, blocked('cause_used_in_attribution', check.appliedAt));
    }
  }
}

interface LearningItemRow {
  readonly sourceRef: string | null;
  readonly id: string;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
  readonly primaryArtifactId: string | null;
}

/** note_generate owns these body writes; they are not learner edits. */
const NOTE_GENERATE_EDIT_ACTORS: ReadonlySet<string> = new Set([
  'note_generate',
  'note_generate_retry',
  'note_generate_fallback',
]);

async function classifyLearningItems(
  db: DbLike,
  working: Map<string, { payload: AiProposalPayloadT; rate: RateRow }>,
  decisions: Map<string, AutoAppliedUndoDecision>,
): Promise<void> {
  const proposalIds = [...working]
    .filter(([, entry]) => entry.payload.kind === 'learning_item')
    .map(([proposalId]) => proposalId);
  if (proposalIds.length === 0) return;

  const rows = (await db
    .select({
      sourceRef: learning_item.source_ref,
      id: learning_item.id,
      archivedAt: learning_item.archived_at,
      updatedAt: learning_item.updated_at,
      primaryArtifactId: learning_item.primary_artifact_id,
    })
    .from(learning_item)
    .where(inArray(learning_item.source_ref, proposalIds))) as LearningItemRow[];
  const rowsByProposal = new Map<string, LearningItemRow[]>();
  for (const row of rows) {
    if (!row.sourceRef) continue;
    const list = rowsByProposal.get(row.sourceRef);
    if (list) list.push(row);
    else rowsByProposal.set(row.sourceRef, [row]);
  }

  const activeItemIds: string[] = [];
  const primaryArtifactIds: string[] = [];
  for (const proposalId of proposalIds) {
    for (const row of rowsByProposal.get(proposalId) ?? []) {
      if (row.archivedAt === null) activeItemIds.push(row.id);
      if (row.primaryArtifactId) primaryArtifactIds.push(row.primaryArtifactId);
    }
  }

  const artifacts = await db
    .select({
      id: artifact.id,
      sourceRef: artifact.source_ref,
      archivedAt: artifact.archived_at,
      version: artifact.version,
    })
    .from(artifact)
    .where(
      or(
        inArray(artifact.source_ref, proposalIds),
        primaryArtifactIds.length > 0 ? inArray(artifact.id, primaryArtifactIds) : undefined,
      ),
    );
  const artifactById = new Map(artifacts.map((row) => [row.id, row]));
  const artifactIdsByProposal = new Map<string, string[]>();
  for (const row of artifacts) {
    if (!row.sourceRef) continue;
    const list = artifactIdsByProposal.get(row.sourceRef);
    if (list) list.push(row.id);
    else artifactIdsByProposal.set(row.sourceRef, [row.id]);
  }
  const allArtifactIds = [...new Set(artifacts.map((row) => row.id))];

  // The artifact version is the only write-path-independent witness. Every
  // note_generate body commit advances it by exactly one; any other body write
  // (refine apply, refine undo, presence flush, hub auto sync, learner edit) also
  // advances it without adding a whitelisted event. So equal counts prove every
  // write came from generation, and any future writer is blocked by construction.
  const editedArtifactIds = new Set<string>();
  if (allArtifactIds.length > 0) {
    const editRows = await db
      .select({
        artifactId: event.subject_id,
        actorKind: event.actor_kind,
        actorRef: event.actor_ref,
      })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:body_blocks_edit'),
          eq(event.subject_kind, 'artifact'),
          inArray(event.subject_id, allArtifactIds),
        ),
      );
    const generationWrites = new Map<string, number>();
    for (const row of editRows) {
      if (row.actorKind !== 'agent') continue;
      if (!NOTE_GENERATE_EDIT_ACTORS.has(row.actorRef)) continue;
      generationWrites.set(row.artifactId, (generationWrites.get(row.artifactId) ?? 0) + 1);
    }
    for (const artifactId of allArtifactIds) {
      const row = artifactById.get(artifactId);
      if (!row) continue;
      if (row.version !== (generationWrites.get(artifactId) ?? 0)) {
        editedArtifactIds.add(artifactId);
      }
    }
  }

  // References from notes in the SAME proposal are part of that proposal: retract
  // archives the whole note family together, so those refs disappear with it. Only
  // a note outside the group is later content that a retract would orphan.
  const pairedArtifactIdsByProposal = new Map<string, Set<string>>();
  for (const proposalId of proposalIds) {
    const group = new Set<string>(artifactIdsByProposal.get(proposalId) ?? []);
    for (const item of rowsByProposal.get(proposalId) ?? []) {
      if (item.primaryArtifactId) group.add(item.primaryArtifactId);
    }
    pairedArtifactIdsByProposal.set(proposalId, group);
  }

  const refsByTarget = new Map<string, string[]>();
  if (allArtifactIds.length > 0) {
    const refs = await db
      .select({
        fromArtifactId: artifact_block_ref.from_artifact_id,
        toArtifactId: artifact_block_ref.to_artifact_id,
      })
      .from(artifact_block_ref)
      .where(
        and(
          inArray(artifact_block_ref.to_artifact_id, allArtifactIds),
          ne(artifact_block_ref.from_artifact_id, artifact_block_ref.to_artifact_id),
        ),
      );
    for (const row of refs) {
      const list = refsByTarget.get(row.toArtifactId);
      if (list) list.push(row.fromArtifactId);
      else refsByTarget.set(row.toArtifactId, [row.fromArtifactId]);
    }
  }
  const referencedArtifactIdsByProposal = new Map<string, Set<string>>();
  for (const proposalId of proposalIds) {
    const group = pairedArtifactIdsByProposal.get(proposalId) ?? new Set<string>();
    const referenced = new Set<string>();
    for (const artifactId of group) {
      for (const fromArtifactId of refsByTarget.get(artifactId) ?? []) {
        if (!group.has(fromArtifactId)) referenced.add(artifactId);
      }
    }
    referencedArtifactIdsByProposal.set(proposalId, referenced);
  }

  const draftItemIds = new Set<string>();
  if (activeItemIds.length > 0) {
    const drafts = await db
      .select({ learningItemId: answer.learning_item_id })
      .from(answer)
      .where(and(inArray(answer.learning_item_id, activeItemIds), isNull(answer.submitted_at)));
    for (const row of drafts) {
      if (row.learningItemId) draftItemIds.add(row.learningItemId);
    }
  }
  const recordItemIds = new Set<string>();
  if (activeItemIds.length > 0) {
    const linked = await db
      .select({ learningItemId: learning_record.learning_item_id })
      .from(learning_record)
      .where(
        and(
          inArray(learning_record.learning_item_id, activeItemIds),
          isNull(learning_record.archived_at),
        ),
      );
    for (const row of linked) {
      if (row.learningItemId) recordItemIds.add(row.learningItemId);
    }
  }

  for (const proposalId of proposalIds) {
    const entry = working.get(proposalId);
    if (!entry) continue;
    if (decisions.has(proposalId)) continue;
    const items = rowsByProposal.get(proposalId) ?? [];
    const active = items.filter((item) => item.archivedAt === null);
    const archived = items.filter((item) => item.archivedAt !== null);
    if (items.length === 0) {
      decisions.set(proposalId, blocked('learning_item_missing', entry.rate.createdAt));
      continue;
    }
    if (active.length === 0) {
      decisions.set(proposalId, blocked('learning_item_already_archived', entry.rate.createdAt));
      continue;
    }
    if (archived.length > 0) {
      decisions.set(proposalId, blocked('learning_item_partially_archived', entry.rate.createdAt));
      continue;
    }
    const latest = active.reduce(
      (max, item) => Math.max(max, asDate(item.updatedAt)?.getTime() ?? 0),
      0,
    );
    if (latest > entry.rate.createdAt.getTime()) {
      decisions.set(proposalId, blocked('learning_item_later_changes', entry.rate.createdAt));
      continue;
    }
    if (active.some((item) => recordItemIds.has(item.id))) {
      decisions.set(proposalId, blocked('learning_item_has_records', entry.rate.createdAt));
      continue;
    }
    if (active.some((item) => draftItemIds.has(item.id))) {
      decisions.set(proposalId, blocked('learning_item_has_answer_drafts', entry.rate.createdAt));
      continue;
    }
    const proposalArtifactIds = artifactIdsByProposal.get(proposalId) ?? [];
    const pairedArtifactIds = new Set([
      ...proposalArtifactIds,
      ...active.flatMap((item) => (item.primaryArtifactId ? [item.primaryArtifactId] : [])),
    ]);
    if (pairedArtifactIds.size === 0) {
      decisions.set(proposalId, blocked('learning_item_artifact_missing', entry.rate.createdAt));
      continue;
    }
    const missingOrArchived = [...pairedArtifactIds].some((artifactId) => {
      const row = artifactById.get(artifactId);
      return !row || row.archivedAt !== null;
    });
    if (missingOrArchived) {
      decisions.set(proposalId, blocked('learning_item_artifact_missing', entry.rate.createdAt));
      continue;
    }
    if ([...pairedArtifactIds].some((artifactId) => editedArtifactIds.has(artifactId))) {
      decisions.set(proposalId, blocked('learning_item_note_edited', entry.rate.createdAt));
      continue;
    }
    if (
      [...pairedArtifactIds].some((artifactId) =>
        referencedArtifactIdsByProposal.get(proposalId)?.has(artifactId),
      )
    ) {
      decisions.set(proposalId, blocked('learning_item_artifact_referenced', entry.rate.createdAt));
    }
  }
}
