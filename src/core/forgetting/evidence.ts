import { ENGINEERING_MAPPING } from './model';
import {
  type AdaptedObservation,
  type EffectiveObservation,
  EffectiveObservationSchema,
  type Known,
  ScoreSchema,
  type SkillId,
} from './types';

export type ScoringPoint = Readonly<{
  maximum: number;
  earned: number;
  shares: readonly Readonly<{ skillId: SkillId; share: number }>[];
}>;
export type EvidenceInput = Readonly<{
  identity: Omit<
    EffectiveObservation,
    'skillId' | 'quality' | 'weight' | 'independent' | 'occurredAt'
  >;
  occurredAt: Known<EffectiveObservation['occurredAt']>;
  source: 'judged' | 'self_report' | 'reading' | 'conversation' | 'agent_explanation';
  judgment: 'deterministic' | 'admitted' | 'unadmitted' | 'withdrawn' | 'unknown';
  judgeRevision: Known<string>;
  help: 'none' | 'shallow' | 'deep' | 'answer' | 'unknown';
  guess: 'yes' | 'no' | 'unknown';
  confidence: 'low' | 'medium' | 'high' | 'unknown';
  // Retained evidence only. Neither elapsed time nor process flaws change result quality.
  duration: Known<number>;
  processEvidenceRefs: readonly string[];
  scoring:
    | { kind: 'mapped'; points: readonly ScoringPoint[] }
    | { kind: 'single_skill'; skillId: SkillId; maximum: number; earned: number }
    | { kind: 'unattributed_multi_skill' };
}>;
export function adaptEvidence(input: EvidenceInput): readonly AdaptedObservation[] {
  const refs = input.identity.evidenceRefs;
  const excluded = (reason: string): readonly AdaptedObservation[] => [
    { kind: 'excluded', evidenceRefs: refs, reason },
  ];
  if (input.source !== 'judged' && input.source !== 'self_report')
    return excluded('separate_evidence');
  if (input.judgment !== 'deterministic' && input.judgment !== 'admitted')
    return excluded('judgment_not_admitted');
  if (input.judgment === 'admitted' && input.judgeRevision.kind === 'unknown')
    return excluded('missing_admission_revision');
  if (input.occurredAt.kind === 'unknown') return excluded('missing_occurrence_time');
  if (input.help === 'unknown') return excluded('help_unknown');
  if (input.scoring.kind === 'unattributed_multi_skill')
    return excluded('unattributed_multi_skill');
  const points =
    input.scoring.kind === 'single_skill'
      ? [
          {
            maximum: input.scoring.maximum,
            earned: input.scoring.earned,
            shares: [{ skillId: input.scoring.skillId, share: 1 }],
          },
        ]
      : input.scoring.points;
  let total = 0;
  const skills = new Map<SkillId, { maximum: number; earned: number }>();
  for (const p of points) {
    if (
      !Number.isFinite(p.maximum) ||
      p.maximum <= 0 ||
      !Number.isFinite(p.earned) ||
      p.earned < 0 ||
      p.earned > p.maximum
    )
      return excluded('invalid_scoring');
    const seen = new Set<SkillId>();
    let sum = 0;
    for (const s of p.shares) {
      if (
        !s.skillId ||
        seen.has(s.skillId) ||
        !Number.isFinite(s.share) ||
        s.share < 0 ||
        s.share > 1
      )
        return excluded('invalid_mapping');
      seen.add(s.skillId);
      sum += s.share;
      const old = skills.get(s.skillId) ?? { maximum: 0, earned: 0 };
      skills.set(s.skillId, {
        maximum: old.maximum + s.share * p.maximum,
        earned: old.earned + s.share * p.earned,
      });
    }
    if (sum > 1) return excluded('overallocated_mapping');
    total += p.maximum;
  }
  if (!Number.isFinite(total) || total <= 0) return excluded('invalid_scoring');
  const help = {
    none: 1,
    shallow: ENGINEERING_MAPPING.shallowHelp,
    deep: ENGINEERING_MAPPING.deepHelp,
    answer: ENGINEERING_MAPPING.answerExposure,
  }[input.help];
  const guess =
    input.guess === 'yes'
      ? ENGINEERING_MAPPING.guessed
      : input.guess === 'unknown'
        ? ENGINEERING_MAPPING.guessUnknown
        : 1;
  const confidence = input.confidence === 'low' ? ENGINEERING_MAPPING.lowConfidence : 1;
  const result: AdaptedObservation[] = [];
  let attributed = 0;
  for (const [skillId, p] of skills) {
    attributed += p.maximum;
    if (p.maximum === 0) continue;
    const parsed = EffectiveObservationSchema.safeParse({
      ...input.identity,
      skillId,
      occurredAt: input.occurredAt.value,
      quality: p.earned / p.maximum,
      weight:
        (p.maximum / total) *
        help *
        guess *
        confidence *
        (input.source === 'self_report' ? ENGINEERING_MAPPING.selfReport : 1),
      independent: input.source === 'judged' && input.help === 'none' && input.guess === 'no',
      mappingNotes: [
        ...input.identity.mappingNotes,
        `source:${input.source}`,
        ...(input.guess === 'unknown' ? ['guess_missing'] : []),
        ...(input.confidence === 'unknown' ? ['confidence_unknown_modifier_disabled'] : []),
        `help:${input.help}`,
        `guess:${input.guess}`,
        `confidence:${input.confidence}`,
        ...(input.judgeRevision.kind === 'known'
          ? [`judge_revision:${input.judgeRevision.value}`]
          : []),
      ],
    });
    if (!parsed.success) return excluded('invalid_observation');
    result.push({ kind: 'included', observation: parsed.data });
  }
  if (attributed < total)
    result.push({ kind: 'excluded', evidenceRefs: refs, reason: 'unattributed_scoring' });
  return result.length === 0 ? excluded('zero_weight') : result;
}
export function weakestRequiredSkillScore(
  points: readonly Known<ReturnType<typeof ScoreSchema.parse>>[],
): Known<ReturnType<typeof ScoreSchema.parse>> {
  if (points.length === 0) return { kind: 'unknown', reason: 'no_required_skills' };
  let minimum = 1;
  for (const p of points) {
    if (p.kind === 'unknown') return p;
    if (!ScoreSchema.safeParse(p.value).success)
      return { kind: 'unknown', reason: 'invalid_score' };
    minimum = Math.min(minimum, p.value);
  }
  return { kind: 'known', value: ScoreSchema.parse(minimum) };
}
