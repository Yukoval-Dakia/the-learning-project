// One snapshot and one provisional policy for the Coach page and per-item model input.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { learnerLocalDay } from '@/core/learner-day';
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import {
  type CompletionReceipt,
  CompletionReceiptV1,
  type FrozenCompletionSources,
} from '@/core/schema/learning-item-completion';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, learning_item, materialized_id_index } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type {
  FencedNativeMasteryReader,
  NativeMasteryBasis,
} from '@/kernel/read-models/native-mastery-basis';
import {
  progressSourceAllowed,
  readNativeMasteryBasis,
} from '@/kernel/read-models/native-mastery-basis';
import { gatherAndFoldKnowledgeNode } from '@/kernel/records/knowledge-node-history';
import { gatherAndFoldLearningItem } from '@/kernel/records/learning-items';

const KnowledgeIds = z.array(z.string().min(1));
export const COMPLETION_POLICY = {
  windowDays: 7,
  minimumOccurrences: 5,
  minimumLocalDays: 2,
  latestHours: 72,
  minimumMastery: 0.8,
} as const;
const DAY_MS = 86_400_000;
export interface LearningItemKcProgress {
  knowledgeId: string;
  name: string | null;
  mastery: {
    point: number;
    lo: number;
    hi: number;
    band: string;
    lastOutcomeAt: string | null;
  } | null;
  eligible: boolean;
  reasons: string[];
  evidence: {
    occurrences: number;
    anchors: number;
    localDays: number;
    latestAt: string | null;
    pending: number;
  } | null;
}
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
    const knowledgeProgress = [...new Set(item.knowledge_ids)].map((id): LearningItemKcProgress => {
      const node = nodeMap.get(id);
      const fact = facts.get(id);
      const failures = [...(fact?.reasons ?? ['missing_knowledge'])];
      if (!itemSourceAllowed) failures.push('purpose_unavailable');
      if (
        node?.role !== 'kc' ||
        node.archived_at ||
        node.approval_status !== 'approved' ||
        node.merged_from.length ||
        unverifiedNodes.has(id)
      )
        failures.push('unsupported_knowledge_scope');
      const p = fact?.projection;
      const band = p ? masteryBandView(p) : null;
      const mastery =
        p && band && !band.unknown
          ? {
              point: p.mastery,
              lo: p.mastery_lo,
              hi: p.mastery_hi,
              band: A5_BANDS[band.band],
              lastOutcomeAt: p.last_outcome_at?.toISOString() ?? null,
            }
          : null;
      const recent = (fact?.occurrences ?? []).filter((o) => {
        const time = new Date(o.occurredAt).getTime();
        return (
          time <= observedAt.getTime() &&
          time >= observedAt.getTime() - COMPLETION_POLICY.windowDays * DAY_MS
        );
      });
      const correct = recent.filter((o) => o.correct);
      const groups = new Set(correct.map((o) => o.groupId));
      const anchors = new Set(correct.map((o) => o.anchorId));
      const days = new Set(correct.map((o) => learnerLocalDay(new Date(o.occurredAt))));
      const latestAt =
        correct
          .map((o) => o.occurredAt)
          .sort()
          .at(-1) ?? null;
      if (itemSourceAllowed && fact?.nativeCountsAvailable) {
        if (
          groups.size < COMPLETION_POLICY.minimumOccurrences ||
          anchors.size < COMPLETION_POLICY.minimumOccurrences
        )
          failures.push('insufficient_independent_evidence');
        if (days.size < COMPLETION_POLICY.minimumLocalDays)
          failures.push('insufficient_local_days');
        if (
          !latestAt ||
          observedAt.getTime() - new Date(latestAt).getTime() >
            COMPLETION_POLICY.latestHours * 3_600_000
        )
          failures.push('stale_evidence');
        if (recent.some((o) => o.adverse)) failures.push('recent_adverse_evidence');
      } else failures.push('native_evidence_unavailable');
      if (!mastery) failures.push('mastery_unavailable');
      else if (mastery.point < COMPLETION_POLICY.minimumMastery)
        failures.push('mastery_below_threshold');
      return {
        knowledgeId: id,
        name: itemSourceAllowed && fact?.displayAllowed ? (node?.name ?? null) : null,
        mastery: itemSourceAllowed && node?.role === 'kc' && !node.archived_at ? mastery : null,
        eligible: failures.length === 0,
        reasons: [...new Set(failures)],
        evidence:
          itemSourceAllowed && fact?.nativeCountsAvailable
            ? {
                occurrences: groups.size,
                anchors: anchors.size,
                localDays: days.size,
                latestAt,
                pending: fact.pendingCount,
              }
            : null,
      };
    });
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
): Promise<CompletionReceipt | null> {
  const [item] = await tx
    .select()
    .from(learning_item)
    .where(eq(learning_item.id, itemId))
    .for('update', { noWait: true });
  if (!item || item.archived_at || !['pending', 'in_progress'].includes(item.status)) return null;
  const [birth] = await tx
    .select()
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.subject_kind, 'learning_item'),
        eq(materialized_id_index.materialized_id, itemId),
      ),
    )
    .for('share', { noWait: true });
  if (!birth) return null;
  const ids = [...new Set(KnowledgeIds.parse(item.knowledge_ids))].sort();
  const sources = [
    ...originalSources,
    { kind: 'event' as const, id: birth.anchor_event_id },
    ...(item.source_ref ? [{ kind: 'event' as const, id: item.source_ref }] : []),
  ];
  const basis = await reader.read(ids, sources, observedAt);
  const progress = await evaluateProgress(tx, [item], basis.facts, observedAt);
  if (!progress.items[0]?.eligible || !basis.sources) return null;
  const nodes = await tx
    .select()
    .from(knowledge)
    .where(inArray(knowledge.id, ids))
    .orderBy(knowledge.id);
  const scope = {
    item: {
      id: item.id,
      version: item.version,
      status: item.status,
      source: item.source,
      source_ref: item.source_ref,
      parent: item.parent_learning_item_id,
      children: [...item.child_learning_item_ids].sort(),
      knowledge_ids: ids,
      genesis: birth.anchor_event_id,
    },
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
    item_id: item.id,
    item_version: item.version,
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
