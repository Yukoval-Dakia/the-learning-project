// Knowledge-owned later-content rules for undoing an auto-applied `knowledge_node`.
//
// Mirrors knowledge's retract applier (`retractKnowledgeCreate`): the node row,
// its version, attached questions and the auto-ownership proof are the same facts,
// so the inbox verdict and the backend cannot disagree. References that archive
// would orphan but knowledge does not own — learning records, learning items, note
// labels, goal scopes, placement claims, misconception edges — are declared here
// and answered by each owning capability through the composition root.
//
// The order below is the verdict precedence the inbox has always reported; two
// conditions at once must still yield the same code.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { knowledge, knowledge_edge } from '@/db/schema';
import { findExistingRateEvent } from '@/kernel/proposals/applier-helpers';
import {
  type AutoAppliedUndoBlock,
  type AutoAppliedUndoGuardInput,
  type AutoAppliedUndoOwnerGuard,
  type DbLike,
  genericUndoBlock,
} from '@/kernel/proposals/auto-applied-undo';
import {
  isAutoOwnedAttachment,
  loadAttachmentChangeMap,
  selectNodeAttachedQuestions,
} from '@/kernel/proposals/node-question-attachments';
import { batchResolveAncestorIds } from '@/kernel/read-models/knowledge-tree';

/** Node ids from the queried set that still carry live content owned elsewhere. */
export type KnowledgeNodeUsageProbe = (
  db: DbLike,
  nodeIds: readonly string[],
) => Promise<ReadonlySet<string>>;

/** Reference answers owned by the capabilities that create the referencing rows. */
export interface KnowledgeNodeUndoDependencies {
  /** Live learning records whose `knowledge_ids` include the node (practice/settlement). */
  readonly learningRecords: KnowledgeNodeUsageProbe;
  /** Live learning items whose `knowledge_ids` include the node (agency). */
  readonly learningItems: KnowledgeNodeUsageProbe;
  /** Live notes labelled with the node (notes). */
  readonly noteLabels: KnowledgeNodeUsageProbe;
  /** Goals whose scope covers the node (agency). */
  readonly goalScopes: KnowledgeNodeUsageProbe;
  /** Placement starter claims that still need the node (practice/supply). */
  readonly placementClaims: KnowledgeNodeUsageProbe;
  /** Live misconception edges anchored on the node (practice/failure-learning). */
  readonly misconceptionEdges: KnowledgeNodeUsageProbe;
}

const REASONS = {
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
} as const;

type KnowledgeBlockCode = keyof typeof REASONS;

function block(code: KnowledgeBlockCode, clearsInBatch = false): AutoAppliedUndoBlock {
  return {
    status: 'blocked',
    code,
    reason_md: REASONS[code],
    ...(clearsInBatch ? { clears_in_batch: true as const } : {}),
  };
}

/** The node minted by a knowledge_node accept, from the rate's materialization facts. */
function appliedKnowledgeNodeId(ratePayload: unknown): string | null {
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

interface KnowledgeCheck {
  readonly proposalId: string;
  readonly nodeId: string;
}

async function inspectKnowledgeNodes(
  db: DbLike,
  inputs: readonly AutoAppliedUndoGuardInput[],
  dependencies: KnowledgeNodeUndoDependencies,
): Promise<Map<string, AutoAppliedUndoBlock>> {
  const blocks = new Map<string, AutoAppliedUndoBlock>();
  const checks: KnowledgeCheck[] = [];
  for (const input of inputs) {
    const nodeId = appliedKnowledgeNodeId(input.ratePayload);
    if (!nodeId) {
      blocks.set(input.proposalId, genericUndoBlock('failed', 'apply_record_missing'));
      continue;
    }
    checks.push({ proposalId: input.proposalId, nodeId });
  }
  if (checks.length === 0) return blocks;

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
  // event-history rule the retract applier enforces, so the card verdict and
  // the backend cannot disagree.
  const questionCounts = new Map<string, number>();
  const foreignQuestionCounts = new Map<string, number>();
  for (const nodeId of nodeIds) {
    const attached = await selectNodeAttachedQuestions(db, nodeId);
    const changes = await loadAttachmentChangeMap(
      db,
      attached.map((row) => row.id),
    );
    questionCounts.set(nodeId, attached.length);
    foreignQuestionCounts.set(
      nodeId,
      attached.filter((row) => !isAutoOwnedAttachment(row, nodeId, changes)).length,
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

  const [recordNodes, itemNodes, artifactNodes, goalNodes, claimNodes, misconceptionNodes] =
    await Promise.all([
      dependencies.learningRecords(db, nodeIds),
      dependencies.learningItems(db, nodeIds),
      dependencies.noteLabels(db, nodeIds),
      dependencies.goalScopes(db, nodeIds),
      dependencies.placementClaims(db, nodeIds),
      dependencies.misconceptionEdges(db, nodeIds),
    ]);

  for (const check of checks) {
    const node = nodeById.get(check.nodeId);
    if (!node) {
      blocks.set(check.proposalId, block('knowledge_not_found'));
      continue;
    }
    if (node.archivedAt !== null) {
      blocks.set(check.proposalId, block('knowledge_already_archived'));
      continue;
    }
    if (node.version > 0) {
      blocks.set(check.proposalId, block('knowledge_later_edit'));
      continue;
    }
    if ((childCounts.get(check.nodeId) ?? 0) > 0) {
      // An earlier item of the same batch may retract the child first.
      blocks.set(check.proposalId, block('knowledge_has_children', true));
      continue;
    }
    if ((edgeCounts.get(check.nodeId) ?? 0) > 0) {
      blocks.set(check.proposalId, block('knowledge_has_edges'));
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
        blocks.set(check.proposalId, block('knowledge_has_questions'));
        continue;
      }
    }
    if (recordNodes.has(check.nodeId)) {
      blocks.set(check.proposalId, block('knowledge_has_records'));
      continue;
    }
    if (itemNodes.has(check.nodeId)) {
      blocks.set(check.proposalId, block('knowledge_has_learning_items'));
      continue;
    }
    if (artifactNodes.has(check.nodeId)) {
      blocks.set(check.proposalId, block('knowledge_has_artifacts'));
      continue;
    }
    if (goalNodes.has(check.nodeId)) {
      blocks.set(check.proposalId, block('knowledge_has_goals'));
      continue;
    }
    if (claimNodes.has(check.nodeId)) {
      blocks.set(check.proposalId, block('knowledge_has_placement_claims'));
      continue;
    }
    if (misconceptionNodes.has(check.nodeId)) {
      blocks.set(check.proposalId, block('knowledge_has_misconception_edges'));
    }
  }
  return blocks;
}

/** Locks the node row the archive applier will mutate. */
async function lockKnowledgeNode(tx: Tx, input: AutoAppliedUndoGuardInput): Promise<void> {
  const rate = await findExistingRateEvent(tx, input.proposalId);
  const nodeId = rate ? appliedKnowledgeNodeId(rate.payload) : null;
  if (!nodeId) return;
  await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(eq(knowledge.id, nodeId))
    .for('update');
}

export function createKnowledgeNodeUndoGuard(
  dependencies: KnowledgeNodeUndoDependencies,
): AutoAppliedUndoOwnerGuard {
  return {
    inspect: (db, inputs) => inspectKnowledgeNodes(db, inputs, dependencies),
    lock: lockKnowledgeNode,
  };
}
