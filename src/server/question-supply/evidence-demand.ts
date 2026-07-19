import { z } from 'zod';

export const EVIDENCE_DEMAND_VERSION = 1 as const;
export const SUPPLY_TRACE_VERSION = 1 as const;
export const DEFAULT_SUPPLY_POLICY_VERSION = 'supply-v2-phase-a';

export const EvidenceAllowedUse = z.enum([
  'practice',
  'diagnostic',
  'assessment',
  'placement',
  'teaching',
]);
export type EvidenceAllowedUseT = z.infer<typeof EvidenceAllowedUse>;

const EvidenceDemandClaim = z.object({
  kind: z.enum(['knowledge_mastery', 'misconception_discrimination', 'content_coverage']),
  knowledge_ids: z.array(z.string().min(1)).min(1),
  statement: z.string().min(1),
});

const EvidenceDemandEvidence = z.object({
  observables: z.array(z.string().min(1)).min(1),
  minimum_observations: z.number().int().positive(),
});

const EvidenceDemandTask = z.object({
  kinds: z.array(z.string().min(1)).min(1),
  allowed_uses: z.array(EvidenceAllowedUse).min(1),
});

const EvidenceDemandDifficulty = z.object({
  band: z.enum(['below', 'near', 'above', 'stretch']),
  scale: z.string().min(1),
  target_value: z.number().finite().nullable(),
});

const EvidenceDemandInventoryGoal = z.object({
  eligible_count: z.number().int().nonnegative(),
  horizon_days: z.number().int().positive(),
});

const EvidenceDemandControl = z.object({
  needed_by: z.string().datetime({ offset: true }).nullable(),
  max_budget_micro_usd: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
});

const EvidenceDemandCause = z.object({
  kind: z.enum([
    'coverage_gap',
    'selection_miss',
    'mastery_uncertainty',
    'owner_request',
    'confusable_pair',
  ]),
  ref: z.string().min(1).optional(),
});

/**
 * Phase-A demand contract. It is deliberately value-only: targets carry a compact
 * compatibility projection, while persistence remains on the existing event/question spine.
 */
export const EvidenceDemandV1 = z.object({
  version: z.literal(EVIDENCE_DEMAND_VERSION),
  demand_id: z.string().min(1),
  policy_version: z.string().min(1),
  subject_id: z.string().min(1),
  claim: EvidenceDemandClaim,
  evidence: EvidenceDemandEvidence,
  task: EvidenceDemandTask,
  difficulty: EvidenceDemandDifficulty,
  inventory_goal: EvidenceDemandInventoryGoal,
  control: EvidenceDemandControl,
  causes: z.array(EvidenceDemandCause).min(1),
});
export type EvidenceDemandV1T = z.infer<typeof EvidenceDemandV1>;

export const SupplyTargetContextV1 = z.object({
  schema_version: z.literal(1),
  demand_id: z.string().min(1),
  demand_version: z.literal(EVIDENCE_DEMAND_VERSION),
  policy_version: z.string().min(1),
  needed_by: z.string().datetime({ offset: true }).nullable(),
  allowed_uses: z.array(EvidenceAllowedUse).min(1),
  max_budget_micro_usd: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
});
export type SupplyTargetContextV1T = z.infer<typeof SupplyTargetContextV1>;

const SupplyProducerRoute = z.enum([
  'author_question',
  'sourcing_web',
  'ingest_existing',
  'image_candidate',
  'quiz_gen',
]);

export const SupplyTraceV1 = SupplyTargetContextV1.extend({
  trace_version: z.literal(SUPPLY_TRACE_VERSION),
  trace_id: z.string().min(1),
  target_id: z.string().min(1),
  target_fingerprint: z.string().min(1),
  producer_route: SupplyProducerRoute.nullable(),
});
export type SupplyTraceV1T = z.infer<typeof SupplyTraceV1>;

export function parseEvidenceDemand(value: unknown): EvidenceDemandV1T {
  return EvidenceDemandV1.parse(value);
}

export function evidenceDemandToTargetContext(value: EvidenceDemandV1T): SupplyTargetContextV1T {
  const demand = EvidenceDemandV1.parse(value);
  return SupplyTargetContextV1.parse({
    schema_version: 1,
    demand_id: demand.demand_id,
    demand_version: demand.version,
    policy_version: demand.policy_version,
    needed_by: demand.control.needed_by,
    allowed_uses: demand.task.allowed_uses,
    max_budget_micro_usd: demand.control.max_budget_micro_usd,
    max_attempts: demand.control.max_attempts,
  });
}

export function buildSupplyTrace(
  input: {
    targetId: string;
    targetFingerprint: string;
    context: SupplyTargetContextV1T;
  },
  producerRoute: z.infer<typeof SupplyProducerRoute> | null = null,
): SupplyTraceV1T {
  const context = SupplyTargetContextV1.parse(input.context);
  return SupplyTraceV1.parse({
    ...context,
    trace_version: SUPPLY_TRACE_VERSION,
    trace_id: `supply:${context.demand_id}:${input.targetId}`,
    target_id: input.targetId,
    target_fingerprint: input.targetFingerprint,
    producer_route: producerRoute,
  });
}

export function parseSupplyTrace(value: unknown): SupplyTraceV1T {
  return SupplyTraceV1.parse(value);
}

export function buildCoverageEvidenceDemand(input: {
  subjectId: string;
  knowledgeIds: string[];
  statement: string;
  kinds?: string[];
  allowedUses?: EvidenceAllowedUseT[];
  difficultyBand?: 'below' | 'near' | 'above' | 'stretch';
  targetValue?: number | null;
  eligibleCount?: number;
  neededBy?: string | null;
  maxBudgetMicroUsd?: number;
  maxAttempts?: number;
  cause?: z.infer<typeof EvidenceDemandCause>;
}): EvidenceDemandV1T {
  const knowledgeIds = [...new Set(input.knowledgeIds)].sort();
  return EvidenceDemandV1.parse({
    version: EVIDENCE_DEMAND_VERSION,
    demand_id: `demand:v1:${input.subjectId}:${knowledgeIds.join(',')}`,
    policy_version: DEFAULT_SUPPLY_POLICY_VERSION,
    subject_id: input.subjectId,
    claim: {
      kind: 'knowledge_mastery',
      knowledge_ids: knowledgeIds,
      statement: input.statement,
    },
    evidence: {
      observables: ['verified question supports an allowed evidence-producing task'],
      minimum_observations: 1,
    },
    task: {
      kinds: input.kinds ?? ['any'],
      allowed_uses: input.allowedUses ?? ['practice', 'diagnostic'],
    },
    difficulty: {
      band: input.difficultyBand ?? 'near',
      scale: 'loom_difficulty_v1',
      target_value: input.targetValue ?? null,
    },
    inventory_goal: {
      eligible_count: input.eligibleCount ?? 1,
      horizon_days: 7,
    },
    control: {
      needed_by: input.neededBy ?? null,
      max_budget_micro_usd: input.maxBudgetMicroUsd ?? 1_000_000,
      max_attempts: input.maxAttempts ?? 3,
    },
    causes: [input.cause ?? { kind: 'coverage_gap' }],
  });
}
