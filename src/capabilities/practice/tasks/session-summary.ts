// SessionSummaryTask is Practice-owned. The output is plain text, not JSON; the
// runner's consumer (src/capabilities/practice/server/session-summary.ts) trims,
// clamps to 240 chars and requires non-empty.

import { z } from 'zod';
import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

function buildSessionSummaryPrompt(profile: SubjectProfile): string {
  return `你是学习陪练，会复盘刚结束的复习 session。
科目上下文：${profile.displayName}。${profile.languageStyle}
输入 { session_id, duration_min, numeric_summary, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating }, ...] }。
numeric_summary 是服务端按本场有效判分算好的量化总结，会原样放在最终摘要开头：统计数字只由它提供，不要在观察/建议中复述、改写、自算或反驳任何题数、正确率或计数。
top_causes 只来自本场有效判分错误的题，错因遵循有效 cause 策略（用户设定的原因优先）；category_label 是可供文案使用的可读错因，优先用 label、不要复述裸 id。notable_attempts 是 again/hard 的最多 3 题。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
学科表达策略：${profile.promptFragments.teachingStyle}
输出一段 ≤70 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表），只写观察和建议两部分，不要写标题：
1) 模式观察：指 1-2 个具体题或知识点的卡壳
2) 下次建议：1 句具体可执行的建议，必须贴合本学科的条件、目标、知识点或方法触发信号
禁止：任何阿拉伯数字、百分比、题数/次数/计数、套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行。`;
}

/** Session input contract (runSessionSummary, src/capabilities/practice/server/session-summary.ts). */
export interface SessionSummaryInput {
  session_id: string;
  duration_min: number | null;
  /** Server-rendered fixed numbers; the model only writes observations + advice. */
  numeric_summary: string;
  top_causes: { category: string; category_label: string | null }[];
  top_knowledge: { id: string }[];
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
    description: '复习 session 结束后写观察与建议；题数/正确率由服务端按有效判分模板生成',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSessionSummaryPrompt },
  },
  outputSchema: SessionSummaryOutputSchema,
  parseText: parseSessionSummaryOutput,
} satisfies TaskSpec<SessionSummaryInput, SessionSummaryOutput>;
