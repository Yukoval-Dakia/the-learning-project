import { z } from 'zod';
import { extractVisibleHtmlText, htmlContainsAssessment } from '@/kernel/learning-content';
import type { LearningContentValidationRequest } from '@/kernel/tools/types';
import {
  LEARNING_CONTENT_MAX_QUESTIONS,
  type LearningContentValidationDeps,
  validateLearningContent,
} from './practice-port';

export const COPILOT_LEARNING_CONTENT_MARKER_START = '<!--copilot_learning_content:';
export const COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY =
  '这份学习内容未完成独立校验，暂不展示。请重试，我会先校验再发送。';

export type CopilotLearningContent = LearningContentValidationRequest;

export const CopilotLearningContentSchema = z.object({
  subject_id: z.string().min(1),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        kind: z.string().min(1).max(80),
        prompt_md: z.string().min(1).max(6_000),
        reference_md: z.string().max(12_000).nullable(),
        choices_md: z.array(z.string().min(1).max(2_000)).max(12).nullable(),
        rubric_json: z.unknown().optional(),
        knowledge_ids: z.array(z.string().min(1).max(120)).max(50).nullable().optional(),
      }),
    )
    .min(1)
    .max(LEARNING_CONTENT_MAX_QUESTIONS),
});

export type CopilotLearningContentExtraction =
  | { text: string; status: 'absent' }
  | { text: string; status: 'malformed' }
  | { text: string; status: 'valid'; content: CopilotLearningContent };

