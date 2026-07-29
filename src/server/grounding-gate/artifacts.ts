import { createHash } from 'node:crypto';
import type { ConjectureEvidenceImageSource } from '@/capabilities/agency/server/conjecture/evidence';
import type { InduceConjectureResult } from '@/server/agency/conjecture/induce';
import type { GroundingGateCandidate } from '@/server/grounding-gate/candidates';
import { z } from 'zod';

export const GROUNDING_GATE_SCHEMA_VERSION = 1;
export const GROUNDING_GATE_MIN_CLUSTERS = 6;
export const GROUNDING_GATE_MAX_CLUSTERS = 10;
export const GROUNDING_GATE_DEFAULT_CLUSTERS = 8;
export const GROUNDING_GATE_MIN_GROUNDING_RATE = 0.8;
export const GROUNDING_GATE_CANARY_RUNS = 10;

const NullableReviewBoolean = z.boolean().nullable();
const GateIdSchema = z.string().min(1);
const ClusterIdSchema = z.string().regex(/^cluster-\d{2}$/);

export const GroundingBlindReviewSchema = z.object({
  grounded_proposal: NullableReviewBoolean,
  discipline_hallucination: NullableReviewBoolean,
  claim_probe_mismatch: NullableReviewBoolean,
  severe_factual_error: NullableReviewBoolean,
  notes: z.string().default(''),
});
export type GroundingBlindReview = z.infer<typeof GroundingBlindReviewSchema>;

const BlindEvidenceSampleSchema = z.object({
  question_prompt_md: z.string(),
  question_reference_md: z.string().nullable(),
  question_choices_md: z.array(z.string()).nullable(),
  parent_question_prompt_md: z.string().nullable(),
  parent_question_reference_md: z.string().nullable(),
  parent_question_choices_md: z.array(z.string()).nullable(),
  owner_answer_md: z.string().nullable(),
  owner_reasoning_trace: z.string().nullable(),
  cause_category: z.string(),
  cause_source: z.enum(['owner', 'judge']),
  cause_attribution_md: z.string().nullable(),
  images: z.array(
    z.object({
      file: z.string(),
      source: z.enum(['question', 'parent_question', 'answer']),
    }),
  ),
});

const BlindShadowOutputSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('proposal'),
    claim_md: z.string(),
    probe_md: z.string(),
    probe_reference_md: z.string(),
    followup_probe_md: z.string(),
    followup_probe_reference_md: z.string(),
  }),
  z.object({
    outcome: z.literal('abstain'),
    reason_code: z.string(),
    explanation_md: z.string().nullable(),
  }),
]);

export const GroundingBlindItemSchema = z.object({
  cluster_id: ClusterIdSchema,
  subject_display_name: z.string().nullable(),
  knowledge_name: z.string().nullable(),
  cause_category: z.string(),
  recurrence_count: z.number().int().min(2),
  evidence_samples: z.array(BlindEvidenceSampleSchema).min(1),
  shadow_output: BlindShadowOutputSchema,
  review: GroundingBlindReviewSchema,
});

export const GroundingBlindPacketSchema = z
  .object({
    schema_version: z.literal(GROUNDING_GATE_SCHEMA_VERSION),
    gate_id: GateIdSchema,
    source_backup_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    generated_at: z.string().datetime(),
    instructions: z.string().min(1),
    requested_sample_count: z
      .number()
      .int()
      .min(GROUNDING_GATE_MIN_CLUSTERS)
      .max(GROUNDING_GATE_MAX_CLUSTERS),
    selection_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    items: z.array(GroundingBlindItemSchema),
  })
  .superRefine((packet, ctx) => {
    const ids = packet.items.map((item) => item.cluster_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'cluster_id values must be unique',
      });
    }
  });
export type GroundingBlindPacket = z.infer<typeof GroundingBlindPacketSchema>;

type BlindSelectionLockInput = Pick<
  GroundingBlindPacket,
  | 'schema_version'
  | 'gate_id'
  | 'source_backup_sha256'
  | 'generated_at'
  | 'instructions'
  | 'requested_sample_count'
  | 'items'
