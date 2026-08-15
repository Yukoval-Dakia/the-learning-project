import {
  runIndependentSolution,
  runQuestionContentValidation,
  runTeachingQualityCheck,
} from '@/capabilities/practice/server/quiz/verify-framework';
import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { resolveSubjectProfile } from '@/subjects/profile';
import { z } from 'zod';

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
    .min(1),
});

export function extractCopilotLearningContent(text: string): {
  text: string;
  content?: CopilotLearningContent;
} {
  let content: CopilotLearningContent | undefined;
  const cleaned = text.replace(
    /<!--copilot_learning_content:([\s\S]*?)-->/g,
    (_match, raw: string) => {
      try {
        const parsed = CopilotLearningContentSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          content = {
            subjectId: parsed.data.subject_id,
            questions: parsed.data.questions,
          };
        }
      } catch {}
      return '';
    },
  );
  return content ? { text: cleaned.trimEnd(), content } : { text: cleaned.trimEnd() };
}

export interface CopilotLearningContentValidationDeps {
  db: Db;
  runTaskFn: TaskTextRunFn;
}

export type CopilotLearningContentValidationItem = {
  question_id: string;
  question_content:
    | { status: 'completed'; task_run_id?: string; overall: 'pass' | 'needs_review' | 'fail' }
    | { status: 'error'; reason: string };
  independent_solution:
    | { status: 'solved'; task_run_id: string }
    | { status: 'unsupported'; reason: string };
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
  const subjectProfile = resolveSubjectProfile(content.subjectId);
  const items = await Promise.all(
    content.questions.map(async (question): Promise<CopilotLearningContentValidationItem> => {
      const [questionContent, independentSolution, teachingQuality] = await Promise.allSettled([
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
        runIndependentSolution(
          {
            id: question.id,
            kind: question.kind,
            prompt_md: question.prompt_md,
            choices_md: question.choices_md,
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
      let independentSolutionResult: CopilotLearningContentValidationItem['independent_solution'];
      if (
        independentSolution.status === 'fulfilled' &&
        independentSolution.value.status === 'solved'
      ) {
        independentSolutionResult = {
          status: 'solved',
          task_run_id: independentSolution.value.task_run_id,
        };
      } else if (
        independentSolution.status === 'fulfilled' &&
        independentSolution.value.status === 'unsupported'
      ) {
        independentSolutionResult = {
          status: 'unsupported',
          reason: independentSolution.value.reason,
        };
      } else if (independentSolution.status === 'fulfilled') {
        independentSolutionResult = {
          status: 'unsupported',
          reason: 'independent solution did not produce a solved or unsupported verdict',
        };
      } else {
        independentSolutionResult = {
          status: 'unsupported',
          reason: errorReason(independentSolution),
        };
      }
      const teachingQualityResult =
        teachingQuality.status === 'fulfilled'
          ? { verdict: teachingQuality.value.verdict, reason: teachingQuality.value.reason }
          : { verdict: 'unsupported' as const, reason: errorReason(teachingQuality) };
      const passes =
        questionContentResult.status === 'completed' &&
        questionContentResult.overall === 'pass' &&
        independentSolutionResult.status === 'solved' &&
        teachingQualityResult.verdict === 'pass';

      return {
        question_id: question.id,
        question_content: questionContentResult,
        independent_solution: independentSolutionResult,
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
