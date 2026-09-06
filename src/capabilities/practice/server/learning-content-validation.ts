import { QuestionAuthorDraft, normalizeAuthorStructured } from '@/core/schema/question_author';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import type { LearningContentValidationRequest } from '@/kernel/tools/types';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  runQuestionContentValidation,
  runSolveCheck,
  runTeachingQualityCheck,
} from './quiz/verify-framework';
import {
  GenerateQuestionCandidateInputSchema,
  GenerateQuestionCandidateOutputSchema,
} from './tools/generate-question-candidate';
import { prepareQuestionAuthorTask } from './tools/question-author';

export const LEARNING_CONTENT_MAX_QUESTIONS = 5;
export const LEARNING_CONTENT_MAX_PROMPT_CHARS = 12_000;
export interface LearningContentValidationDeps {
  db: Db;
  runTaskFn: Parameters<typeof runQuestionContentValidation>[1]['runTaskFn'];
  /** Actual successful DomainTool observation, supplied only by the execution owner. */
  observedQuestion?: { input: unknown; output: unknown };
}

/** Practice owns assessment policy; transports only supply the content and task runtime. */
export type LearningContentValidationItem = {
  question_id: string;
  question_content:
    | {
        status: 'completed';
        task_run_id?: string;
        overall: 'pass' | 'needs_review' | 'fail';
        copy_comparison: 'not_observed' | 'provided_material';
        admitted: boolean;
      }
    | { status: 'error'; reason: string };
  solve_check: {
    verdict: 'pass' | 'fail' | 'unsupported';
    reason: string;
    task_run_ids?: string[];
  };
  teaching_quality: { verdict: 'pass' | 'fail' | 'unsupported'; reason: string };
  verdict: 'pass' | 'fail' | 'needs_repair';
};

export interface LearningContentValidationResult {
  verdict: 'pass' | 'fail' | 'needs_repair';
  items: LearningContentValidationItem[];
  copy_comparison?: 'not_observed';
}

async function resolveObservedSource(
  content: LearningContentValidationRequest,
  deps: LearningContentValidationDeps,
) {
  if (!deps.observedQuestion) return undefined;
  const intent = GenerateQuestionCandidateInputSchema.parse(deps.observedQuestion.input);
  const output = GenerateQuestionCandidateOutputSchema.parse(deps.observedQuestion.output);
  const prepared = await prepareQuestionAuthorTask({ db: deps.db }, intent);
  if (
    prepared.ctx.subjectProfile.id !== output.subject_id ||
    output.subject_id !== content.subjectId ||
    content.questions.length !== 1
  )
    throw new Error('generated question subject or count does not match its observed source');
  const draft = QuestionAuthorDraft.parse(JSON.parse(output.text));
  const allowedIds = new Set(prepared.input.knowledge_context.map((node) => node.id));
  if (draft.knowledge_ids.some((id) => !allowedIds.has(id)))
    throw new Error('generated question escaped its observed knowledge scope');
  let ordinal = 0;
  const normalized = normalizeAuthorStructured(draft.structured, () => `validation-${++ordinal}`);
  const question = content.questions[0];
  const expected = {
    kind: draft.kind,
    prompt_md: normalized.prompt_md,
    reference_md: normalized.reference_md,
    choices_md: draft.choices_md ?? null,
    rubric_json: draft.rubric_json ?? null,
    knowledge_ids: draft.knowledge_ids,
  };
  const actual = {
    kind: question.kind,
    prompt_md: question.prompt_md,
    reference_md: question.reference_md,
    choices_md: question.choices_md,
    rubric_json: question.rubric_json ?? null,
    knowledge_ids: question.knowledge_ids ?? [],
  };
  if (sha256CanonicalJson(expected) !== sha256CanonicalJson(actual))
    throw new Error('visible question differs from the executed candidate');
  return {
    knowledge_context: prepared.input.knowledge_context,
    generation_method: prepared.input.material ? 'material_grounded' : 'closed_book',
    ...(prepared.input.material
      ? {
          material: {
            title: prepared.input.material.title ?? null,
            body_md: prepared.input.material.body_md,
          },
        }
      : {}),
  };
}

