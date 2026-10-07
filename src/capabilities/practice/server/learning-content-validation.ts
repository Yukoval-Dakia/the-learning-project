import { createHash } from 'node:crypto';
import { QuestionAuthorDraft, normalizeAuthorStructured } from '@/core/schema/question_author';
import type { Db } from '@/db/client';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  type LearningContentDecision,
  type LearningValidationTaskEvidence,
  validationIdentity,
} from '@/kernel/learning-content-validation';
import type { LearningContentValidationRequest } from '@/kernel/tools/types';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  SOLVE_CHECK_SEMANTIC_THRESHOLD,
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
  /** Actually executed remote-MCP calls of this turn; forwarded only when present. */
  remoteToolEvidence?: unknown;
  /** Server-bound full visible answer; never supplied by a model-authored manifest. */
  answerScope?: 'full_response';
  /** Only Copilot finalization requests durable decision evidence. Other consumers keep their result shape. */
  captureDecision?: true;
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
  decision?: LearningContentDecision;
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

/**
 * YUK-993 — does a forwarded remote-evidence packet contain at least one call
 * that actually RETURNED an output? The packet also lists failed calls
 * (`failure` entries carry no `output`), and a failure corroborates nothing:
 * a packet of only failures must keep the basis unsupported.
 */
function hasReturnedRemoteOutput(packet: unknown): boolean {
  return (
    Array.isArray(packet) &&
    packet.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { output?: unknown }).output !== undefined,
    )
  );
}

