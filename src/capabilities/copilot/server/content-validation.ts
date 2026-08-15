import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { z } from 'zod';
import {
  runQuestionContentValidation,
  runSolveCheck,
  runTeachingQualityCheck,
} from './practice-port';

export const COPILOT_LEARNING_CONTENT_MAX_QUESTIONS = 5;
export const COPILOT_LEARNING_CONTENT_MAX_PROMPT_CHARS = 12_000;
export const COPILOT_LEARNING_CONTENT_MARKER_START = '<!--copilot_learning_content:';

type ValidationRunTaskFn = Parameters<typeof runQuestionContentValidation>[1]['runTaskFn'];

export interface CopilotLearningContentQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json?: unknown;
  knowledge_ids?: string[] | null;
}

export interface CopilotLearningContent {
  subjectId: string;
  questions: CopilotLearningContentQuestion[];
}

const CopilotLearningContentSchema = z.object({
  subject_id: z.string().min(1),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.string().min(1),
        prompt_md: z.string().min(1),
        reference_md: z.string().nullable(),
        choices_md: z.array(z.string().min(1)).nullable(),
        rubric_json: z.unknown(),
        knowledge_ids: z.array(z.string().min(1)).nullable().optional(),
      }),
    )
    .min(1)
    .max(COPILOT_LEARNING_CONTENT_MAX_QUESTIONS),
});

export type CopilotLearningContentExtraction =
  | { text: string; status: 'absent' }
  | { text: string; status: 'malformed' }
  | { text: string; status: 'valid'; content: CopilotLearningContent };

export function extractCopilotLearningContent(text: string): CopilotLearningContentExtraction {
  let content: CopilotLearningContent | undefined;
  let sawMarker = false;
  let sawMalformed = false;
  const cleaned = text.replace(
    /<!--copilot_learning_content:([\s\S]*?)-->/g,
    (_match, raw: string) => {
      sawMarker = true;
      try {
        const parsed = CopilotLearningContentSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          content = {
            subjectId: parsed.data.subject_id,
            questions: parsed.data.questions,
          };
        } else {
          sawMalformed = true;
        }
      } catch {
        sawMalformed = true;
      }
      return '';
    },
  );
  const dangling = cleaned.lastIndexOf(COPILOT_LEARNING_CONTENT_MARKER_START);
  const visibleText = dangling === -1 ? cleaned : cleaned.slice(0, dangling);
  if (dangling !== -1) {
    sawMarker = true;
    sawMalformed = true;
  }
  const trimmed = sawMarker ? visibleText.trimEnd() : visibleText;
  if (sawMalformed || (sawMarker && !content)) return { text: trimmed, status: 'malformed' };
  if (content) return { text: trimmed, status: 'valid', content };
  return { text: trimmed, status: 'absent' };
}

export function containsLearningQuestion(text: string): boolean {
  const explicitLabel =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:(?:题目|练习(?:题)?|测验)(?=\s|[:：])|(?:quiz|question|exercise)\b)/im;
  const numberedQuestion =
    /(?:^|\n)\s*(?:\d+[.)、]|[（(][一二三四五六七八九十\d]+[）)])[^\n]{1,500}[？?]/m;
  const instructionalQuestion =
    /(?:^|\n)[^\n]{0,300}(?:求|计算|证明|选择|判断|解答|solve|calculate|prove|choose)[^\n]{0,300}[？?](?:\n|$)/im;
  return (
    explicitLabel.test(text) || numberedQuestion.test(text) || instructionalQuestion.test(text)
  );
}

export interface CopilotLearningContentValidationDeps {
  db: Db;
  runTaskFn: ValidationRunTaskFn;
}

export type CopilotLearningContentValidationItem = {
  question_id: string;
  question_content:
    | { status: 'completed'; task_run_id?: string; overall: 'pass' | 'needs_review' | 'fail' }
    | { status: 'error'; reason: string };
  solve_check: {
    verdict: 'pass' | 'fail' | 'unsupported';
    reason: string;
    task_run_ids?: string[];
  };
  teaching_quality: { verdict: 'pass' | 'fail' | 'unsupported'; reason: string };
  verdict: 'pass' | 'fail' | 'needs_repair';
};

export interface CopilotLearningContentValidationResult {
  verdict: 'pass' | 'fail' | 'needs_repair';
  items: CopilotLearningContentValidationItem[];
}

function errorReason(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}

export async function validateCopilotLearningContent(
  content: CopilotLearningContent,
  deps: CopilotLearningContentValidationDeps,
): Promise<CopilotLearningContentValidationResult> {
  if (
    content.questions.length === 0 ||
    content.questions.length > COPILOT_LEARNING_CONTENT_MAX_QUESTIONS ||
    content.questions.reduce((sum, question) => sum + question.prompt_md.length, 0) >
      COPILOT_LEARNING_CONTENT_MAX_PROMPT_CHARS
  ) {
    return { verdict: 'fail', items: [] };
  }
  const subjectProfile = resolveSubjectProfile(content.subjectId);
  const items = await Promise.all(
    content.questions.map(async (question): Promise<CopilotLearningContentValidationItem> => {
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
            knowledge_context: [],
            source_pack: null,
            source_refs: [],
            self_copy_safety: null,
            generation_method: 'copilot_learning_content',
            validation_mode: 'release_strict',
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

      const questionContentResult =
        questionContent.status === 'fulfilled'
          ? {
              status: 'completed' as const,
              task_run_id: questionContent.value.task_result.task_run_id,
              overall: questionContent.value.output.overall,
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
        questionContentResult.overall === 'pass' &&
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
  };
}
