import { z } from 'zod';
import {
  AppendReceiptSchema,
  ContextKeySchema,
  DAY_MS,
  DigestSchema,
  type Due,
  ENGINEERING_MODEL,
  ENGINEERING_SCHEDULE,
  EffectiveObservationSchema,
  EpochMsSchema,
  type EvidenceInput,
  FractionSchema,
  LearnerIdSchema,
  type MemoryState,
  MemoryStateSchema,
  ScoreSchema,
  SequenceKeySchema,
  SkillIdSchema,
  VERSIONS,
  VersionsSchema,
  adaptEvidence,
  arrange,
  coldState,
  due,
  fallbackSchedule,
  replay,
  retention,
} from '@/core/forgetting';
import { canonicalHash, stableStringify } from '@/core/migration/canonical';
import { type CandidateState, CandidateStateSchema } from '@/core/schema/scheduling-state';

export const CandidateFactSchema = z
  .object({
    submissionId: z.string(),
    evaluationId: z.string(),
    occurredAt: z.coerce.date(),
    revisionId: z.string(),
    context: z.string().nullable(),
    source: z.enum(['judged', 'self_report']),
    judgment: z.enum(['deterministic', 'admitted', 'unknown']),
    judgeRevision: z.string().nullable(),
    help: z.enum(['none', 'shallow', 'deep', 'answer', 'unknown']),
    guess: z.enum(['yes', 'no', 'unknown']),
    confidence: z.enum(['low', 'medium', 'high', 'unknown']),
    hints_used: z.number().nullable(),
    final_hint_level: z.number().nullable(),
    self_confidence: z.number().nullable(),
    latency_ms: z.number().nullable(),
    legacyScopeVersion: z.number().int().optional(),
    identityRemap: z.object({ fromIds: z.array(z.string()), toId: z.string() }).optional(),
    points: z.array(
      z.object({
        maximum: z.number(),
        earned: z.number(),
        shares: z.array(z.object({ skillId: z.string(), share: z.number() })),
      }),
    ),
  })
  .strict();
