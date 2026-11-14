// One snapshot and one provisional policy for the Coach page and per-item model input.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  type CompletionReceipt,
  CompletionReceiptV1,
  type FrozenCompletionSources,
} from '@/core/schema/learning-item-completion';
import type { Db, Tx } from '@/db/client';
import { event, goal, knowledge, learning_item, materialized_id_index } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { resolveGoalKnowledgeIds } from '@/kernel/read-models/active-goal-scope';
import type {
  FencedNativeMasteryReader,
  NativeMasteryBasis,
} from '@/kernel/read-models/native-mastery-basis';
import {
  progressSourceAllowed,
  readNativeMasteryBasis,
} from '@/kernel/read-models/native-mastery-basis';
import { gatherAndFoldGoal, goalRowToSnapshot } from '@/kernel/records/goal-history';
import { gatherAndFoldKnowledgeNode } from '@/kernel/records/knowledge-node-history';
import { gatherAndFoldLearningItem } from '@/kernel/records/learning-items';
import {
  COMPLETION_POLICY,
  type LearningItemKcProgress,
  evaluateCompletionKnowledge,
} from './completion-policy';

export type { LearningItemKcProgress } from './completion-policy';

const KnowledgeIds = z.array(z.string().min(1));
export interface LearningItemProgress {
  id: string;
  title: string;
  status: string;
  userPinned: boolean;
  version: number;
  eligible: boolean;
  reasons: string[];
  knowledge: LearningItemKcProgress[];
}
export interface LearningPlanProgress {
  observedAt: string;
  learnerTimeZone: 'Asia/Shanghai';
  policy: typeof COMPLETION_POLICY;
  items: LearningItemProgress[];
}

