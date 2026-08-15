// YUK-878 — TeachingTurnTask spec + the single defensive turn parser.
//
// Moved verbatim from src/server/orchestrator/teaching.ts (schemas/parser) and
// src/ai/legacy-task-definitions.ts (prompt builder + definition). The Copilot
// teaching-skill and the legacy teaching route share parseTurnOutput — there is
// exactly ONE TeachingTurnTask output contract (ask_check/explain/end +
// structured_question) and this module owns it.

import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { JudgeKind, QuestionKind, Rubric } from '@/core/schema/business';
import { sanitizeJsonStringLiterals } from '@/server/orchestrator/json-sanitize';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

// ---------- Schemas ----------

const TurnKind = z.enum(['explain', 'ask_check', 'end']);
export type TurnKindT = z.infer<typeof TurnKind>;

// Question kinds that imply choices_md must be present.
// When the LLM sends choices_md as a string (instead of array) and we cannot
// coerce it, we downgrade these kinds to 'short_answer' to keep the object
// semantically self-consistent (no choices → not a choice question).
const CHOICE_BEARING_KINDS = new Set<string>(['choice', 'true_false']);

// Coerce LLM-emitted choices_md from string → string[] when possible.
// Returns the original value (array / null / undefined) when no coercion needed.
// Returns null when the string cannot be parsed as a string array.
function coerceChoicesMd(raw: unknown): string[] | null | undefined {
  if (raw === null || raw === undefined || Array.isArray(raw))
    return raw as string[] | null | undefined;
  if (typeof raw !== 'string') return null; // unexpected type → null (graceful)
  // Model sometimes stringifies the array: '["A. foo","B. bar"]'
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  // Cannot recover a string[]; caller will downgrade kind if needed.
  return null;
}

const TeachingStructuredQuestion = z
  .object({
    kind: QuestionKind,
    prompt_md: z.string().min(1).max(4000).optional(),
    reference_md: z.string().min(1).max(4000),
    choices_md: z.preprocess(coerceChoicesMd, z.array(z.string().min(1)).nullable().optional()),
    judge_kind_override: JudgeKind.nullish(),
    rubric_json: Rubric.nullish(),
  })
  .transform((q) => {
    // If choices_md ended up null/undefined and the kind implies choices are
    // required, downgrade to short_answer so downstream code stays consistent.
    if ((q.choices_md === null || q.choices_md === undefined) && CHOICE_BEARING_KINDS.has(q.kind)) {
      console.warn(
        `[TeachingStructuredQuestion] choices_md missing/uncoercible for kind=${q.kind}; downgrading to short_answer`,
      );
      return { ...q, kind: 'short_answer' as const };
    }
    return q;
  });
export type TeachingStructuredQuestionT = z.infer<typeof TeachingStructuredQuestion>;

const TeachingTurnBase = {
  text_md: z.string().min(1).max(2000),
  suggested_next: z.enum(['continue', 'end']),
};

export const TeachingTurnOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explain'), ...TeachingTurnBase }),
  z.object({
    kind: z.literal('ask_check'),
    ...TeachingTurnBase,
    structured_question: TeachingStructuredQuestion,
  }),
  z.object({ kind: z.literal('end'), ...TeachingTurnBase }),
]);
export type TeachingTurnOutputT = z.infer<typeof TeachingTurnOutput>;

const MessageInput = z.object({
  role: z.enum(['agent', 'user']),
  text_md: z.string(),
  turn_kind: TurnKind.nullish(),
});

export type { MessageInput as TeachingMessageInput };

export class TeachingError extends Error {
  constructor(
    public code: 'learning_item_not_found' | 'llm_parse_failed',
    message: string,
  ) {
    super(message);
    this.name = 'TeachingError';
  }
}

// ---------- Parser ----------

