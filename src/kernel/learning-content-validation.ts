import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const AxisVerdict = z.enum(['pass', 'fail', 'unclear']);
const AdmissionVerdict = z.enum(['pass', 'fail', 'unsupported']);
const Applicability = z.enum(['required', 'if_reported', 'diagnostic']);

/** No model text or free-form error strings may cross this durable boundary. */
export const LearningValidationTaskEvidenceSchema = z
  .object({
    task_run_id: Identity.nullable(),
    execution: z.enum(['not_executed', 'returned', 'error']),
    input_sha256: Digest.nullable(),
    output_sha256: Digest.nullable(),
    output_digest_basis: z.enum(['text', 'structured_output']).nullable(),
    parse_status: z.enum(['not_executed', 'unavailable', 'parsed', 'invalid']),
    reason: z.enum([
      'not_executed',
      'parsed',
      'parse_invalid',
      'task_error',
      'cancelled',
      'deadline',
    ]),
  })
  .strict();

export type LearningValidationTaskEvidence = z.infer<typeof LearningValidationTaskEvidenceSchema>;

const AuthoringAxis = z
  .object({
    applicability: Applicability,
    verdict: AxisVerdict.nullable(),
  })
  .strict();

export const LearningContentDecisionSchema = z
  .object({
    purpose: z.enum(['existing_answer', 'learning_content']),
    visible_sha256: Digest.nullable(),
    input_sha256: Digest,
    verdict: z.enum(['pass', 'fail']),
    reason: z.enum([
      'passed',
      'checks_rejected',
      'bounds_rejected',
      'source_rejected',
      'mapping_rejected',
    ]),
    items: z
      .array(
        z
          .object({
            question_id: Identity.nullable(),
            question_sha256: Digest,
            verdict: z.enum(['pass', 'fail']),
            reasons: z
              .array(
                z.enum([
                  'grounding_rejected',
                  'basis_unsupported',
                  'authoring_rejected',
                  'solve_rejected',
                  'teaching_rejected',
                  'task_or_parse_error',
                ]),
              )
              .max(6),
            tasks: z
              .object({
                quiz: LearningValidationTaskEvidenceSchema,
                solver: LearningValidationTaskEvidenceSchema,
                semantic: LearningValidationTaskEvidenceSchema,
                teaching: LearningValidationTaskEvidenceSchema,
              })
              .strict(),
            grounding: z
              .object({
                verdict: AxisVerdict.nullable(),
                basis: z
                  .enum([
                    'closed_world_givens',
                    'discipline_knowledge',
                    'source_refs',
                    'material',
                    'executed_remote_evidence',
                    'insufficient',
                  ])
                  .nullable(),
                basis_supported: z.boolean().nullable(),
              })
              .strict(),
            authoring: z
              .object({
                copy_safety: z
                  .object({
                    applicability: Applicability,
                    verdict: z.enum(['original', 'too_close', 'unknown']).nullable(),
                  })
                  .strict(),
                knowledge_hit: AuthoringAxis,
                material_grounding: AuthoringAxis,
                kind_conformance: AuthoringAxis,
                overall: z
                  .object({
                    applicability: Applicability,
                    verdict: z.enum(['pass', 'needs_review', 'fail']).nullable(),
                  })
                  .strict(),
              })
              .strict(),
            semantic: z
              .object({
                verdict: AdmissionVerdict.nullable(),
                outcome: z.enum(['correct', 'partial', 'incorrect', 'unsupported']).nullable(),
                confidence: z.number().min(0).max(1).nullable(),
                threshold: z.literal(0.8),
                compared_by: z.enum(['normalize', 'semantic', 'none']),
                direction: z.enum([
                  'visible_answer_against_independent_solution',
                  'independent_solution_against_declared_reference',
                ]),
              })
              .strict(),
            teaching: z
              .object({
                verdict: AdmissionVerdict.nullable(),
                clarity: z.enum(['pass', 'fail', 'skipped']).nullable(),
                unique_answer: z.enum(['pass', 'fail', 'skipped']).nullable(),
                distractor_power: z.enum(['pass', 'fail', 'skipped']).nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();

export type LearningContentDecision = z.infer<typeof LearningContentDecisionSchema>;

export const CopilotValidationDecisionSchema = z
  .object({
    protocol_version: z.literal(1),
    root_task_run_id: Identity,
    visible_sha256: Digest.nullable(),
    verdict: z.enum(['pass', 'fail', 'not_applicable']),
    reason: z.enum([
      'passed',
      'not_applicable',
      'marker_rejected',
      'mapping_rejected',
      'checks_rejected',
      'validation_error',
      'receipt_error',
      'finalization_error',
    ]),
    checks: z.array(LearningContentDecisionSchema).max(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = [
      value.root_task_run_id,
      ...value.checks.flatMap((check) =>
        check.items.flatMap((item) =>
          Object.values(item.tasks).flatMap((task) => (task.task_run_id ? [task.task_run_id] : [])),
        ),
      ),
    ];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate validation task identity' });
    }
    const invalid = (message: string): void => {
      ctx.addIssue({ code: 'custom', message });
    };
    if (
      value.verdict === 'not_applicable' &&
      (value.reason !== 'not_applicable' || value.checks.length)
    )
      invalid('invalid not-applicable decision');
    if (
      value.verdict === 'pass' &&
      (!value.checks.length || value.checks.some((check) => check.verdict !== 'pass'))
    )
      invalid('aggregate pass lacks passing checks');
    for (const check of value.checks) {
      const existing = check.purpose === 'existing_answer';
      if (existing && check.items.length > 1) invalid('ambiguous existing-answer mapping');
      if (
        check.verdict === 'pass' &&
        (!check.items.length || check.items.some((item) => item.verdict !== 'pass'))
      )
        invalid('check pass lacks passing items');
      const questionIds = check.items.flatMap((item) =>
        item.question_id ? [item.question_id] : [],
      );
      if (new Set(questionIds).size !== questionIds.length) invalid('duplicate question identity');
      for (const item of check.items) {
        if (
          item.semantic.direction !==
          (existing
            ? 'visible_answer_against_independent_solution'
            : 'independent_solution_against_declared_reference')
        )
          invalid('purpose disagrees with comparison direction');
        if (
          Object.values(item.authoring).some((axis) =>
            existing ? axis.applicability !== 'diagnostic' : axis.applicability === 'diagnostic',
          )
        )
          invalid('purpose disagrees with authoring applicability');
        for (const task of Object.values(item.tasks)) {
          if (
            task.execution === 'not_executed' &&
            (task.task_run_id !== null ||
              task.input_sha256 !== null ||
              task.output_sha256 !== null ||
              task.output_digest_basis !== null ||
              task.parse_status !== 'not_executed' ||
              task.reason !== 'not_executed')
          )
            invalid('unexecuted task claims evidence');
          if (
            task.execution === 'returned' &&
            (task.input_sha256 === null ||
              task.output_sha256 === null ||
              task.output_digest_basis === null ||
              !['parsed', 'invalid'].includes(task.parse_status))
          )
            invalid('returned task lacks evidence');
          if (task.execution === 'error' && task.parse_status !== 'unavailable')
            invalid('errored task claims parse result');
        }
        if (
          item.verdict === 'pass' &&
          (item.reasons.length ||
            item.grounding.verdict !== 'pass' ||
            item.grounding.basis_supported !== true ||
            item.semantic.verdict !== 'pass' ||
            item.teaching.verdict !== 'pass' ||
            item.teaching.clarity !== 'pass' ||
            item.teaching.unique_answer !== 'pass')
        )
          invalid('item pass disagrees with checks');
        if (
          existing &&
          item.verdict === 'pass' &&
          (item.semantic.outcome !== 'correct' ||
            item.semantic.confidence === null ||
            item.semantic.confidence < item.semantic.threshold ||
            item.semantic.compared_by !== 'semantic' ||
            Object.values(item.tasks).some((task) => task.parse_status !== 'parsed'))
        )
          invalid('existing answer lacks affirmative full comparison');
      }
    }
  });

export type CopilotValidationDecision = z.infer<typeof CopilotValidationDecisionSchema>;

export function validationIdentity(value: unknown): string | null {
  const parsed = Identity.safeParse(value);
  return parsed.success ? parsed.data : null;
}