export async function loadLearningPlanProgress(database: Db): Promise<LearningPlanProgress> {
  return database.transaction(
    async (tx) => {
      const observedAt = new Date();
      const items = await tx
        .select()
        .from(learning_item)
        .where(
          and(
            isNull(learning_item.archived_at),
            inArray(learning_item.status, ['pending', 'in_progress']),
          ),
        )
        .orderBy(asc(learning_item.created_at), asc(learning_item.id));
      const ids = [...new Set(items.flatMap((item) => KnowledgeIds.parse(item.knowledge_ids)))];
      const facts = await readNativeMasteryBasis(tx, ids, observedAt);
      return evaluateProgress(tx, items, facts, observedAt);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function evaluateProgress(
  tx: Tx,
  items: Array<typeof learning_item.$inferSelect>,
  facts: Map<string, NativeMasteryBasis>,
  observedAt: Date,
): Promise<LearningPlanProgress> {
  const ids = [...new Set(items.flatMap((item) => KnowledgeIds.parse(item.knowledge_ids)))];
  const nodes = ids.length
    ? await tx.select().from(knowledge).where(inArray(knowledge.id, ids))
    : [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const unverifiedNodes = new Set<string>();
  for (const node of nodes) {
    const folded = await gatherAndFoldKnowledgeNode(tx, node.id);
    if (!folded || (folded.role ?? 'kc') !== node.role || folded.version !== node.version)
      unverifiedNodes.add(node.id);
  }
  const progress: LearningItemProgress[] = [];
  for (const item of items) {
    const reasons: string[] = [];
    let itemSourceAllowed = item.source === 'manual' && item.source_ref === null;
    if (item.source === 'learning_intent' && item.source_ref) {
      const [origin] = await tx.select().from(event).where(eq(event.id, item.source_ref));
      const payload = z
        .object({
          topic: z.string(),
          hub: z.object({ title: z.string() }),
          atomics: z.array(z.object({ knowledge_id: z.string() })),
        })
        .safeParse(origin?.payload);
      itemSourceAllowed =
        origin?.action === 'experimental:propose_learning_intent' &&
        payload.success &&
        (await progressSourceAllowed(tx, { kind: 'event', id: origin.id }));
    }
    if (!itemSourceAllowed) reasons.push('purpose_unavailable');
    const folded = await gatherAndFoldLearningItem(tx, item.id);
    if (
      !folded ||
      JSON.stringify(folded.knowledge_ids) !== JSON.stringify(item.knowledge_ids) ||
      folded.version !== item.version
    )
      reasons.push('item_scope_unverified');
    const children = await tx
      .select({ id: learning_item.id })
      .from(learning_item)
      .where(eq(learning_item.parent_learning_item_id, item.id));
    if (children.length || item.child_learning_item_ids.length) reasons.push('not_leaf');
    if (!item.knowledge_ids.length) reasons.push('empty_scope');
    const knowledgeProgress = evaluateCompletionKnowledge(
      item.knowledge_ids,
      facts,
      nodeMap,
      unverifiedNodes,
      observedAt,
      itemSourceAllowed,
    );
    progress.push({
      id: item.id,
      title:
        !itemSourceAllowed ||
        item.knowledge_ids.some((id) => facts.get(id)?.displayAllowed === false)
          ? '学习计划（来源暂不可用）'
          : item.title,
      status: item.status,
      userPinned: item.user_pinned,
      version: item.version,
      eligible:
        !reasons.length &&
        knowledgeProgress.length > 0 &&
        knowledgeProgress.every((k) => k.eligible),
      reasons,
      knowledge: knowledgeProgress,
    });
  }
  return {
    observedAt: observedAt.toISOString(),
    learnerTimeZone: 'Asia/Shanghai',
    policy: COMPLETION_POLICY,
    items: progress,
  };
}

/** Item scope belongs to agency; the supplied lifetime capability owns all mastery dependencies. */
export async function readCompletionReceipt(
  tx: Tx,
  reader: FencedNativeMasteryReader,
  itemId: string,
  observedAt = new Date(),
  originalSources: FrozenCompletionSources['nodes'] = [],
  subjectKind: 'learning_item' | 'goal' = 'learning_item',
): Promise<CompletionReceipt | null> {
  const [item] =
    subjectKind === 'learning_item'
      ? await tx
          .select()
          .from(learning_item)
          .where(eq(learning_item.id, itemId))
          .for('update', { noWait: true })
      : [];
  const [currentGoal] =
    subjectKind === 'goal'
      ? await tx.select().from(goal).where(eq(goal.id, itemId)).for('update', { noWait: true })
      : [];
  if (subjectKind === 'learning_item') {
    if (!item || item.archived_at || !['pending', 'in_progress'].includes(item.status)) return null;
  } else {
    if (currentGoal?.status !== 'active' || currentGoal.steering !== null) return null;
    if (
      !(
        (currentGoal.source === 'manual' && currentGoal.source_ref === null) ||
        (currentGoal.source === 'goal_scope_proposal' && currentGoal.source_ref)
      )
    )
      return null;
    const folded = await gatherAndFoldGoal(tx, itemId);
    if (
      !folded ||
      sha256CanonicalJson(folded) !== sha256CanonicalJson(goalRowToSnapshot(currentGoal))
    )
      return null;
  }
  const target = currentGoal ?? item;
  if (!target) return null;
  const [birth] = await tx
    .select()
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.subject_kind, subjectKind),
        eq(materialized_id_index.materialized_id, itemId),
      ),
    )
    .for('share', { noWait: true });
  if (!birth) return null;
  const ids = [
    ...new Set(
      KnowledgeIds.parse(
        currentGoal ? await resolveGoalKnowledgeIds(tx, currentGoal) : item?.knowledge_ids,
      ),
    ),
  ].sort();
  const sources = [
    ...originalSources,
    { kind: 'event' as const, id: birth.anchor_event_id },
    ...(target.source_ref ? [{ kind: 'event' as const, id: target.source_ref }] : []),
    ...(currentGoal
      ? (
          await tx
            .select({ id: event.id })
            .from(event)
            .where(
              and(
                eq(event.subject_kind, 'goal'),
                eq(event.subject_id, itemId),
                inArray(event.action, [
                  'experimental:goal_scope_update',
                  'experimental:goal_status_update',
                ]),
              ),
            )
        ).map(({ id }) => ({ kind: 'event' as const, id }))
      : []),
  ];
  if (!ids.length) return null;
  const basis = await reader.read(ids, sources, observedAt);
  if (!basis.sources) return null;
  if (item) {
    const progress = await evaluateProgress(tx, [item], basis.facts, observedAt);
    if (!progress.items[0]?.eligible) return null;
  }
  const nodes = await tx
    .select()
    .from(knowledge)
    .where(inArray(knowledge.id, ids))
    .orderBy(knowledge.id);
  if (currentGoal) {
    const unverifiedNodes = new Set<string>();
    for (const node of nodes) {
      const folded = await gatherAndFoldKnowledgeNode(tx, node.id);
      if (!folded || (folded.role ?? 'kc') !== node.role || folded.version !== node.version)
        unverifiedNodes.add(node.id);
    }
    const progress = evaluateCompletionKnowledge(
      ids,
      basis.facts,
      new Map(nodes.map((node) => [node.id, node])),
      unverifiedNodes,
      observedAt,
      true,
    );
    if (!progress.every((entry) => entry.eligible)) return null;
  }
  const scope = {
    item: currentGoal
      ? {
          subject_kind: 'goal',
          ...goalRowToSnapshot(currentGoal),
          created_at: currentGoal.created_at.toISOString(),
          updated_at: currentGoal.updated_at.toISOString(),
          knowledge_ids: ids,
          genesis: birth.anchor_event_id,
        }
      : item
        ? {
            id: item.id,
            version: item.version,
            status: item.status,
            source: item.source,
            source_ref: item.source_ref,
            parent: item.parent_learning_item_id,
            children: [...item.child_learning_item_ids].sort(),
            knowledge_ids: ids,
            genesis: birth.anchor_event_id,
          }
        : null,
    nodes: nodes.map((n) => ({
      id: n.id,
      version: n.version,
      role: n.role,
      parent: n.parent_id,
      merged_from: [...n.merged_from].sort(),
      approval: n.approval_status,
      archived_at: n.archived_at?.toISOString() ?? null,
    })),
  };
  const knowledgeProof = ids.map((id) => {
    const fact = basis.facts.get(id);
    const p = fact?.projection;
    if (!fact || !p || !fact.genesis || !p.last_outcome_at)
      throw new Error('eligible completion lacks native proof');
    return {
      id,
      genesis: fact.genesis,
      point: p.mastery,
      lo: p.mastery_lo,
      hi: p.mastery_hi,
      beta: p.beta,
      beta_basis: p.beta_basis,
      precision: p.theta_precision,
      counts: { evidence: p.evidence_count, success: p.success_count, fail: p.fail_count },
      last_outcome_at: p.last_outcome_at.toISOString(),
      evidence: [...fact.proof].sort((a, b) => a.groupId.localeCompare(b.groupId)),
      calibration: basis.calibration.filter((c) => fact.calibrationIds.includes(c.question_id)),
    };
  });
  const logical = {
    policy_version: 'native-completion-v1',
    policy: COMPLETION_POLICY,
    scope_digest: sha256CanonicalJson(scope),
    knowledge_ids: ids,
    item_id: target.id,
    item_version: target.version,
    knowledge: knowledgeProof,
    sources: basis.sources,
  };
  return CompletionReceiptV1.parse({
    ...logical,
    format_version: 1,
    measured_at: observedAt.toISOString(),
    logical_fact_digest: sha256CanonicalJson(logical),
    evidence_identity_digest: sha256CanonicalJson(
      knowledgeProof.map((k) => ({ id: k.id, evidence: k.evidence.filter((e) => e.correct) })),
    ),
  });
}

export function originalCompletionEvidenceStillCurrent(
  original: CompletionReceipt,
  current: CompletionReceipt,
): boolean {
  if (
    original.policy_version !== current.policy_version ||
    sha256CanonicalJson(original.policy) !== sha256CanonicalJson(current.policy) ||
    original.scope_digest !== current.scope_digest
  )
    return false;
  return original.knowledge.every((old) => {
    const now = current.knowledge.find((k) => k.id === old.id);
    return (
      now &&
      old.genesis === now.genesis &&
      old.evidence.every((e) =>
        now.evidence.some((n) => sha256CanonicalJson(n) === sha256CanonicalJson(e)),
      ) &&
      old.calibration.every((c) =>
        now.calibration.some((n) => n.question_id === c.question_id && n.beta === c.beta),
      )
    );
  });
}
