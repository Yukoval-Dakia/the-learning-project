import { z } from 'zod';

const CoverageGapKindSchema = z.enum([
  'frontier_zero',
  'source_quality',
  'diagnostic',
  'format_diversity',
]);

const GapActivitySchema = z.object({
  lastActivityAt: z.string().datetime().nullable(),
  lastStatus: z.string().nullable(),
  lastDispatchedAt: z.string().datetime().nullable(),
  inCooldown: z.boolean(),
  cooldownUntil: z.string().datetime().nullable(),
});

const CoverageGapSchema = z.object({
  gapKind: CoverageGapKindSchema,
  kind: z.string(),
  difficultyBand: z.enum(['below', 'near', 'above', 'stretch']),
  minSourceTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  desiredCount: z.number().int().nonnegative(),
  priority: z.number(),
  reason: z.string(),
  fingerprint: z.string(),
  routePreference: z.array(
    z.enum(['author_question', 'sourcing_web', 'ingest_existing', 'image_candidate', 'quiz_gen']),
  ),
  scaffold: z.boolean(),
  lastActivity: GapActivitySchema.nullable(),
});

export const CoverageLatticeResponseSchema = z.object({
  generated_at: z.string().datetime(),
  scan_ms: z.number().nonnegative(),
  coverage_depth_threshold: z.number().int().nonnegative(),
  near_window: z.number().nonnegative(),
  cooldown_days: z.number().nonnegative(),
  scope_note: z.string(),
  subjects: z.array(
    z.object({
      subjectId: z.string(),
      displayName: z.string().nullable(),
      kcs: z.array(
        z.object({
          knowledgeId: z.string(),
          thetaHat: z.number(),
          evidenceCount: z.number().int().nonnegative(),
          usableCount: z.number().int().nonnegative(),
          depthMet: z.boolean(),
          hasHighTier: z.boolean().nullable(),
          hasNearThetaAnchor: z.boolean().nullable(),
          formatDiverse: z.boolean().nullable(),
          gapKinds: z.array(CoverageGapKindSchema),
          gaps: z.array(CoverageGapSchema),
        }),
      ),
    }),
  ),
  totals: z.object({
    activeKcs: z.number().int().nonnegative(),
    kcsWithGaps: z.number().int().nonnegative(),
    totalGaps: z.number().int().nonnegative(),
    gapsByKind: z.record(z.string(), z.number().int().nonnegative()),
  }),
});