export const CandidateReplayInputSchema = z.object({
  seed: MemoryStateSchema.pick({
    learnerId: true,
    skillId: true,
    scope: true,
    versions: true,
    inputDigest: true,
  }),
  effective: z.array(
    z.object({
      observation: EffectiveObservationSchema,
      recordedSequence: z.number().int().nonnegative(),
      receipt: AppendReceiptSchema,
    }),
  ),
  queryTime: EpochMsSchema,
  knowledgeCutoff: z.number().int().nonnegative(),
  model: z.object({
    versions: VersionsSchema,
    provenance: z.literal('engineering'),
    fastHalfLifeDays: z.number(),
    slowHalfLifeDays: z.number(),
    fastWeight: FractionSchema,
    gain: z.number(),
    failureRate: z.number(),
    spacingDays: z.number(),
  }),
});
export type CandidateReplayInput = z.infer<typeof CandidateReplayInputSchema>;
export type CandidateFact = z.infer<typeof CandidateFactSchema>;
export const SealedCandidateInputSchema = z.object({
  versions: VersionsSchema,
  adaptedEvidence: z.array(
    z.union([
      z.object({ kind: z.literal('included'), observation: EffectiveObservationSchema }),
      z.object({
        kind: z.literal('excluded'),
        evidenceRefs: z.array(z.string()),
        reason: z.string(),
      }),
    ]),
  ),
  fact: CandidateFactSchema,
  evidenceDigest: DigestSchema,
  orderKey: SequenceKeySchema,
  recordedSequence: z.number().int().nonnegative(),
});
export type SealedCandidateInput = z.infer<typeof SealedCandidateInputSchema>;
export function sealCandidateFact(raw: CandidateFact): SealedCandidateInput {
  const fact = CandidateFactSchema.parse(raw);
  const ms = fact.occurredAt.getTime();
  const input = {
    fact,
    evidenceDigest: DigestSchema.parse(canonicalHash(fact)),
    orderKey: SequenceKeySchema.parse(
      `${String(BigInt(ms) + 8_640_000_000_000_000n).padStart(17, '0')}:${fact.submissionId}`,
    ),
    recordedSequence: ms,
  };
  return SealedCandidateInputSchema.parse({
    ...input,
    versions: VERSIONS,
    // Historical receipts attest the original mapping, separately from current admission.
    adaptedEvidence: mappedCandidateObservations(input),
  });
}
function seed(skillId: string, context?: string) {
  return {
    learnerId: LearnerIdSchema.parse('self'),
    skillId: SkillIdSchema.parse(skillId),
    scope: context
      ? { kind: 'context' as const, key: ContextKeySchema.parse(context) }
      : { kind: 'global' as const },
    versions: VERSIONS,
    inputDigest: DigestSchema.parse(
      canonicalHash({ skillId, context: context ?? null, versions: VERSIONS }),
    ),
  };
}
function mappedCandidateObservations(
  input: Pick<SealedCandidateInput, 'fact' | 'evidenceDigest' | 'orderKey' | 'recordedSequence'>,
) {
  const fact = CandidateFactSchema.parse(input.fact);
  const evidence: EvidenceInput = {
    identity: {
      learnerId: LearnerIdSchema.parse('self'),
      attemptId: fact.submissionId,
      effectiveJudgmentId: fact.evaluationId,
      context: fact.context
        ? { kind: 'known', value: ContextKeySchema.parse(fact.context) }
        : { kind: 'unknown', reason: 'context_not_recorded' },
      orderKey: input.orderKey,
      evidenceDigest: input.evidenceDigest,
      evidenceRefs: [fact.submissionId, fact.evaluationId, fact.revisionId],
      mappingNotes: [
        ...(fact.legacyScopeVersion === undefined
          ? []
          : [`legacy_frozen_group_scope:${fact.legacyScopeVersion}`]),
        ...(fact.identityRemap
          ? [`identity_remap:${fact.identityRemap.fromIds.join(',')}:${fact.identityRemap.toId}`]
          : []),
      ],
    },
    occurredAt: { kind: 'known', value: EpochMsSchema.parse(fact.occurredAt.getTime()) },
    source: fact.source,
    judgment: fact.judgment,
    judgeRevision: fact.judgeRevision
      ? { kind: 'known', value: fact.judgeRevision }
      : { kind: 'unknown', reason: 'judge_revision_missing' },
    help: fact.help,
    guess: fact.guess,
    confidence: fact.confidence,
    duration:
      fact.latency_ms === null
        ? { kind: 'unknown', reason: 'latency_missing' }
        : { kind: 'known', value: fact.latency_ms },
    processEvidenceRefs: [],
    scoring: {
      kind: 'mapped',
      points: fact.points.map((p) => ({
        ...p,
        shares: p.shares.map((s) => ({ ...s, skillId: SkillIdSchema.parse(s.skillId) })),
      })),
    },
  };
  return adaptEvidence(evidence).map((observation) =>
    observation.kind === 'excluded' &&
    observation.reason === 'unattributed_scoring' &&
    fact.points.some((point) => point.shares.length === 0)
      ? { ...observation, reason: 'unattributed_multi_skill' }
      : observation,
  );
}
const ATTRIBUTION_REBUILD_REASON = 'unattributed_multi_skill_requires_rebuild';
/** Old seals have shares but no scoring-unit/part proof; do not infer a partial split. */
export function candidatePointsForAdmission(fact: CandidateFact) {
  return fact.points.map((point) =>
    fact.source === 'judged' &&
    point.earned > 0 &&
    point.earned < point.maximum &&
    new Set(point.shares.filter((share) => share.share > 0).map((share) => share.skillId)).size > 1
      ? { ...point, shares: [] }
      : point,
  );
}
export function candidateObservations(
  input: Pick<SealedCandidateInput, 'fact' | 'evidenceDigest' | 'orderKey' | 'recordedSequence'>,
) {
  return mappedCandidateObservations({
    ...input,
    fact: { ...input.fact, points: candidatePointsForAdmission(input.fact) },
  }).map((observation) =>
    observation.kind === 'excluded' && observation.reason === 'unattributed_multi_skill'
      ? { ...observation, reason: ATTRIBUTION_REBUILD_REASON }
      : observation,
  );
}
export function validateCandidateInput(raw: SealedCandidateInput): SealedCandidateInput {
  const input = SealedCandidateInputSchema.parse(raw);
  if (stableStringify(input) !== stableStringify(sealCandidateFact(input.fact)))
    throw new Error('candidate input receipt mismatch');
  return input;
}