function errorReason(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

export async function validateLearningContent(
  content: LearningContentValidationRequest,
  deps: LearningContentValidationDeps,
): Promise<LearningContentValidationResult> {
  if (
    content.questions.length === 0 ||
    content.questions.length > LEARNING_CONTENT_MAX_QUESTIONS ||
    content.questions.reduce((sum, question) => sum + question.prompt_md.length, 0) >
      LEARNING_CONTENT_MAX_PROMPT_CHARS
  ) {
    return { verdict: 'fail', items: [] };
  }
  const subjectProfile = resolveSubjectProfile(content.subjectId);
  let source: Awaited<ReturnType<typeof resolveObservedSource>>;
  try {
    source = await resolveObservedSource(content, deps);
  } catch {
    return { verdict: 'fail', items: [] };
  }
  const items = await Promise.all(
    content.questions.map(async (question): Promise<LearningContentValidationItem> => {
      const [questionContent, solveCheck, teachingQuality] = await Promise.allSettled([
        runQuestionContentValidation(
          {
            question: {
              id: question.id,
              kind: question.kind,
              prompt_md: question.prompt_md,
              reference_md: question.reference_md,
              choices_md: question.choices_md,
              knowledge_ids: question.knowledge_ids ?? null,
            },
            knowledge_context: source?.knowledge_context ?? [],
            source_pack: null,
            source_refs: [],
            self_copy_safety: null,
            generation_method: source?.generation_method ?? 'unspecified',
            ...(source?.material ? { material: source.material } : {}),
            validation_mode: 'release_strict',
            validation_purpose: 'learning_content',
          },
          { runTaskFn: deps.runTaskFn, db: deps.db, subjectProfile },
        ),
        runSolveCheck(
          {
            id: question.id,
            kind: question.kind,
            prompt_md: question.prompt_md,
            choices_md: question.choices_md,
            reference_md: question.reference_md,
            rubric_json: question.rubric_json ?? null,
            judge_kind_override: null,
            knowledge_ids: question.knowledge_ids ?? null,
          },
          {
            runTaskFn: deps.runTaskFn,
            db: deps.db,
            profile: { id: subjectProfile.id, full: subjectProfile },
            validationMode: 'release_strict',
          },
        ),
        runTeachingQualityCheck(
          {
            id: question.id,
            kind: question.kind,
            prompt_md: question.prompt_md,
            reference_md: question.reference_md,
            choices_md: question.choices_md,
            rubric_json: question.rubric_json,
          },
          {
            runTaskFn: deps.runTaskFn,
            db: deps.db,
            profile: { id: subjectProfile.id, full: subjectProfile },
          },
        ),
      ]);

      const output =
        questionContent.status === 'fulfilled' ? questionContent.value.output : undefined;
      const basis = output?.grounding.basis;
      const basisSupported =
        basis === 'closed_world_givens' ||
        basis === 'discipline_knowledge' ||
        (basis === 'material' && !!source?.material);
      const axesPass =
        !!output &&
        output.grounding.verdict === 'pass' &&
        basisSupported &&
        output.knowledge_hit.verdict === 'pass' &&
        (!source?.material || output.material_grounding?.verdict === 'pass') &&
        (!output.material_grounding || output.material_grounding.verdict === 'pass') &&
        (!output.kind_conformance || output.kind_conformance.verdict === 'pass') &&
        output.copy_safety.verdict !== 'too_close' &&
        output.overall !== 'fail';
      // Preview admission is not pool promotion or a claim of global originality.
      // Only trace-bound, source-free candidates can leave copy comparison unknown.
      const copyOnlyReview =
        source?.generation_method === 'closed_book' &&
        !source.material &&
        output?.overall === 'needs_review' &&
        output.copy_safety.verdict === 'unknown' &&
        (basis === 'closed_world_givens' || basis === 'discipline_knowledge');
      const contentAdmitted =
        axesPass &&
        ((output?.overall === 'pass' && output.copy_safety.verdict === 'original') ||
          copyOnlyReview);
      const questionContentResult =
        questionContent.status === 'fulfilled'
          ? {
              status: 'completed' as const,
              task_run_id: questionContent.value.task_result.task_run_id,
              overall: questionContent.value.output.overall,
              copy_comparison: source?.material
                ? ('provided_material' as const)
                : ('not_observed' as const),
              admitted: contentAdmitted,
            }
          : { status: 'error' as const, reason: errorReason(questionContent) };
      const solveCheckResult =
        solveCheck.status === 'fulfilled'
          ? {
              verdict: solveCheck.value.verdict,
              reason: solveCheck.value.reason,
              ...(solveCheck.value.task_run_ids
                ? { task_run_ids: solveCheck.value.task_run_ids }
                : {}),
            }
          : { verdict: 'unsupported' as const, reason: errorReason(solveCheck) };
      const teachingQualityResult =
        teachingQuality.status === 'fulfilled'
          ? { verdict: teachingQuality.value.verdict, reason: teachingQuality.value.reason }
          : { verdict: 'unsupported' as const, reason: errorReason(teachingQuality) };
      const passes =
        questionContentResult.status === 'completed' &&
        questionContentResult.admitted &&
        solveCheckResult.verdict === 'pass' &&
        teachingQualityResult.verdict === 'pass';

      return {
        question_id: question.id,
        question_content: questionContentResult,
        solve_check: solveCheckResult,
        teaching_quality: teachingQualityResult,
        verdict: passes ? 'pass' : 'fail',
      };
    }),
  );

  return {
    verdict: items.every((item) => item.verdict === 'pass') ? 'pass' : 'fail',
    items,
    ...(items.some(
      (item) =>
        item.question_content.status === 'completed' &&
        item.question_content.copy_comparison === 'not_observed',
    )
      ? { copy_comparison: 'not_observed' as const }
      : {}),
  };
}
