import { z } from 'zod';

// Subject control-plane rename/reset mirrors display_name onto the subject's
// knowledge root. This is structural fold truth, so the event is reserved and typed rather than
// falling through the loose ExperimentalEvent escape hatch.
const SubjectRootNameUpdatePayload = z
  .object({
    control_action: z.enum(['rename', 'reset']),
    subject_id: z.string().min(1),
    previous_name: z.string(),
    next_name: z.string().min(1),
    previous_version: z.number().int().nonnegative(),
    next_version: z.number().int().positive(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.next_version !== payload.previous_version + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'next_version must equal previous_version + 1',
        path: ['next_version'],
      });
    }
  });

export const SubjectRootNameUpdateExperimental = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('owner'),
    action: z.literal('experimental:subject_root_name_update'),
    subject_kind: z.literal('knowledge'),
    subject_id: z.string().min(1),
    outcome: z.literal('success'),
    payload: SubjectRootNameUpdatePayload,
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((event, ctx) => {
    if (event.subject_id !== `seed:${event.payload.subject_id}:root`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subject_id must be the canonical root id for payload.subject_id',
        path: ['subject_id'],
      });
    }
  });
export type SubjectRootNameUpdateExperimentalT = z.infer<typeof SubjectRootNameUpdateExperimental>;

// YUK-1600 — one-time identity repair for knowledge nodes whose genesis predates the
// `role` column: the ops backfill stamps the role through this reserved control-plane
// event so the fold (not raw SQL) owns the write and any later re-projection reproduces
// it. Birth-time stamping for NEW nodes goes through the genesis payload row instead.
const KnowledgeRoleUpdatePayload = z
  .object({
    role: z.enum(['kc', 'goal', 'container']),
    previous_role: z.enum(['kc', 'goal', 'container']),
    reason: z.string().min(1),
    previous_version: z.number().int().nonnegative(),
    next_version: z.number().int().positive(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.next_version !== payload.previous_version + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'next_version must equal previous_version + 1',
        path: ['next_version'],
      });
    }
  });

export const KnowledgeRoleUpdateExperimental = z.object({
  actor_kind: z.literal('system'),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:knowledge_role_update'),
  subject_kind: z.literal('knowledge'),
  subject_id: z.string().min(1),
  outcome: z.literal('success'),
  payload: KnowledgeRoleUpdatePayload,
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type KnowledgeRoleUpdateExperimentalT = z.infer<typeof KnowledgeRoleUpdateExperimental>;

// YUK-1604 — one-time approval repair for knowledge nodes born before agent-minted KCs
// were marked await-confirmation (pre-YUK-1405 auto-tag births project as 'approved').
// Same discipline as the role repair above: the ops backfill stamps the transition
// through this reserved control-plane event so the fold owns the write and any later
// re-projection reproduces it. Ids, names and evidence rows are never touched.
const KnowledgeApprovalUpdatePayload = z
  .object({
    approval_status: z.enum(['pending', 'approved', 'rejected']),
    previous_approval_status: z.enum(['pending', 'approved', 'rejected']),
    reason: z.string().min(1),
    previous_version: z.number().int().nonnegative(),
    next_version: z.number().int().positive(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.next_version !== payload.previous_version + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'next_version must equal previous_version + 1',
        path: ['next_version'],
      });
    }
  });

export const KnowledgeApprovalUpdateExperimental = z.object({
  actor_kind: z.literal('system'),
  actor_ref: z.string().min(1),
  action: z.literal('experimental:knowledge_approval_update'),
  subject_kind: z.literal('knowledge'),
  subject_id: z.string().min(1),
  outcome: z.literal('success'),
  payload: KnowledgeApprovalUpdatePayload,
  caused_by_event_id: z.string().optional(),
  task_run_id: z.string().optional(),
  cost_micro_usd: z.number().int().optional(),
});
export type KnowledgeApprovalUpdateExperimentalT = z.infer<
  typeof KnowledgeApprovalUpdateExperimental
>;