export function extractCopilotLearningContent(text: string): CopilotLearningContentExtraction {
  let content: CopilotLearningContent | undefined;
  let sawMarker = false;
  let sawMalformed = false;
  let markerCount = 0;
  const cleaned = text.replace(
    /<!--copilot_learning_content:([\s\S]*?)-->/g,
    (_match, raw: string) => {
      sawMarker = true;
      markerCount += 1;
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
  if (sawMalformed || markerCount > 1 || (sawMarker && !content)) {
    return { text: trimmed, status: 'malformed' };
  }
  if (content) return { text: trimmed, status: 'valid', content };
  return { text: trimmed, status: 'absent' };
}

export function containsLearningQuestion(text: string): boolean {
  const explicitLabel =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:(?:题目|练习(?:题)?|测验)(?=\s|[:：])|(?:quiz|question|exercise)\b)/im;
  const numberedQuestion =
    /(?:^|\n)\s*(?:\d+[.)、]|[（(][一二三四五六七八九十\d]+[）)])[^\n]{1,500}[？?]/m;
  // Direct instructions remain assessments when an answer follows on the same
  // line. Anchor the imperative, not the question's end, so rhetorical report
  // prose such as “为什么选择这个方案？因为预算有限。” is not newly classified.
  const directInstruction =
    /(?:^|\n|[。？?；;])\s*(?:#{1,6}\s*)?(?:(?:请(?:问|你)?|帮我|麻烦你?|试|尝试|(?:你)?(?:能否|能|可以)|可否)\s*){0,2}(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:求|计算|证明|选择|判断|解答|solve\b|calculate\b|prove\b|choose\b)[^\n？?]{1,600}[？?]/im;
  const instructionalQuestionCandidates =
    /(?:^|\n)[^\n]{0,300}(?:求|计算|证明|选择|判断|解答|solve|calculate|prove|choose)[^\n]{0,300}[？?](?:\n|$)/gim;
  const activeInstructionalQuestion = [...text.matchAll(instructionalQuestionCandidates)].some(
    ([match]) => {
      const candidate = match;
      const verbs = /求|计算|证明|选择|判断|解答|solve|calculate|prove|choose/gi;
      return [...candidate.matchAll(verbs)].some((verbMatch) => {
        // Exempt only a completed-observation status question. Past tense alone
        // is not enough: “欧几里得证明了什么？” is still an unlabelled learning question.
        // Evaluate each verb independently so a later real instruction remains protected.
        const verb = verbMatch[0];
        const offset = verbMatch.index ?? 0;
        const prefix = candidate.slice(Math.max(0, offset - 4), offset);
        const clause = candidate.slice(offset + verb.length).split(/[？?。；;]/u)[0];
        return !/是否已(?:经)?$/.test(prefix) || /什么|哪|如何|怎样|为何|为什么/u.test(clause);
      });
    },
  );
  return (
    explicitLabel.test(text) ||
    numberedQuestion.test(text) ||
    directInstruction.test(text) ||
    activeInstructionalQuestion
  );
}

function containsLearningSolution(text: string): boolean {
  const explicitSolution =
    /(?:^|\n)\s*(?:解[:：]|答案[:：]|解答[:：]|solution\b|answer\b)|(?:所以|因此|故|therefore)[^\n]{0,300}(?:答案|=)/im;
  const arithmeticEquation =
    /(?:^|\n)\s*(?:\d+(?:\.\d+)?|\d*[a-z](?:\^\d+)?)(?:\s*[+\-×÷*/^]\s*(?:\d+(?:\.\d+)?|\d*[a-z](?:\^\d+)?))+\s*=\s*[-+]?(?:\d+(?:\.\d+)?|\d*[a-z](?:\^\d+)?)(?:\s*[。.;；]|(?=\s*(?:\n|$)))/im;
  // A step label must be in a Markdown header (followed by the delimiter row),
  // not a data cell such as "3-step diagnostics" in an event comparison report.
  const computationTableHeader =
    /(?:^|\n)\s*\|[^\n]*(?:\bsteps?\b|\biterations?\b|迭代|步数|第.?步)[^\n]*\|[^\S\r\n]*\r?\n[^\S\r\n]*\|(?:[^\S\r\n]*:?-+:?[^\S\r\n]*\|)+[^\S\r\n]*(?=\r?\n|$)/im;
  const numericTableRowCount = (text.match(/(?:^|\n)\s*\|[^\n]*\d[^\n]*\|(?=\n|$)/gm) ?? []).length;
  return (
    explicitSolution.test(text) ||
    arithmeticEquation.test(text) ||
    (computationTableHeader.test(text) && numericTableRowCount >= 2)
  );
}

export function copilotLearningContentRequiresValidation(candidateText: string): boolean {
  const extracted = extractCopilotLearningContent(candidateText);
  return (
    extracted.status !== 'absent' ||
    containsLearningQuestion(extracted.text) ||
    containsLearningSolution(extracted.text)
  );
}

function normalizedLearningText(value: string): string {
  return value
    .replace(/[*_`~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function contentMatchesReply(
  content: CopilotLearningContent,
  replyText: string,
  contextText: string,
): boolean {
  const normalizedReply = normalizedLearningText(replyText);
  const normalizedContext = normalizedLearningText(contextText);
  const visibleQuestionCount = [...replyText.matchAll(/(?:^|\n)\s*[^\n]{1,500}[？?](?=\n|$)/g)]
    .length;
  if (visibleQuestionCount > 0 && visibleQuestionCount !== content.questions.length) return false;
  return content.questions.every((question) => {
    const prompt = normalizedLearningText(question.prompt_md);
    const promptInReply = normalizedReply.includes(prompt);
    const promptInContext = normalizedContext.includes(prompt);
    if (!promptInReply && !promptInContext) return false;
    const choices = question.choices_md ?? [];
    const choicesVisible = choices.every((choice) => {
      const normalizedChoice = normalizedLearningText(choice);
      return (
        normalizedReply.includes(normalizedChoice) || normalizedContext.includes(normalizedChoice)
      );
    });
    if (!choicesVisible) return false;
    if (promptInReply) return true;
    const reference = normalizedLearningText(question.reference_md ?? '');
    return reference.length > 0 && normalizedReply.includes(reference);
  });
}

export interface CopilotLearningContentValidationDeps extends LearningContentValidationDeps {
  additionalVisibleText?: string;
  /** Server-derived generated question, never a model-authored reply marker. */
  additionalQuestionContent?: CopilotLearningContent;
}

export interface CopilotLearningContentReviewResult {
  replyText: string;
  passed: boolean;
}

export async function reviewCopilotLearningContent(
  candidateText: string,
  contextText: string,
  taskRunId: string,
  deps: CopilotLearningContentValidationDeps,
): Promise<CopilotLearningContentReviewResult> {
  const extracted = extractCopilotLearningContent(candidateText);
  const validationSurface = deps.additionalVisibleText
    ? `${extracted.text}\n${extractVisibleHtmlText(deps.additionalVisibleText)}`
    : extracted.text;
  const requiresManifest =
    extracted.status !== 'absent' ||
    (deps.additionalVisibleText !== undefined &&
      htmlContainsAssessment(deps.additionalVisibleText)) ||
    containsLearningQuestion(validationSurface) ||
    containsLearningSolution(validationSurface);
  if (extracted.status === 'malformed' || (extracted.status === 'absent' && requiresManifest)) {
    console.warn('[copilot-learning-content] marker missing or malformed', {
      task_run_id: taskRunId,
      marker_status: extracted.status,
    });
    return { replyText: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY, passed: false };
  }
  let additionalValidated = false;
  let copyNotObserved = false;
  if (deps.additionalQuestionContent) {
    // A typed candidate is always a question, even JSON or prose without '?'.
    // Validate its real normalized fields independently of terminal heuristics.
    try {
      const validation = await validateLearningContent(deps.additionalQuestionContent, deps);
      if (validation.verdict !== 'pass')
        return { replyText: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY, passed: false };
      additionalValidated = true;
      copyNotObserved = validation.copy_comparison === 'not_observed';
    } catch {
      return { replyText: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY, passed: false };
    }
  }
  if (extracted.status === 'absent')
    return {
      replyText: additionalValidated
        ? `${extracted.text}\n\n独立内容验证：通过${copyNotObserved ? '；未对外部题库进行原创性比对。' : ''}`
        : extracted.text,
      passed: true,
    };
  if (!contentMatchesReply(extracted.content, validationSurface, contextText)) {
    console.error('[copilot-learning-content] manifest does not match visible content', {
      task_run_id: taskRunId,
    });
    return { replyText: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY, passed: false };
  }
  try {
    const validation = await validateLearningContent(extracted.content, {
      ...deps,
      observedQuestion: undefined,
    });
    if (validation.verdict !== 'pass') {
      console.error('[copilot-learning-content] validation rejected', {
        task_run_id: taskRunId,
        validation,
      });
      return { replyText: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY, passed: false };
    }
    return {
      replyText: `${extracted.text}\n\n独立内容验证：通过${copyNotObserved || validation.copy_comparison === 'not_observed' ? '；未对外部题库进行原创性比对。' : ''}`,
      passed: true,
    };
  } catch (error) {
    console.error('[copilot-learning-content] validation error', { task_run_id: taskRunId, error });
    return { replyText: COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY, passed: false };
  }
}