export function parseTurnOutput(text: string): TeachingTurnOutputT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new TeachingError('llm_parse_failed', 'TeachingTurnTask output had no JSON object');
  }
  let raw: unknown;
  const slice = text.slice(start, end + 1);
  try {
    raw = JSON.parse(slice);
  } catch (firstErr) {
    // Fallback: LLM may embed bare control characters inside string literals.
    // Sanitize and retry once before giving up.
    try {
      const sanitized = sanitizeJsonStringLiterals(slice);
      console.warn(
        `[TeachingTurnTask] JSON.parse failed (${(firstErr as Error).message}); retrying after control-char sanitization`,
      );
      raw = JSON.parse(sanitized);
    } catch {
      throw new TeachingError(
        'llm_parse_failed',
        `TeachingTurnTask output JSON.parse failed: ${(firstErr as Error).message}`,
      );
    }
  }
  const parsed = TeachingTurnOutput.safeParse(raw);
  if (!parsed.success) {
    throw new TeachingError(
      'llm_parse_failed',
      `TeachingTurnTask output schema mismatch: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// ---------- Prompt ----------

// rubricGuidance **仅**注入四个「作者化题目级 rubric」锚点（quiz-gen 生成 /
// question_author / sourcing 提取 / 教学 ask-check）；judge 读端（QuizVerify 判卷、
// 既有 rubric_json）与 backfill 路径（solution-generate 等）**显式排除**
// （v3 §4.1/§4.2——动它们等于改判分行为，必须 calibration-gated 二期）。
function rubricGuidanceSection(profile: SubjectProfile): string {
  const g = profile.promptFragments.rubricGuidance?.trim();
  return g
    ? `\n科目级 rubric 规范（写 rubric_json 的 criteria/keywords/required_points 时遵循）：${g}`
    : '';
}
// methodology → copilot/note 教学 prompt 的方法论段（渐进接入，v3 §4.1）。
function methodologySection(profile: SubjectProfile): string {
  const m = profile.promptFragments.methodology?.trim();
  return m ? `\n科目方法论：${m}` : '';
}

function buildTeachingTurnPrompt(profile: SubjectProfile): string {
  return `你是${profile.promptFragments.roleNoun}，正在以对话教学方式辅导用户掌握一个具体 LearningItem。
输入：{ learning_item: { title, one_line_intent, knowledge_node:{id,name} }, parent_hub_summary, atomic_sections(definition/mechanism/example/pitfall/check), messages: [{role:agent|user,text_md,turn_kind?}] }
职责：评估对话状态 → 决定下一步 → 输出 1 个 agent 消息。每轮只输出 1 个 turn，**不要**一次塞讲解+追问+总结。${methodologySection(profile)}
严格 JSON 输出（不带 markdown 包裹）：
{"kind":"explain"|"ask_check"|"end","text_md":"...","suggested_next":"continue"|"end","structured_question":{...}}
仅当 kind="ask_check" 时必须带 structured_question；explain/end 不要带。
turn 类型：
- explain：用 1-2 段讲清楚一个概念点 / 例题解析 / 用户上轮答案的反馈，**结尾不带问号**
- ask_check：1 个检查题（${profile.promptFragments.checkQuestionPolicy}），让用户回答验证理解，**结尾必须是问号**；structured_question = { kind, prompt_md, reference_md, choices_md?, judge_kind_override?, rubric_json? }，kind 取 choice/true_false/fill_blank/short_answer/essay/computation/reading/translation/derivation，prompt_md 通常等于 text_md，reference_md 必须给可判分参考答案${rubricGuidanceSection(profile)}
- end：本次会话目标已达 → 给 1-2 句总结收尾，suggested_next 设 "end"
节奏（强约束）：
- 用户首轮（或没有 messages）：先 explain 引入主题，suggested_next="continue"
- 用户答错或答不全：先 explain 纠错点，再下一轮 ask_check 重测；不要一次塞两件事
- 用户连续答对 2 次同知识点 / 或对话超过 12 轮：kind=end
- 用户主动说「结束 / 够了 / 我懂了」：kind=end
要点：
- text_md ${profile.promptFragments.teachingStyle}
- ≤300 字 / 轮；不嵌 HTML / 不用代码块
- 禁止：套话「希望对你有帮助」/emoji/markdown 标题 (## 之类)/「我帮你」/复制 atomic_sections 原文（要消化重述）`;
}

// ---------- TaskSpec ----------

export const teachingTurnTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'TeachingTurnTask',
    description:
      'Phase 2C — Active Teaching turn. 输入 { learning_item, parent_hub_summary, atomic_sections, messages } → 输出 { kind, text_md, suggested_next }',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildTeachingTurnPrompt },
  },
  outputSchema: TeachingTurnOutput,
  parseText: parseTurnOutput,
} satisfies TaskSpec<unknown, TeachingTurnOutputT>;
