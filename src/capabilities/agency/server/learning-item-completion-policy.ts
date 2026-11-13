// One snapshot and one provisional policy for the Coach page and per-item model input.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { learnerLocalDay } from '@/core/learner-day';
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import type { Db } from '@/db/client';
import { event, knowledge, learning_item } from '@/db/schema';
import {
  progressSourceAllowed,
  readNativeMasteryBasis,
} from '@/kernel/read-models/native-mastery-basis';
import { gatherAndFoldKnowledgeNode } from '@/kernel/records/knowledge-node-history';
import { gatherAndFoldLearningItem } from '@/kernel/records/learning-items';

const KnowledgeIds = z.array(z.string().min(1));
const POLICY = {
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
  policy: typeof POLICY;
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
      const facts = await readNativeMasteryBasis(tx, ids, observedAt);
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
        const knowledgeProgress = [...new Set(item.knowledge_ids)].map(
          (id): LearningItemKcProgress => {
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
                time >= observedAt.getTime() - POLICY.windowDays * DAY_MS
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
                groups.size < POLICY.minimumOccurrences ||
                anchors.size < POLICY.minimumOccurrences
              )
                failures.push('insufficient_independent_evidence');
              if (days.size < POLICY.minimumLocalDays) failures.push('insufficient_local_days');
              if (
                !latestAt ||
                observedAt.getTime() - new Date(latestAt).getTime() > POLICY.latestHours * 3_600_000
              )
                failures.push('stale_evidence');
              if (recent.some((o) => o.adverse)) failures.push('recent_adverse_evidence');
            } else failures.push('native_evidence_unavailable');
            if (!mastery) failures.push('mastery_unavailable');
            else if (mastery.point < POLICY.minimumMastery)
              failures.push('mastery_below_threshold');
            return {
              knowledgeId: id,
              name: itemSourceAllowed && fact?.displayAllowed ? (node?.name ?? null) : null,
              mastery:
                itemSourceAllowed && node?.role === 'kc' && !node.archived_at ? mastery : null,
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
          },
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
        policy: POLICY,
        items: progress,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
