import { z } from 'zod';

export const DIFFICULTY_EVIDENCE_VERSION = 1 as const;

// Calibration-assumption constants, named so the tuning surface is discoverable in
// one place (mirrors theta.ts' named weights).
export const PRODUCER_ESTIMATE_CONFIDENCE = 0.35;
export const LEGACY_NUMERIC_CONFIDENCE = 0.2;
export const CALIBRATED_CONFIDENCE = 1;
/** |b| beyond this is a calibration bug, not a hard item — canonical-scale contract. */
export const RASCH_LOGIT_B_SANITY_BOUND = 10;

export const DifficultyEvidence = z
  .object({
    version: z.literal(DIFFICULTY_EVIDENCE_VERSION),
    value: z.number().finite(),
    // The scale is deliberately open to source adapters. Named canonical scales below are
    // contracts, not a claim that every producer shares a calibrated coordinate system.
    scale: z.string().min(1),
    basis: z.enum(['item_calibration', 'source_label', 'producer_estimate', 'legacy_numeric']),
    confidence: z.number().min(0).max(1),
    observed_at: z.string().datetime({ offset: true }).optional(),
    source_route: z.string().min(1).optional(),
  })
  .superRefine((evidence, ctx) => {
    if (evidence.scale === 'loom_difficulty_1_5' && (evidence.value < 1 || evidence.value > 5)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'loom_difficulty_1_5 value must be between 1 and 5',
      });
    }
    if (evidence.basis === 'item_calibration' && evidence.scale !== 'rasch_logit_b') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scale'],
        message: 'item_calibration evidence must use rasch_logit_b',
      });
    }
    if (
      evidence.scale === 'rasch_logit_b' &&
      Math.abs(evidence.value) > RASCH_LOGIT_B_SANITY_BOUND
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `rasch_logit_b value must be within ±${RASCH_LOGIT_B_SANITY_BOUND}`,
      });
    }
  });

export type DifficultyEvidenceT = z.infer<typeof DifficultyEvidence>;

/** Producer boundary: only the calibration subsystem may claim item_calibration basis. */
export const ProducerDifficultyEvidence = DifficultyEvidence.refine(
  (evidence) => evidence.basis !== 'item_calibration',
  { message: 'producer output cannot claim item_calibration basis', path: ['basis'] },
);

export function parseDifficultyEvidence(value: unknown): DifficultyEvidenceT {
  return DifficultyEvidence.parse(value);
}

export function buildProducerDifficultyEvidence(
  difficulty: number,
  sourceRoute: string,
  observedAt?: Date,
): DifficultyEvidenceT {
  // Parse through the producer schema so the item_calibration boundary is enforced
  // by construction, even if a future edit parameterizes basis/value here.
  return ProducerDifficultyEvidence.parse({
    version: DIFFICULTY_EVIDENCE_VERSION,
    value: difficulty,
    scale: 'loom_difficulty_1_5',
    basis: 'producer_estimate',
    confidence: PRODUCER_ESTIMATE_CONFIDENCE,
    ...(observedAt ? { observed_at: observedAt.toISOString() } : {}),
    source_route: sourceRoute,
  });
}

export function buildSourceLabelDifficultyEvidence(input: {
  value: number;
  scale: string;
  confidence: number;
  observedAt?: Date;
  sourceRoute?: string;
}): DifficultyEvidenceT {
  return DifficultyEvidence.parse({
    version: DIFFICULTY_EVIDENCE_VERSION,
    value: input.value,
    scale: input.scale,
    basis: 'source_label',
    confidence: input.confidence,
    ...(input.observedAt ? { observed_at: input.observedAt.toISOString() } : {}),
    ...(input.sourceRoute ? { source_route: input.sourceRoute } : {}),
  });
}

export function readDifficultyEvidenceFromMetadata(metadata: unknown): DifficultyEvidenceT | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = DifficultyEvidence.safeParse(
    (metadata as Record<string, unknown>).difficulty_evidence,
  );
  return parsed.success ? parsed.data : null;
}

/** Read precedence only; it does not write or refit any item parameter. */
export function resolveDifficultyEvidence(input: {
  calibratedB: number | null | undefined;
  stored?: unknown;
  legacyDifficulty: number;
}): DifficultyEvidenceT {
  if (
    input.calibratedB != null &&
    Number.isFinite(input.calibratedB) &&
    // A wild logit is a calibration bug; fall through to stored/legacy evidence
    // instead of throwing on the read path (the schema bound below is the backstop).
    Math.abs(input.calibratedB) <= RASCH_LOGIT_B_SANITY_BOUND
  ) {
    return DifficultyEvidence.parse({
      version: DIFFICULTY_EVIDENCE_VERSION,
      value: input.calibratedB,
      scale: 'rasch_logit_b',
      basis: 'item_calibration',
      confidence: CALIBRATED_CONFIDENCE,
    });
  }
  const stored = DifficultyEvidence.safeParse(input.stored);
  if (stored.success) return stored.data;
  return DifficultyEvidence.parse({
    version: DIFFICULTY_EVIDENCE_VERSION,
    value: input.legacyDifficulty,
    scale: 'loom_difficulty_1_5',
    basis: 'legacy_numeric',
    confidence: LEGACY_NUMERIC_CONFIDENCE,
  });
}