>;

function blindSelectionSha256(packet: BlindSelectionLockInput): string {
  const payload = {
    schema_version: packet.schema_version,
    gate_id: packet.gate_id,
    source_backup_sha256: packet.source_backup_sha256,
    generated_at: packet.generated_at,
    instructions: packet.instructions,
    requested_sample_count: packet.requested_sample_count,
    items: packet.items,
  };
  return createHash('sha256')
    .update(
      JSON.stringify(payload, (key, value) => {
        return key === 'review' ? undefined : value;
      }),
    )
    .digest('hex');
}

export const GroundingPrivateMapSchema = z.object({
  schema_version: z.literal(GROUNDING_GATE_SCHEMA_VERSION),
  gate_id: GateIdSchema,
  source_backup_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  code_revision: z.string().min(1),
  window: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  selection_seed: z.string().min(1),
  eligible_count: z.number().int().nonnegative(),
  clusters: z.array(
    z.object({
      cluster_id: ClusterIdSchema,
      conjecture_key: z.string(),
      knowledge_id: z.string(),
      attempt_event_ids: z.array(z.string()),
      question_ids: z.array(z.string()),
      asset_ids: z.array(z.string()),
      prior_claim_md: z.string().nullable(),
      task_run_ids: z.array(z.string()),
      primary_task_run_id: z.string().nullable(),
      cost_usd: z.number().nonnegative(),
      confidence: z.number().min(0).max(1),
      confidence_capped: z.boolean(),
      votes: z.object({
        proposal: z.number().int().nonnegative(),
        abstain: z.number().int().nonnegative(),
        invalid: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      }),
    }),
  ),
});
export type GroundingPrivateMap = z.infer<typeof GroundingPrivateMapSchema>;

