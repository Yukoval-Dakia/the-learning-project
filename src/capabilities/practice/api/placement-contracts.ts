import { z } from 'zod';

export const PlacementSessionParamsSchema = z.object({ id: z.string().min(1) });

export const CreatePlacementSessionBodySchema = z.object({
  goalId: z.string().min(1).nullable().optional(),
  knowledgeIds: z.array(z.string().min(1)).optional(),
  leanings: z.array(z.string().min(1)).optional(),
  pace: z.enum(['light', 'medium', 'dense']).optional(),
});

const PlacementSelectionSchema = z.object({
  questionId: z.string(),
  score: z.number(),
  scoreKind: z.enum(['mfi', 'klp', 'klp_grid']),
});

export const PlacementSessionCreatedSchema = z.object({
  sessionId: z.string(),
  knowledgeIds: z.array(z.string()),
  question: PlacementSelectionSchema.nullable(),
  sourcingNeeded: z.boolean(),
});

export const CreatePlacementQuestionSelectionBodySchema = z.object({
  knowledgeIds: z.array(z.string().min(1)).min(1).optional(),
  cap: z.number().int().min(1).max(50).optional(),
  seThreshold: z.number().positive().nullable().optional(),
});

export const PlacementQuestionSelectionResponseSchema = z.discriminatedUnion('done', [
  z.object({
    done: z.literal(true),
    reason: z.enum(['cap', 'se_converged']),
    answeredCount: z.number().int().nonnegative(),
  }),
  z.object({
    done: z.literal(false),
    question: PlacementSelectionSchema.nullable(),
    answeredCount: z.number().int().nonnegative(),
    sourcingNeeded: z.boolean(),
  }),
]);

export const PlacementSessionStatusSchema = z.enum(['started', 'completed', 'abandoned']);

export const EndPlacementSessionBodySchema = z.object({
  status: z.enum(['completed', 'abandoned']).default('completed'),
});

export type EndPlacementSessionBody = z.infer<typeof EndPlacementSessionBodySchema>;

export const LegacyPlacementSessionTransitionResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['completed', 'abandoned']),
});

export const UpdatePlacementSessionBodySchema = z.object({
  status: z.enum(['completed', 'abandoned']),
});

export const PlacementSessionResponseSchema = z.object({
  id: z.string(),
  type: z.literal('placement'),
  status: PlacementSessionStatusSchema,
  goal_id: z.string().nullable(),
  scope_knowledge_ids: z.array(z.string()).nullable(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  updated_at: z.string().datetime(),
});

export const PlacementSessionTransitionResponseSchema = z.object({
  id: z.string(),
  type: z.literal('placement'),
  previous_status: PlacementSessionStatusSchema,
  status: PlacementSessionStatusSchema,
  changed: z.boolean(),
  allowed_statuses: z.array(PlacementSessionStatusSchema),
});

export const PlacementProfileQuerySchema = z.object({ goal: z.string().min(1) });

const PlacementProfileAxisSchema = z.object({
  drift_v: z.number().nullable(),
  boundary_a: z.number().nullable(),
  ter: z.number().nullable(),
  n_obs: z.number().int().nonnegative(),
  provenance: z.string(),
});

const PlacementDayOnePriorSchema = z.object({
  mean_mastery: z.number(),
  weakest_prereq_id: z.string().optional(),
  weakest_prereq_mastery: z.number().optional(),
});

const PlacementProfileKcBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  evidence_count: z.number().int().nonnegative(),
  axis: PlacementProfileAxisSchema.optional(),
  day_one_prior: PlacementDayOnePriorSchema.optional(),
});

const TestedPlacementProfileKcSchema = PlacementProfileKcBaseSchema.extend({
  tested: z.literal(true),
  theta_hat: z.number(),
  theta_precision: z.number(),
  theta_se: z.number(),
  p_l: z.number(),
  mastery_lo: z.number(),
  mastery_hi: z.number(),
  low_confidence: z.boolean(),
  success_count: z.number().int().nonnegative(),
  fail_count: z.number().int().nonnegative(),
  beta: z.number(),
});

export type TestedPlacementProfileKc = z.infer<typeof TestedPlacementProfileKcSchema>;

export const PlacementProfileKcSchema = z.discriminatedUnion('tested', [
  TestedPlacementProfileKcSchema,
  PlacementProfileKcBaseSchema.extend({
    tested: z.literal(false),
    evidence_count: z.literal(0),
  }),
]);

export type PlacementProfileKc = z.infer<typeof PlacementProfileKcSchema>;

export const PlacementProfileResponseSchema = z.object({
  goalId: z.string(),
  title: z.string(),
  kcs: z.array(PlacementProfileKcSchema),
  weakest: z.array(TestedPlacementProfileKcSchema),
  evidenceCount: z.number().int().nonnegative(),
  evidencedCount: z.number().int().nonnegative(),
  testedCount: z.number().int().nonnegative(),
  totalKcs: z.number().int().nonnegative(),
  // The empty-scope fast path predates sigma-mode reporting and intentionally omits it.
  sigma_mode: z.enum(['poly', 'libm']).optional(),
});