export function candidateView(state: CandidateState) {
  return {
    global: state.global,
    context: { kind: 'unknown' as const, reason: 'global_read' },
    requestedScope: { kind: 'global' as const },
  };
}
export function projectCandidateDue(
  state: CandidateState,
  asOf: Date,
  explicitUserNotBefore?: Date,
) {
  const ms = EpochMsSchema.parse(asOf.getTime());
  const result = due({
    view: candidateView(state),
    asOf: ms,
    target: ScoreSchema.parse(ENGINEERING_SCHEDULE.targetScore),
    horizonAt: EpochMsSchema.parse(ms + ENGINEERING_SCHEDULE.horizonDays * DAY_MS),
    model: ENGINEERING_MODEL,
  });
  return projectDueResult(result, asOf, state.last_review, explicitUserNotBefore);
}
/** Projection policy is independent of the model and preserves the producing kind. */
export function projectDueResult(
  result: Due,
  asOf: Date,
  lastCompletedAt: Date | null,
  explicitUserNotBefore?: Date,
) {
  const ms = EpochMsSchema.parse(asOf.getTime());
  const fallback = result.kind === 'unknown' || result.kind === 'invalid_input';
  const constraints = {
    lastCompletedAt: lastCompletedAt
      ? { kind: 'known' as const, value: EpochMsSchema.parse(lastCompletedAt.getTime()) }
      : { kind: 'unknown' as const, reason: 'no_completed_review' },
    explicitUserNotBefore: explicitUserNotBefore
      ? { kind: 'known' as const, value: EpochMsSchema.parse(explicitUserNotBefore.getTime()) }
      : { kind: 'unknown' as const, reason: 'not_requested' },
  };
  const schedule = fallback
    ? fallbackSchedule({ asOf: ms, constraints })
    : arrange({ asOf: ms, modelDue: result, constraints });
  if (schedule.kind !== 'eligible') throw new Error(`candidate schedule: ${schedule.reason}`);
  return {
    due: new Date(schedule.eligibleAt),
    modelDue: result,
    dueKind: result.kind,
    fallbackReason: fallback ? result.reason : null,
  };
}
export function initialCandidateState(skillId: string, now: Date): CandidateState {
  return CandidateStateSchema.parse({
    engine: 'forgetting_candidate',
    schemaVersion: 'scheduling-state-v1',
    global: coldState(seed(skillId)),
    contexts: {},
    conversion: 'initial',
    provenance: 'engineering',
    calibration: 'uncalibrated',
    due: now,
    last_review: null,
    dueKind: 'initial',
    fallbackReason: null,
  });
}
/** Rebuild from caller-resolved live immutable facts. No computed score enters a digest. */
export function rebuildCandidate(
  skillId: string,
  facts: readonly SealedCandidateInput[],
  asOf: Date,
  conversion: CandidateState['conversion'],
  historySubjectIds: string[] = [],
  recordReplayInput?: (input: CandidateReplayInput) => void,
) {
  const unique = new Map<string, SealedCandidateInput>();
  for (const raw of facts) {
    const fact = validateCandidateInput(raw);
    const old = unique.get(fact.fact.submissionId);
    if (old && stableStringify(old) !== stableStringify(fact))
      throw new Error('candidate attempt conflict');
    unique.set(fact.fact.submissionId, fact);
  }
  const selected = [...unique.values()]
    .filter((f) => f.fact.occurredAt <= asOf)
    .toSorted((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
  const observations = selected.flatMap((f) =>
    candidateObservations(f).flatMap((o) =>
      o.kind === 'included' && o.observation.skillId === skillId
        ? [
            {
              observation: o.observation,
              recordedSequence: f.recordedSequence,
              digest: f.evidenceDigest,
            },
          ]
        : [],
    ),
  );
  function projection(context?: string): MemoryState {
    const initial = seed(skillId, context);
    let digest = initial.inputDigest;
    const effective = observations
      .filter(
        (o) =>
          !context ||
          (o.observation.context.kind === 'known' && o.observation.context.value === context),
      )
      .map((o) => {
        const next = DigestSchema.parse(canonicalHash({ previous: digest, fact: o.digest }));
        const receipt = {
          previousInputDigest: digest,
          nextInputDigest: next,
          nextThrough: o.observation.orderKey,
        };
        digest = next;
        return { observation: o.observation, recordedSequence: o.recordedSequence, receipt };
      });
    const replayInput = CandidateReplayInputSchema.parse({
      seed: initial,
      effective,
      queryTime: EpochMsSchema.parse(asOf.getTime()),
      knowledgeCutoff: Number.MAX_SAFE_INTEGER,
      model: ENGINEERING_MODEL,
    });
    recordReplayInput?.(replayInput);
    const result = replay(replayInput);
    if (result.kind !== 'updated' && result.kind !== 'duplicate')
      throw new Error(`candidate replay ${result.kind}: ${result.reason}`);
    return result.state;
  }
  const contexts = [
    ...new Set(
      observations.flatMap((o) =>
        o.observation.context.kind === 'known' ? [o.observation.context.value] : [],
      ),
    ),
  ];
  const state = {
    ...initialCandidateState(skillId, asOf),
    global: projection(),
    contexts: Object.fromEntries(contexts.map((c) => [c, projection(c)])),
    conversion,
    historySubjectIds,
    last_review: observations.length
      ? new Date(observations[observations.length - 1].observation.occurredAt)
      : null,
  };
  const schedule = projectCandidateDue(state, asOf);
  const needsAttribution =
    observations.length === 0 &&
    selected.some((input) =>
      candidateObservations(input).some(
        (observation) =>
          observation.kind === 'excluded' && observation.reason === ATTRIBUTION_REBUILD_REASON,
      ),
    );
  return CandidateStateSchema.parse({
    ...state,
    ...schedule,
    fallbackReason: needsAttribution ? ATTRIBUTION_REBUILD_REASON : schedule.fallbackReason,
  });
}
export function candidateRetention(state: CandidateState, now: Date) {
  return retention({
    view: candidateView(state),
    asOf: EpochMsSchema.parse(now.getTime()),
    offsetsDays: [],
    model: ENGINEERING_MODEL,
  });
}
