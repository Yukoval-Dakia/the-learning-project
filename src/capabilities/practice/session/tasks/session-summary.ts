// SessionSummaryTask is Practice-owned. The output is plain text, not JSON; the
// runner's consumer (src/capabilities/practice/session/server/session-summary.ts) trims,
// clamps to 240 chars and requires non-empty.

import { z } from 'zod';
import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

function buildSessionSummaryPrompt(profile: SubjectProfile): string {
  return `你是学习陪练，会复盘刚结束的复习 session。
科目上下文：${profile.displayName}。${profile.languageStyle}
输入 { session_id, duration_min, numeric_summary, numeric_facts, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating }, ...] }。
numeric_summary 是服务端按本场有效判分算好的量化总结，会原样放在最终摘要开头，你写的内容紧接在它后面，所以不要再复述本场总题数和总正确率；numeric_facts 是同一批真实数字（total_reviewed 总题数、graded 有效判分题数、correct/partial/incorrect 分布、correct_pct 正确率、duration_min 用时分钟、可空）。
top_causes 只来自本场有效判分错误的题，count 是真实计数；category_label 是可供文案使用的可读错因，优先用 label、不要复述裸 id。top_knowledge 的 count 是本场引用次数。notable_attempts 是判错或部分对的最多 3 题。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
学科表达策略：${profile.promptFragments.teachingStyle}
输出一段 ≤70 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表），只写观察和建议两部分，不要写标题：
1) 模式观察：指 1-2 个具体题或知识点的卡壳；可以引用 numeric_facts 或 top_causes 里的真实数字，但必须原样引用——不自算、不约数、不补全
2) 下次建议：1 句具体可执行的建议，必须贴合本学科的条件、目标、知识点或方法触发信号
禁止：编造或估算 numeric_facts 之外的计数、百分比、用时；套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行。`;
}

/** Session input contract (runSessionSummary, src/capabilities/practice/session/server/session-summary.ts). */
export interface SessionSummaryInput {
  session_id: string;
  duration_min: number | null;
  /** Server-rendered fixed numbers, printed verbatim as the summary prefix. */
  numeric_summary: string;
  /** The same real counts in structured form; the only numbers the model may cite. */
  numeric_facts: {
    total_reviewed: number;
    graded: number;
    correct: number;
    partial: number;
    incorrect: number;
    correct_pct: number | null;
    duration_min: number | null;
  };
  top_causes: { category: string; category_label: string | null; count: number }[];
  top_knowledge: { id: string; count: number }[];
  notable_attempts: {
    prompt_md: string;
    user_response_md: string | null;
    fsrs_rating: string | null;
  }[];
}

/** Any non-empty text is shape-valid; the parser clamps to 240 instead of rejecting. */
export const SessionSummaryOutputSchema = z.string().min(1);
export type SessionSummaryOutput = z.infer<typeof SessionSummaryOutputSchema>;

/** Trim, clamp to 240, require non-empty (empty → runner reports skipped:no_events). */
export function parseSessionSummaryOutput(text: string): SessionSummaryOutput {
  return SessionSummaryOutputSchema.parse(text.trim().slice(0, 240));
}

export const sessionSummaryTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SessionSummaryTask',
    description: '复习 session 结束后写观察与建议；可引用服务端给出的本场真实计数',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    context: {
      view: 'none',
      reason: '只汇总当次练习会话的作答明细，不读会话外学习者历史。',
    },

    prompt: { kind: 'profile', build: buildSessionSummaryPrompt },
  },
  outputSchema: SessionSummaryOutputSchema,
  parseText: parseSessionSummaryOutput,
} satisfies TaskSpec<SessionSummaryInput, SessionSummaryOutput>;