export interface SelectedGroundingCandidate {
  cluster_id: string;
  candidate: GroundingGateCandidate;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectGroundingCandidates(
  candidates: readonly GroundingGateCandidate[],
  sampleSize: number,
  seed: string,
): SelectedGroundingCandidate[] {
  if (
    !Number.isInteger(sampleSize) ||
    sampleSize < GROUNDING_GATE_MIN_CLUSTERS ||
    sampleSize > GROUNDING_GATE_MAX_CLUSTERS
  ) {
    throw new Error(
      `sample size must be an integer in [${GROUNDING_GATE_MIN_CLUSTERS}, ${GROUNDING_GATE_MAX_CLUSTERS}]`,
    );
  }
  if (candidates.length < sampleSize) {
    throw new Error(
      `only ${candidates.length} eligible real clusters; ${sampleSize} requested (minimum gate size is ${GROUNDING_GATE_MIN_CLUSTERS})`,
    );
  }
  const selected = [...candidates]
    .map((candidate) => ({
      candidate,
      digest: createHash('sha256')
        .update(seed)
        .update('\0')
        .update(candidate.cell.key)
        .digest('hex'),
    }))
    .sort(
      (left, right) =>
        compareAscii(left.digest, right.digest) ||
        compareAscii(left.candidate.cell.key, right.candidate.cell.key),
    )
    .slice(0, sampleSize);
  return selected.map(({ candidate }, index) => ({
    cluster_id: `cluster-${String(index + 1).padStart(2, '0')}`,
    candidate,
  }));
}

export interface BuildGroundingReviewArtifactsInput {
  gateId: string;
  sourceBackupSha256: string;
  generatedAt: Date;
  codeRevision: string;
  selectionSeed: string;
  window: { from: Date; to: Date };
  eligibleCount: number;
  results: Array<{
    selected: SelectedGroundingCandidate;
    induced: InduceConjectureResult;
    imagesByAttemptId: ReadonlyMap<
      string,
      Array<{ file: string; source: ConjectureEvidenceImageSource }>
    >;
  }>;
}

function blindShadowOutput(induced: InduceConjectureResult) {
  if (induced.outcome === 'proposal') {
    return {
      outcome: 'proposal' as const,
      claim_md: induced.draft.claim_md,
      probe_md: induced.draft.probe_md,
      probe_reference_md: induced.draft.probe_reference_md,
      followup_probe_md: induced.draft.followup_probe_md,
      followup_probe_reference_md: induced.draft.followup_probe_reference_md,
    };
  }
  return {
    outcome: 'abstain' as const,
    reason_code: induced.draft.reason_code,
    explanation_md: induced.draft.explanation_md ?? null,
  };
}

function blindCauseSource(
  source: 'user' | 'agent' | null,
  attemptEventId: string,
): 'owner' | 'judge' {
  if (source === 'user') return 'owner';
  if (source === 'agent') return 'judge';
  throw new Error(
    `grounding blind artifact cannot represent attempt ${attemptEventId} without an effective cause_source`,
  );
}

function requireBlindEvidenceField<T>(value: T | null, field: string, attemptEventId: string): T {
  if (value !== null) return value;
  throw new Error(
    `grounding blind artifact cannot represent attempt ${attemptEventId} without ${field}`,
  );
}

export function buildGroundingReviewArtifacts(input: BuildGroundingReviewArtifactsInput): {
  blind: GroundingBlindPacket;
  privateMap: GroundingPrivateMap;
} {
  const blindBase: BlindSelectionLockInput = {
    schema_version: GROUNDING_GATE_SCHEMA_VERSION,
    gate_id: input.gateId,
    source_backup_sha256: input.sourceBackupSha256,
    generated_at: input.generatedAt.toISOString(),
    instructions:
      '逐簇核对证据与 shadow 输出。grounded_proposal 只有在 claim、两道 probe 及 reference 均由证据支持且可用于教学验证时填 true；abstain 填 false。其余三项任一 true 都是红线。不要查看 private-lineage.json 后再评分。',
    requested_sample_count: input.results.length,
    items: input.results.map(({ selected, induced, imagesByAttemptId }) => ({
      cluster_id: selected.cluster_id,
      subject_display_name: selected.candidate.cell.subject_display_name,
      knowledge_name: selected.candidate.cell.knowledge_name,
      cause_category: selected.candidate.cell.cause_category,
      recurrence_count: selected.candidate.cell.recurrence_count,
      evidence_samples: selected.candidate.cell.samples.map((sample) => ({
        question_prompt_md: requireBlindEvidenceField(
          sample.question_prompt_md,
          'question_prompt_md',
          sample.attempt_event_id,
        ),
        question_reference_md: sample.question_reference_md,
        question_choices_md: sample.question_choices_md,
        parent_question_prompt_md: sample.parent_question_prompt_md,
        parent_question_reference_md: sample.parent_question_reference_md,
        parent_question_choices_md: sample.parent_question_choices_md,
        owner_answer_md: sample.answer_md,
        owner_reasoning_trace: sample.reasoning_trace,
        cause_category: requireBlindEvidenceField(
          sample.cause_category,
          'an effective cause_category',
          sample.attempt_event_id,
        ),
        cause_source: blindCauseSource(sample.cause_source, sample.attempt_event_id),
        cause_attribution_md: sample.cause_attribution_md,
        images: imagesByAttemptId.get(sample.attempt_event_id) ?? [],
      })),
      shadow_output: blindShadowOutput(induced),
      review: {
        grounded_proposal: null,
        discipline_hallucination: null,
        claim_probe_mismatch: null,
        severe_factual_error: null,
        notes: '',
      },
    })),
  };
  const blind = GroundingBlindPacketSchema.parse({
    ...blindBase,
    selection_sha256: blindSelectionSha256(blindBase),
  });
  const privateMap = GroundingPrivateMapSchema.parse({
    schema_version: GROUNDING_GATE_SCHEMA_VERSION,
    gate_id: input.gateId,
    source_backup_sha256: input.sourceBackupSha256,
    code_revision: input.codeRevision,
    window: {
      from: input.window.from.toISOString(),
      to: input.window.to.toISOString(),
    },
    selection_seed: input.selectionSeed,
    eligible_count: input.eligibleCount,
    clusters: input.results.map(({ selected, induced }) => ({
      cluster_id: selected.cluster_id,
      conjecture_key: selected.candidate.cell.key,
      knowledge_id: selected.candidate.cell.knowledge_id,
      attempt_event_ids: selected.candidate.cell.evidence_event_ids,
      question_ids: [
        ...new Set(selected.candidate.cell.samples.map((sample) => sample.question_id)),
      ],
      asset_ids: selected.candidate.evidence_images.map((image) => image.asset_id),
      prior_claim_md: selected.candidate.prior_claim_md,
      task_run_ids: induced.task_run_ids,
      primary_task_run_id: induced.outcome === 'proposal' ? induced.primary_task_run_id : null,
      cost_usd: induced.cost_usd,
      confidence: induced.confidence,
      confidence_capped: induced.confidence_capped,
      votes: induced.votes,
    })),
  });
  return { blind, privateMap };
}

export const GroundingBlindScoreSchema = z.object({
  schema_version: z.literal(GROUNDING_GATE_SCHEMA_VERSION),
  gate_id: GateIdSchema,
  status: z.enum(['pass', 'fail', 'incomplete']),
  expansion_allowed: z.boolean(),
  sample_count: z.number().int().nonnegative(),
  requested_sample_count: z.number().int().nonnegative(),
  reviewed_count: z.number().int().nonnegative(),
  grounded_count: z.number().int().nonnegative(),
  grounding_rate: z.number().min(0).max(1).nullable(),
  redlines: z.object({
    discipline_hallucination: z.number().int().nonnegative(),
    claim_probe_mismatch: z.number().int().nonnegative(),
    severe_factual_error: z.number().int().nonnegative(),
  }),
  requirements: z.object({
    sample_size_6_to_10: z.boolean(),
    original_sample_count_preserved: z.boolean(),
    selection_digest_preserved: z.boolean(),
    all_items_reviewed: z.boolean(),
    grounding_at_least_80_percent: z.boolean(),
    zero_redlines: z.boolean(),
  }),
});
export type GroundingBlindScore = z.infer<typeof GroundingBlindScoreSchema>;

function reviewComplete(review: GroundingBlindReview): boolean {
  return (
    review.grounded_proposal !== null &&
    review.discipline_hallucination !== null &&
    review.claim_probe_mismatch !== null &&
    review.severe_factual_error !== null
  );
}

export function scoreGroundingBlindPacket(packet: GroundingBlindPacket): GroundingBlindScore {
  const parsed = GroundingBlindPacketSchema.parse(packet);
  const sampleCount = parsed.items.length;
  const originalSampleCountPreserved = sampleCount === parsed.requested_sample_count;
  const selectionDigestPreserved = blindSelectionSha256(parsed) === parsed.selection_sha256;
  const selectionIntegrityPreserved = originalSampleCountPreserved && selectionDigestPreserved;
  const reviewed = parsed.items.filter((item) => reviewComplete(item.review));
  const allItemsReviewed = reviewed.length === sampleCount;
  const groundedCount = reviewed.filter((item) => item.review.grounded_proposal === true).length;
  const groundingRate =
    selectionIntegrityPreserved && allItemsReviewed && sampleCount > 0
      ? groundedCount / sampleCount
      : null;
  const redlines = {
    discipline_hallucination: parsed.items.filter(
      (item) => item.review.discipline_hallucination === true,
    ).length,
    claim_probe_mismatch: parsed.items.filter((item) => item.review.claim_probe_mismatch === true)
      .length,
    severe_factual_error: parsed.items.filter((item) => item.review.severe_factual_error === true)
      .length,
  };
  const sampleSizeOk =
    sampleCount >= GROUNDING_GATE_MIN_CLUSTERS && sampleCount <= GROUNDING_GATE_MAX_CLUSTERS;
  const groundingOk = groundingRate !== null && groundingRate >= GROUNDING_GATE_MIN_GROUNDING_RATE;
  const zeroRedlines = Object.values(redlines).every((count) => count === 0);
  const pass =
    selectionIntegrityPreserved && sampleSizeOk && allItemsReviewed && groundingOk && zeroRedlines;
  return GroundingBlindScoreSchema.parse({
    schema_version: GROUNDING_GATE_SCHEMA_VERSION,
    gate_id: parsed.gate_id,
    status: !selectionIntegrityPreserved
      ? 'fail'
      : !allItemsReviewed
        ? 'incomplete'
        : pass
          ? 'pass'
          : 'fail',
    expansion_allowed: pass,
    sample_count: sampleCount,
    requested_sample_count: parsed.requested_sample_count,
    reviewed_count: reviewed.length,
    grounded_count: groundedCount,
    grounding_rate: groundingRate,
    redlines,
    requirements: {
      sample_size_6_to_10: sampleSizeOk,
      original_sample_count_preserved: originalSampleCountPreserved,
      selection_digest_preserved: selectionDigestPreserved,
      all_items_reviewed: allItemsReviewed,
      grounding_at_least_80_percent: groundingOk,
      zero_redlines: zeroRedlines,
    },
  });
}

const CanaryReviewSchema = z.object({
  post_reviewed: NullableReviewBoolean,
  discipline_hallucination: NullableReviewBoolean,
  claim_probe_mismatch: NullableReviewBoolean,
  severe_factual_error: NullableReviewBoolean,
  monitoring_snapshot_ref: z.string().nullable(),
  notes: z.string().default(''),
});

export const GroundingCanaryPacketSchema = z.object({
  schema_version: z.literal(GROUNDING_GATE_SCHEMA_VERSION),
  gate_id: GateIdSchema,
  blind_score_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  owner_cohort_ref: z.string().nullable(),
  runs: z.array(
    z.object({
      run_id: z.string(),
      intervention_ref: z.string().nullable(),
      review: CanaryReviewSchema,
    }),
  ),
  stop_switch_rehearsal: z.object({
    control_ref: z.string().nullable(),
    audit_ref: z.string().nullable(),
    disabled_before_new_schedule: NullableReviewBoolean,
    existing_records_retained: NullableReviewBoolean,
  }),
});
export type GroundingCanaryPacket = z.infer<typeof GroundingCanaryPacketSchema>;

export const GroundingCanaryScoreSchema = z.object({
  schema_version: z.literal(GROUNDING_GATE_SCHEMA_VERSION),
  gate_id: GateIdSchema,
  status: z.enum(['pass', 'fail', 'incomplete']),
  expansion_allowed: z.boolean(),
  auto_intervention_should_be_disabled: z.boolean(),
  run_count: z.number().int().nonnegative(),
  reviewed_count: z.number().int().nonnegative(),
  redlines: z.object({
    discipline_hallucination: z.number().int().nonnegative(),
    claim_probe_mismatch: z.number().int().nonnegative(),
    severe_factual_error: z.number().int().nonnegative(),
  }),
  requirements: z.object({
    exactly_10_runs: z.boolean(),
    owner_cohort_scoped: z.boolean(),
    unique_intervention_refs: z.boolean(),
    all_runs_post_reviewed: z.boolean(),
    monitoring_refs_complete: z.boolean(),
    stop_switch_rehearsed: z.boolean(),
    zero_redlines: z.boolean(),
  }),
});
export type GroundingCanaryScore = z.infer<typeof GroundingCanaryScoreSchema>;

function canaryReviewComplete(review: z.infer<typeof CanaryReviewSchema>): boolean {
  return (
    review.post_reviewed !== null &&
    review.discipline_hallucination !== null &&
    review.claim_probe_mismatch !== null &&
    review.severe_factual_error !== null
  );
}

export function scoreGroundingCanaryPacket(packet: GroundingCanaryPacket): GroundingCanaryScore {
  const parsed = GroundingCanaryPacketSchema.parse(packet);
  const reviewed = parsed.runs.filter((run) => canaryReviewComplete(run.review));
  const redlines = {
    discipline_hallucination: parsed.runs.filter(
      (run) => run.review.discipline_hallucination === true,
    ).length,
    claim_probe_mismatch: parsed.runs.filter((run) => run.review.claim_probe_mismatch === true)
      .length,
    severe_factual_error: parsed.runs.filter((run) => run.review.severe_factual_error === true)
      .length,
  };
  const exactly10Runs = parsed.runs.length === GROUNDING_GATE_CANARY_RUNS;
  const ownerCohortScoped =
    typeof parsed.owner_cohort_ref === 'string' && parsed.owner_cohort_ref.trim().length > 0;
  const interventionRefs = parsed.runs.map((run) => run.intervention_ref?.trim() ?? '');
  const uniqueInterventionRefs =
    interventionRefs.every((ref) => ref.length > 0) &&
    new Set(interventionRefs).size === interventionRefs.length;
  const allRunsReviewed =
    reviewed.length === parsed.runs.length &&
    reviewed.every((run) => run.review.post_reviewed === true);
  const monitoringRefsComplete = parsed.runs.every(
    (run) =>
      typeof run.review.monitoring_snapshot_ref === 'string' &&
      run.review.monitoring_snapshot_ref.trim().length > 0,
  );
  const rehearsal = parsed.stop_switch_rehearsal;
  const stopSwitchRehearsed =
    typeof rehearsal.control_ref === 'string' &&
    rehearsal.control_ref.trim().length > 0 &&
    typeof rehearsal.audit_ref === 'string' &&
    rehearsal.audit_ref.trim().length > 0 &&
    rehearsal.disabled_before_new_schedule === true &&
    rehearsal.existing_records_retained === true;
  const zeroRedlines = Object.values(redlines).every((count) => count === 0);
  const complete =
    exactly10Runs &&
    ownerCohortScoped &&
    uniqueInterventionRefs &&
    allRunsReviewed &&
    monitoringRefsComplete &&
    stopSwitchRehearsed;
  const pass = complete && zeroRedlines;
  return GroundingCanaryScoreSchema.parse({
    schema_version: GROUNDING_GATE_SCHEMA_VERSION,
    gate_id: parsed.gate_id,
    status: !complete ? 'incomplete' : pass ? 'pass' : 'fail',
    expansion_allowed: pass,
    auto_intervention_should_be_disabled: !zeroRedlines,
    run_count: parsed.runs.length,
    reviewed_count: reviewed.length,
    redlines,
    requirements: {
      exactly_10_runs: exactly10Runs,
      owner_cohort_scoped: ownerCohortScoped,
      unique_intervention_refs: uniqueInterventionRefs,
      all_runs_post_reviewed: allRunsReviewed,
      monitoring_refs_complete: monitoringRefsComplete,
      stop_switch_rehearsed: stopSwitchRehearsed,
      zero_redlines: zeroRedlines,
    },
  });
}

export function createGroundingCanaryTemplate(input: {
  gateId: string;
  blindScoreSha256: string;
}): GroundingCanaryPacket {
  return GroundingCanaryPacketSchema.parse({
    schema_version: GROUNDING_GATE_SCHEMA_VERSION,
    gate_id: input.gateId,
    blind_score_sha256: input.blindScoreSha256,
    owner_cohort_ref: null,
    runs: Array.from({ length: GROUNDING_GATE_CANARY_RUNS }, (_, index) => ({
      run_id: `canary-${String(index + 1).padStart(2, '0')}`,
      intervention_ref: null,
      review: {
        post_reviewed: null,
        discipline_hallucination: null,
        claim_probe_mismatch: null,
        severe_factual_error: null,
        monitoring_snapshot_ref: null,
        notes: '',
      },
    })),
    stop_switch_rehearsal: {
      control_ref: null,
      audit_ref: null,
      disabled_before_new_schedule: null,
      existing_records_retained: null,
    },
  });
}
