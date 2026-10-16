import { z } from 'zod';
import { PlacementStarterOutcomeSchema } from '../server/question-supply/placement-starter-outcome';
import { IssuanceStateSchema } from './assessment-contracts';

export const PlacementSessionParamsSchema = z.object({ id: z.string().min(1) });

export const CreatePlacementSessionBodySchema = z.object({
  goalId: z.string().min(1).nullable().optional(),
  knowledgeIds: z.array(z.string().min(1)).optional(),
  leanings: z.array(z.string().min(1)).optional(),
  pace: z.enum(['light', 'medium', 'dense']).optional(),
});

/** YUK-1405 L1 — a held issuance's typed exits. Emitted only while phase='held';
 *  continue records the item unresolved (never counted as wrong) and advances;
 *  end completes the probe and marks it in unresolved_items. Refresh/re-entry
 *  re-derives the same pair — the offer is a projection, not a stored flag. */
export const PlacementHeldExitSchema = z.object({
  issuance_id: z.string(),
  /** POST {issuance_id} → held item recorded unresolved, probe advances. */
  continue_url: z.string(),
  /** PATCH {status:'completed'} → probe ends honestly, unresolved items listed. */
  end_url: z.string(),
});

/** YUK-1405 L1/L2 — an issued item that will not contribute a verdict to this
 *  probe's result. Reasons are a closed set: 'held_released' (learner skipped a
 *  held item), 'awaiting_evaluation' (submission accepted, no settlement yet),
 *  'unanswered' (issued but never submitted — end-of-probe honesty only). */
export const PlacementUnresolvedItemSchema = z.object({
  question_id: z.string(),
  issuance_id: z.string(),
  reason: z.enum(['held_released', 'awaiting_evaluation', 'unanswered']),
});
export type PlacementUnresolvedItem = z.infer<typeof PlacementUnresolvedItemSchema>;

/** YUK-1405 L2 — typed alternative when no automatically servable item exists.
 *  starterSupply carries the per-subject supply detail; this object says the
 *  probe itself has nothing to serve and what the learner can do next. */
export const PlacementNoItemSchema = z.object({
  reason: z.literal('no_servable_item'),
  /** subject ids with a live (pending) starter-supply claim — what is being prepared. */
  preparing_subjects: z.array(z.string()),
  /** 'recheck' = re-POST this selection endpoint; 'end' = PATCH the session closed. */
  options: z.array(z.enum(['recheck', 'end'])),
});

export const PlacementQuestionSchema = z.object({
  questionId: z.string(),
  score: z.number(),
  scoreKind: z.enum(['mfi', 'klp', 'klp_grid']),
  assessment: z.object({
    issuance_id: z.string(),
    evaluation_group_id: z.string(),
    submission_id: z.string(),
    idempotency_key: z.string(),
    state: IssuanceStateSchema,
    phase: z.enum(['answering', 'retry', 'pending', 'held']),
    pending_run: z.object({ run_id: z.string(), poll_url: z.string() }).nullable(),
    held_exit: PlacementHeldExitSchema.nullable(),
  }),
});

export const PlacementSessionCreatedSchema = z.object({
  sessionId: z.string(),
  knowledgeIds: z.array(z.string()),
  answeredCount: z.number().int().nonnegative(),
  question: PlacementQuestionSchema.nullable(),
  sourcingNeeded: z.boolean(),
  // Optional while existing clients construct local resume results. The backend
  // emits this on every successful start/next/detail response.
  starterSupply: z.array(PlacementStarterOutcomeSchema).optional(),
  /** YUK-1405 — always emitted (fresh sessions → []). */
  unresolved_items: z.array(PlacementUnresolvedItemSchema),
  /** YUK-1405 L2 — non-null exactly when question is null: the typed alternative. */
  no_item: PlacementNoItemSchema.nullable(),
});

export const CreatePlacementQuestionSelectionBodySchema = z.object({
  knowledgeIds: z.array(z.string().min(1)).min(1).optional(),
  cap: z.number().int().min(1).max(8).optional(),
  seThreshold: z.number().positive().nullable().optional(),
});

export const PlacementQuestionSelectionResponseSchema = z.discriminatedUnion('done', [
  z.object({
    done: z.literal(true),
    reason: z.enum(['cap', 'se_converged']),
    answeredCount: z.number().int().nonnegative(),
    starterSupply: z.array(PlacementStarterOutcomeSchema).optional(),
    unresolved_items: z.array(PlacementUnresolvedItemSchema),
  }),
  z.object({
    done: z.literal(false),
    question: PlacementQuestionSchema.nullable(),
    answeredCount: z.number().int().nonnegative(),
    sourcingNeeded: z.boolean(),
    starterSupply: z.array(PlacementStarterOutcomeSchema).optional(),
    unresolved_items: z.array(PlacementUnresolvedItemSchema),
    /** YUK-1405 L2 — non-null exactly when question is null: the typed alternative. */
    no_item: PlacementNoItemSchema.nullable(),
  }),
]);

/** YUK-1405 L1 — release the session's currently-held issuance so the probe can
 *  advance. Idempotent on issuance_id: re-POSTing the same id replays the same
 *  advance result instead of double-recording. */
export const CreatePlacementHeldReleaseBodySchema = z.object({
  issuance_id: z.string().min(1),
});

export const PlacementHeldReleaseResponseSchema = z.object({
  /** Always true on success: after this call a release record exists for the issuance. */
  released: z.literal(true),
  /** true when the release record already existed (safe re-POST / refresh retry). */
  replayed: z.boolean(),
  /** The post-release advance result — same shape as question-selections. */
  selection: PlacementQuestionSelectionResponseSchema,
});

export const PlacementSessionStatusSchema = z.enum(['started', 'completed', 'abandoned']);

export const EndPlacementSessionBodySchema = z.object({
  status: z.enum(['completed', 'abandoned']).default('completed'),
});

export type EndPlacementSessionBody = z.infer<typeof EndPlacementSessionBodySchema>;

export const LegacyPlacementSessionTransitionResponseSchema = z.object({
  ok: z.literal(true),
  status: z.enum(['completed', 'abandoned']),
  /** YUK-1405 L1 — the honest end marker; optional for back-compat readers. */
  unresolved_items: z.array(PlacementUnresolvedItemSchema).optional(),
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
  starterSupply: z.array(PlacementStarterOutcomeSchema).optional(),
  /** YUK-1405 L1 — items with no verdict at read time (released / awaiting / unanswered). */
  unresolved_items: z.array(PlacementUnresolvedItemSchema),
});

export const PlacementSessionTransitionResponseSchema = z.object({
  id: z.string(),
  type: z.literal('placement'),
  previous_status: PlacementSessionStatusSchema,
  status: PlacementSessionStatusSchema,
  changed: z.boolean(),
  allowed_statuses: z.array(PlacementSessionStatusSchema),
  /** YUK-1405 L1 — the honest end result: items closed without a verdict. */
  unresolved_items: z.array(PlacementUnresolvedItemSchema),
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
