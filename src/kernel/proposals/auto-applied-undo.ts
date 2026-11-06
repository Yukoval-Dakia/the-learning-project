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

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { type AiProposalPayloadT, parseAiProposalPayload } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { event } from '@/db/schema';
import { cause_category_overlay, knowledge } from '@/db/schema/knowledge';
import { learning_item, learning_record } from '@/db/schema/learning';
import { question } from '@/db/schema/question';
import { getCorrectionStatuses } from '@/kernel/events';
import { PROPOSAL_AUTOAPPLY_ACTION } from './auto-apply';

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
  | 'knowledge_has_questions'
  | 'knowledge_has_records'
  | 'knowledge_has_learning_items'
  | 'cause_not_found'
  | 'cause_not_owned'
  | 'cause_already_archived'
  | 'cause_not_active'
  | 'learning_item_missing'
  | 'learning_item_already_archived'
  | 'learning_item_partially_archived'
  | 'learning_item_later_changes'
  | 'learning_item_has_records';

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
  knowledge_has_questions: '已经有题目挂在这个知识点上，撤销会让它们失去归属，所以先保留了。',
  knowledge_has_records: '已经有错题或学习记录关联这个知识点，撤销会让它们失去归属，所以先保留了。',
  knowledge_has_learning_items:
    '已经有学习项挂在这个知识点上，撤销会中断正在进行的计划，所以先保留了。',
  cause_not_found: '这个错因类目已经找不到了。',
  cause_not_owned: '这个错因类目已经不由这条改动负责，不能再撤销。',
  cause_already_archived: '这个错因类目已经被归档，不需要再撤销。',
  cause_not_active: '这个错因类目当前不在词表里，不能撤销。',
  learning_item_missing: '这批学习项已经找不到了。',
  learning_item_already_archived: '这些学习项已经被归档，不需要再撤销。',
  learning_item_partially_archived:
    '其中部分学习项已经被归档，撤销会对不上原来的计划，所以先保留了。',
  learning_item_later_changes: '这些学习项之后有了新的进展，撤销会丢掉进度，所以先保留了。',
  learning_item_has_records: '这些学习项已经产生练习记录，撤销会让记录失去关联，所以先保留了。',
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

  const questionRows = (await db
    .select({ nodeId: knowledge.id, count: sql<number>`count(*)::int` })
    .from(knowledge)
    .innerJoin(question, sql`${question.knowledge_ids} @> jsonb_build_array(${knowledge.id})`)
    .where(and(inArray(knowledge.id, nodeIds), notDraftPredicate(question.draft_status)))
    .groupBy(knowledge.id)) as Array<{ nodeId: string; count: number }>;
  const questionCounts = new Map(questionRows.map((row) => [row.nodeId, Number(row.count)]));

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
    if ((questionCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_questions', check.appliedAt));
      continue;
    }
    if ((recordCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_records', check.appliedAt));
      continue;
    }
    if ((itemCounts.get(check.nodeId) ?? 0) > 0) {
      decisions.set(check.proposalId, blocked('knowledge_has_learning_items', check.appliedAt));
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
    }
  }
}

interface LearningItemRow {
  readonly sourceRef: string | null;
  readonly id: string;
  readonly archivedAt: Date | null;
  readonly updatedAt: Date;
}

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
  for (const proposalId of proposalIds) {
    for (const row of rowsByProposal.get(proposalId) ?? []) {
      if (row.archivedAt === null) activeItemIds.push(row.id);
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
    }
  }
}
