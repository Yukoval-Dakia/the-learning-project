import { z } from 'zod';

const VersionedHashRef = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  content_hash: z.string().min(1),
});

const TextOffsets = {
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  exact_text: z.string().min(1),
};

const TextSpanLocator = z
  .object({ kind: z.literal('text_span'), ...TextOffsets })
  .refine((locator) => locator.end > locator.start, {
    message: 'text span end must be greater than start',
    path: ['end'],
  });
const PageTextSpanLocator = z
  .object({
    kind: z.literal('page_text_span'),
    ...TextOffsets,
    page_id: z.string().min(1),
    page_version: z.number().int().nonnegative(),
    page_index: z.number().int().nonnegative(),
  })
  .refine((locator) => locator.end > locator.start, {
    message: 'text span end must be greater than start',
    path: ['end'],
  });

export const SourceSpanLocator = z.union([
  TextSpanLocator,
  PageTextSpanLocator,
  z.object({
    kind: z.literal('page_region'),
    page_id: z.string().min(1),
    page_version: z.number().int().nonnegative(),
    page_index: z.number().int().nonnegative(),
    bbox: z.object({
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  }),
]);

export const QuestionAnswerAnchor = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  schema_version: z.number().int().positive(),
  source: z.object({
    artifact_kind: z.string().min(1),
    artifact_id: z.string().min(1),
    version: z.number().int().nonnegative(),
    content_hash: z.string().min(1),
    locator: SourceSpanLocator,
  }),
  canonical_answer: z.object({
    kind: z.string().min(1),
    value: z.string().min(1),
  }),
  provenance: z.object({
    kind: z.enum(['human_curated', 'ai_extracted', 'legacy']),
    task_run_id: z.string().min(1).nullable().optional(),
  }),
  content_hash: z.string().min(1),
});
export type QuestionAnswerAnchorT = z.infer<typeof QuestionAnswerAnchor>;

export const QuestionGenerationPlan = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  schema_version: z.number().int().positive(),
  demand: z.object({ kind: z.string().min(1), ref_id: z.string().min(1) }),
  knowledge_ids: z.array(z.string().min(1)),
  requested_kind: z.string().min(1),
  requested_answer_class: z.string().min(1),
  answer_anchor: VersionedHashRef,
  constraints: z.record(z.string(), z.unknown()),
  provenance: z.object({
    kind: z.enum(['human_planned', 'ai_planned', 'legacy']),
    task_run_id: z.string().min(1).nullable().optional(),
  }),
  content_hash: z.string().min(1),
});
export type QuestionGenerationPlanT = z.infer<typeof QuestionGenerationPlan>;

export const QuestionGenerationBinding = z.object({
  plan: VersionedHashRef,
  answer_anchor: VersionedHashRef,
  comparator_policy: VersionedHashRef,
});
export type QuestionGenerationBindingT = z.infer<typeof QuestionGenerationBinding>;

export const StructuralObjectiveVerification = z.object({
  structural_status: z.enum(['no_veto', 'vetoed']),
  objective_correctness: z.literal('unverified'),
  disposition: z.enum(['reject', 'needs_review']),
  vetoes: z.array(z.string().min(1)),
});
export type StructuralObjectiveVerificationT = z.infer<typeof StructuralObjectiveVerification>;

function matches(ref: z.infer<typeof VersionedHashRef>, value: z.infer<typeof VersionedHashRef>) {
  return (
    ref.id === value.id && ref.version === value.version && ref.content_hash === value.content_hash
  );
}

/**
 * Reject-only structural verification. `no_veto` means only that the immutable
 * bindings and requested shape agree; it is not evidence that the answer is correct.
 */
export function structurallyVerifyGeneratedQuestion(input: {
  binding: QuestionGenerationBindingT;
  plan: QuestionGenerationPlanT;
  anchor: QuestionAnswerAnchorT | null;
  generated: { kind: string; reference_md: string };
}): StructuralObjectiveVerificationT {
  const vetoes: string[] = [];
  if (!matches(input.binding.plan, input.plan)) vetoes.push('generation_plan_binding_mismatch');
  if (!input.anchor) {
    vetoes.push('answer_anchor_missing');
  } else {
    if (!matches(input.binding.answer_anchor, input.anchor)) {
      vetoes.push('answer_anchor_binding_mismatch');
    }
    if (!matches(input.plan.answer_anchor, input.anchor)) {
      vetoes.push('plan_answer_anchor_binding_mismatch');
    }
  }
  if (input.generated.kind !== input.plan.requested_kind) vetoes.push('requested_kind_mismatch');

  if (vetoes.length > 0) {
    return {
      structural_status: 'vetoed',
      objective_correctness: 'unverified',
      disposition: 'reject',
      vetoes,
    };
  }
  return {
    structural_status: 'no_veto',
    objective_correctness: 'unverified',
    disposition: 'needs_review',
    vetoes: [],
  };
}
