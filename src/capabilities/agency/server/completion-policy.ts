import { learnerLocalDay } from '@/core/learner-day';
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import type { knowledge } from '@/db/schema';
import type { NativeMasteryBasis } from '@/kernel/read-models/native-mastery-basis';

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

type CompletionKnowledge = Pick<
  typeof knowledge.$inferSelect,
  'id' | 'name' | 'role' | 'archived_at' | 'approval_status' | 'merged_from'
>;

export function evaluateCompletionKnowledge(
  ids: readonly string[],
  facts: ReadonlyMap<string, NativeMasteryBasis>,
  nodes: ReadonlyMap<string, CompletionKnowledge>,
  unverifiedNodes: ReadonlySet<string>,
  observedAt: Date,
  sourceAllowed: boolean,
): LearningItemKcProgress[] {
  return [...new Set(ids)].map((id): LearningItemKcProgress => {
    const node = nodes.get(id);
    const fact = facts.get(id);
    const failures = [...(fact?.reasons ?? ['missing_knowledge'])];
    if (!sourceAllowed) failures.push('purpose_unavailable');
    if (
      node?.role !== 'kc' ||
      node.archived_at ||
      node.approval_status !== 'approved' ||
      node.merged_from.length ||
      unverifiedNodes.has(id)
    )
      failures.push('unsupported_knowledge_scope');
    const projection = fact?.projection;
    const band = projection ? masteryBandView(projection) : null;
    const mastery =
      projection && band && !band.unknown
        ? {
            point: projection.mastery,
            lo: projection.mastery_lo,
            hi: projection.mastery_hi,
            band: A5_BANDS[band.band],
            lastOutcomeAt: projection.last_outcome_at?.toISOString() ?? null,
          }
        : null;
    const recent = (fact?.occurrences ?? []).filter((occurrence) => {
      const time = new Date(occurrence.occurredAt).getTime();
      return (
        time <= observedAt.getTime() &&
        time >= observedAt.getTime() - COMPLETION_POLICY.windowDays * DAY_MS
      );
    });
    const correct = recent.filter((occurrence) => occurrence.correct);
    const groups = new Set(correct.map((occurrence) => occurrence.groupId));
    const anchors = new Set(correct.map((occurrence) => occurrence.anchorId));
    const days = new Set(
      correct.map((occurrence) => learnerLocalDay(new Date(occurrence.occurredAt))),
    );
    const latestAt =
      correct
        .map((occurrence) => occurrence.occurredAt)
        .sort()
        .at(-1) ?? null;
    if (sourceAllowed && fact?.nativeCountsAvailable) {
      if (
        groups.size < COMPLETION_POLICY.minimumOccurrences ||
        anchors.size < COMPLETION_POLICY.minimumOccurrences
      )
        failures.push('insufficient_independent_evidence');
      if (days.size < COMPLETION_POLICY.minimumLocalDays) failures.push('insufficient_local_days');
      if (
        !latestAt ||
        observedAt.getTime() - new Date(latestAt).getTime() >
          COMPLETION_POLICY.latestHours * 3_600_000
      )
        failures.push('stale_evidence');
      if (recent.some((occurrence) => occurrence.adverse)) failures.push('recent_adverse_evidence');
    } else failures.push('native_evidence_unavailable');
    if (!mastery) failures.push('mastery_unavailable');
    else if (mastery.point < COMPLETION_POLICY.minimumMastery)
      failures.push('mastery_below_threshold');
    return {
      knowledgeId: id,
      name: sourceAllowed && fact?.displayAllowed ? (node?.name ?? null) : null,
      mastery: sourceAllowed && node?.role === 'kc' && !node.archived_at ? mastery : null,
      eligible: failures.length === 0,
      reasons: [...new Set(failures)],
      evidence:
        sourceAllowed && fact?.nativeCountsAvailable
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
}
