// Projects one knowledge point onto the band, evidence, decay, due and retention
// the knowledge page and question detail already render. Unknown stays null.

import { A5_BANDS, type MasteryBandInput, masteryBandView } from '@/core/mastery-band';
import type { MasteryDecayBucket } from '@/core/mastery-freshness';
import {
  type KnowledgeSignal,
  absentSignal,
  knownSignal,
  unknownSignal,
} from '@/core/schema/knowledge-signal';
import type { LearnerJudgment } from '@/core/schema/learner-judgment';

export const LEARNER_JUDGMENT_SOURCE =
  'kernel/read-models/learner-judgment:readLearnerJudgments' as const;

export type DecayBand = Exclude<MasteryDecayBucket, 'unknown'>;

export type KnowledgeStateJudgment = Pick<
  LearnerJudgment,
  'ability' | 'ability_claim' | 'retention' | 'review_timing'
>;

export type KnowledgeStateProjection = {
  band: KnowledgeSignal<(typeof A5_BANDS)[number]>;
  evidence_count: KnowledgeSignal<number>;
  decay: KnowledgeSignal<DecayBand>;
  due_at: KnowledgeSignal<string>;
  retention: KnowledgeSignal<number>;
};

function claimReason(claim: KnowledgeStateJudgment['ability_claim']): string {
  switch (claim.kind) {
    case 'observed':
    case 'low_observed':
      return 'ability_reading_missing';
    default:
      return claim.reason;
  }
}

function evidencedReading(judgment: KnowledgeStateJudgment): MasteryBandInput | null {
  const claim = judgment.ability_claim.kind;
  if (claim !== 'observed' && claim !== 'low_observed') return null;
  if (judgment.ability.kind !== 'available') return null;
  return judgment.ability.reading;
}

function retentionValue(retention: KnowledgeStateJudgment['retention']): number | null {
  if (retention.kind !== 'available') return null;
  if (typeof retention.reading === 'number') return retention.reading;
  return retention.reading.kind === 'score' ? retention.reading.value : null;
}

function retentionReason(retention: KnowledgeStateJudgment['retention']): string {
  if (retention.kind === 'unknown') return retention.reason;
  return typeof retention.reading === 'object' && retention.reading.kind === 'unknown'
    ? retention.reading.reason
    : 'missing_scheduling_state';
}

export function projectKnowledgeState(
  judgment: KnowledgeStateJudgment,
  asOf: Date,
): KnowledgeStateProjection {
  const reading = evidencedReading(judgment);
  const reason = claimReason(judgment.ability_claim);
  const view = reading ? masteryBandView(reading) : null;
  const band =
    !reading || !view
      ? unknownSignal<(typeof A5_BANDS)[number]>(LEARNER_JUDGMENT_SOURCE, asOf, reason)
      : view.unknown
        ? unknownSignal<(typeof A5_BANDS)[number]>(
            LEARNER_JUDGMENT_SOURCE,
            asOf,
            'mastery_not_finite',
          )
        : knownSignal(A5_BANDS[view.band], LEARNER_JUDGMENT_SOURCE, asOf);
  const evidence = reading
    ? knownSignal(reading.evidence_count, LEARNER_JUDGMENT_SOURCE, asOf)
    : unknownSignal<number>(LEARNER_JUDGMENT_SOURCE, asOf, reason);
  const bucket = judgment.review_timing.freshness.decay_bucket;
  const decay =
    bucket === 'unknown'
      ? unknownSignal<DecayBand>(LEARNER_JUDGMENT_SOURCE, asOf, reason)
      : knownSignal(bucket, LEARNER_JUDGMENT_SOURCE, asOf);
  const due = judgment.review_timing.freshness.due_at;
  const dueAt =
    due.kind === 'known'
      ? knownSignal(due.at.toISOString(), LEARNER_JUDGMENT_SOURCE, asOf)
      : due.kind === 'absent'
        ? absentSignal<string>(LEARNER_JUDGMENT_SOURCE, asOf)
        : unknownSignal<string>(LEARNER_JUDGMENT_SOURCE, asOf, due.reason);
  const retentionNumber = retentionValue(judgment.retention);
  const retention =
    retentionNumber === null
      ? unknownSignal<number>(LEARNER_JUDGMENT_SOURCE, asOf, retentionReason(judgment.retention))
      : knownSignal(retentionNumber, LEARNER_JUDGMENT_SOURCE, asOf);
  return { band, evidence_count: evidence, decay, due_at: dueAt, retention };
}