export async function validateLearningContent(
  content: LearningContentValidationRequest,
  deps: LearningContentValidationDeps,
): Promise<LearningContentValidationResult> {
  const existingAnswer = deps.answerScope === 'full_response';
  const purpose = existingAnswer ? 'existing_answer' : 'learning_content';
  const captureDecision = deps.captureDecision === true || existingAnswer;
  const inputSha = captureDecision ? sha256CanonicalJson(content) : null;
  const visibleSha =
    existingAnswer && content.questions.length === 1
      ? createHash('sha256')
          .update(content.questions[0].reference_md ?? '', 'utf8')
          .digest('hex')
      : null;
  const rejected = (
    reason: LearningContentDecision['reason'],
  ): LearningContentValidationResult => ({
    verdict: 'fail',
    items: [],
    ...(inputSha
      ? {
          decision: {
            purpose,
            input_sha256: inputSha,
            visible_sha256: visibleSha,
            verdict: 'fail',
            reason,
            items: [],
          },
        }
      : {}),
  });
  if (
    existingAnswer &&
    (content.questions.length !== 1 ||
      deps.observedQuestion ||
      !content.questions[0].reference_md?.trim() ||
      content.questions[0].reference_md.length > 12_000)
  ) {
    return rejected('mapping_rejected');
  }
  if (
    content.questions.length === 0 ||
    content.questions.length > LEARNING_CONTENT_MAX_QUESTIONS ||
    content.questions.reduce((sum, question) => sum + question.prompt_md.length, 0) >
      LEARNING_CONTENT_MAX_PROMPT_CHARS
  ) {
    return rejected('bounds_rejected');
  }
  const subjectProfile = resolveSubjectProfile(content.subjectId);
  let source: Awaited<ReturnType<typeof resolveObservedSource>>;
  try {
    source = await resolveObservedSource(content, deps);
  } catch {
    return rejected('source_rejected');
  }
  const assessed = await Promise.all(
    content.questions.map(async (question) => {
      const emptyTask = (): LearningValidationTaskEvidence => ({
        task_run_id: null,
        execution: 'not_executed',
        input_sha256: null,
        output_sha256: null,
        output_digest_basis: null,
        parse_status: 'not_executed',
        reason: 'not_executed',
      });
      const tasks = {
        quiz: emptyTask(),
        solver: emptyTask(),
        semantic: emptyTask(),
        teaching: emptyTask(),
      };
      // Capture identities/digests at the existing invocation, including results whose
      // consumer subsequently rejects parsing. Never retain text in the decision.
      const runTaskFn: LearningContentValidationDeps['runTaskFn'] = async (kind, input, ctx) => {
        if (!captureDecision) return deps.runTaskFn(kind, input, ctx);
        const evidence =
          kind === 'QuizVerifyTask'
            ? tasks.quiz
            : kind === 'SolutionGenerateTask'
              ? tasks.solver
              : kind === 'SemanticJudgeTask'
                ? tasks.semantic
                : kind === 'TeachingQualityTask'
                  ? tasks.teaching
                  : undefined;
        if (evidence?.execution !== 'not_executed') throw new Error('unexpected validation task');
        evidence.input_sha256 = sha256CanonicalJson(input);
        evidence.execution = 'error';
        evidence.parse_status = 'unavailable';
        evidence.reason = 'task_error';
        try {
          const result = await deps.runTaskFn(kind, input, ctx);
          evidence.task_run_id = validationIdentity(result.task_run_id);
          const structured =
            (kind !== 'TeachingQualityTask' || existingAnswer) &&
            result.structured_output !== undefined &&
            result.structured_output !== null;
          evidence.output_sha256 = structured
            ? sha256CanonicalJson(result.structured_output)
            : createHash('sha256').update(result.text, 'utf8').digest('hex');
          evidence.output_digest_basis = structured ? 'structured_output' : 'text';
          evidence.execution = 'returned';
          return result;
        } catch (error) {
          if (error instanceof Error) {
            if ('taskRunId' in error) evidence.task_run_id = validationIdentity(error.taskRunId);
            evidence.reason =
              error.name === 'AbortError'
                ? 'cancelled'
                : error.name === 'TimeoutError' ||
                    error.name === 'ProviderSessionWallClockBudgetError' ||
                    ('subtype' in error && error.subtype === 'budget_timeout')
                  ? 'deadline'
                  : 'task_error';
          }
          throw error;
        }
      };
      const parsedTask = (task: LearningValidationTaskEvidence, parsed: boolean): void => {
        if (task.execution !== 'returned') return;
        task.parse_status = parsed ? 'parsed' : 'invalid';
        task.reason = parsed ? 'parsed' : 'parse_invalid';
      };
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
            ...(deps.remoteToolEvidence ? { remote_tool_evidence: deps.remoteToolEvidence } : {}),
            validation_mode: 'release_strict',
            validation_purpose: purpose,
          },
          { runTaskFn, db: deps.db, subjectProfile },
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
            runTaskFn,
            db: deps.db,
            profile: { id: subjectProfile.id, full: subjectProfile },
            validationMode: 'release_strict',
            ...(captureDecision ? { captureParseEvidence: true } : {}),
            answerScope: deps.answerScope,
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
            runTaskFn,
            db: deps.db,
            profile: { id: subjectProfile.id, full: subjectProfile },
            ...(existingAnswer ? { validationMode: 'release_strict' } : {}),
          },
        ),
      ]);

      const output =
        questionContent.status === 'fulfilled' ? questionContent.value.output : undefined;
      const basis = output?.grounding.basis;
      // YUK-993 — 'executed_remote_evidence' is supported only when the verify
      // task input actually carried a non-empty packet of this turn's executed
      // remote-MCP calls AND at least one call returned an output: the exact
      // evidence the judge corroborated against, not a model self-declaration.
      // Read it off task_input (what the judge saw) so an absent/empty/
      // non-array/failures-only packet keeps the basis unsupported and the
      // question fails closed exactly as before.
      const forwardedRemoteEvidence =
        questionContent.status === 'fulfilled'
          ? questionContent.value.task_input.remote_tool_evidence
          : undefined;
      const basisSupported =
        basis === 'closed_world_givens' ||
        basis === 'discipline_knowledge' ||
        (basis === 'material' && !!source?.material) ||
        (basis === 'executed_remote_evidence' && hasReturnedRemoteOutput(forwardedRemoteEvidence));
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
      // executed_remote_evidence is deliberately absent from this basis list: when a
      // non-empty packet was forwarded the judge had a real comparison corpus, so a
      // still-'unknown' copy verdict means review did NOT clear originality — the
      // item stays unadmitted instead of riding the source-free passthrough.
      const copyOnlyReview =
        source?.generation_method === 'closed_book' &&
        !source.material &&
        output?.overall === 'needs_review' &&
        output.copy_safety.verdict === 'unknown' &&
        (basis === 'closed_world_givens' || basis === 'discipline_knowledge');
      const generatedContentAdmitted =
        axesPass &&
        ((output?.overall === 'pass' && output.copy_safety.verdict === 'original') ||
          copyOnlyReview);
      const contentAdmitted = existingAnswer
        ? !!output && output.grounding.verdict === 'pass' && basisSupported
        : generatedContentAdmitted;
      parsedTask(tasks.quiz, questionContent.status === 'fulfilled');
      parsedTask(
        tasks.solver,
        solveCheck.status === 'fulfilled' && solveCheck.value.solver_parse_status === 'parsed',
      );
      parsedTask(
        tasks.semantic,
        solveCheck.status === 'fulfilled' &&
          solveCheck.value.semantic_decision !== undefined &&
          solveCheck.value.semantic_decision.outcome !== 'unsupported',
      );
      parsedTask(
        tasks.teaching,
        teachingQuality.status === 'fulfilled' && teachingQuality.value.verdict !== 'unsupported',
      );
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

      const item: LearningContentValidationItem = {
        question_id: question.id,
        question_content: questionContentResult,
        solve_check: solveCheckResult,
        teaching_quality: teachingQualityResult,
        verdict: passes ? 'pass' : 'fail',
      };
      if (!captureDecision) return { item, decision: undefined };
      const solve = solveCheck.status === 'fulfilled' ? solveCheck.value : undefined;
      const teaching = teachingQuality.status === 'fulfilled' ? teachingQuality.value : undefined;
      const reasons: LearningContentDecision['items'][number]['reasons'] = [];
      if (output?.grounding.verdict !== 'pass') reasons.push('grounding_rejected');
      if (output && !basisSupported) reasons.push('basis_unsupported');
      if (!existingAnswer && !generatedContentAdmitted) reasons.push('authoring_rejected');
      if (solveCheckResult.verdict !== 'pass') reasons.push('solve_rejected');
      if (teachingQualityResult.verdict !== 'pass') reasons.push('teaching_rejected');
      if (
        Object.values(tasks).some(
          (task) => task.execution === 'error' || task.parse_status === 'invalid',
        )
      )
        reasons.push('task_or_parse_error');
      const applicability = existingAnswer ? 'diagnostic' : 'required';
      const decision: LearningContentDecision['items'][number] = {
        question_id: validationIdentity(question.id),
        question_sha256: sha256CanonicalJson(question),
        verdict: item.verdict === 'pass' ? 'pass' : 'fail',
        reasons,
        tasks,
        grounding: {
          verdict: output?.grounding.verdict ?? null,
          basis: basis ?? null,
          basis_supported: output ? basisSupported : null,
        },
        authoring: {
          copy_safety: { applicability, verdict: output?.copy_safety.verdict ?? null },
          knowledge_hit: { applicability, verdict: output?.knowledge_hit.verdict ?? null },
          overall: { applicability, verdict: output?.overall ?? null },
          material_grounding: {
            applicability: existingAnswer
              ? 'diagnostic'
              : source?.material
                ? 'required'
                : 'if_reported',
            verdict: output?.material_grounding?.verdict ?? null,
          },
          kind_conformance: {
            applicability: existingAnswer ? 'diagnostic' : 'if_reported',
            verdict: output?.kind_conformance?.verdict ?? null,
          },
        },
        semantic: {
          verdict: solveCheckResult.verdict,
          outcome:
            tasks.semantic.parse_status === 'parsed'
              ? (solve?.semantic_decision?.outcome ?? null)
              : null,
          confidence:
            tasks.semantic.parse_status === 'parsed'
              ? (solve?.semantic_decision?.confidence ?? null)
              : null,
          threshold: SOLVE_CHECK_SEMANTIC_THRESHOLD,
          compared_by: solve?.compared_by ?? 'none',
          direction: existingAnswer
            ? 'visible_answer_against_independent_solution'
            : 'independent_solution_against_declared_reference',
        },
        teaching: {
          verdict: teachingQualityResult.verdict,
          clarity:
            tasks.teaching.parse_status === 'parsed' ? (teaching?.clarity.verdict ?? null) : null,
          unique_answer:
            tasks.teaching.parse_status === 'parsed'
              ? (teaching?.unique_answer.verdict ?? null)
              : null,
          distractor_power:
            tasks.teaching.parse_status === 'parsed'
              ? (teaching?.distractor_power.verdict ?? null)
              : null,
        },
      };
      return { item, decision };
    }),
  );

  const items = assessed.map(({ item }) => item);
  const verdict = items.every((item) => item.verdict === 'pass') ? 'pass' : 'fail';
  return {
    verdict,
    items,
    ...(inputSha
      ? {
          decision: {
            purpose,
            input_sha256: inputSha,
            visible_sha256: visibleSha,
            verdict,
            reason: verdict === 'pass' ? 'passed' : 'checks_rejected',
            items: assessed.flatMap(({ decision }) => (decision ? [decision] : [])),
          },
        }
      : {}),
    ...(items.some(
      (item) =>
        item.question_content.status === 'completed' &&
        item.question_content.copy_comparison === 'not_observed',
    )
      ? { copy_comparison: 'not_observed' as const }
      : {}),
  };
}
