// YUK-870 (F3.5b) — SessionSummaryTask is Practice-owned.
//
// Moved verbatim from the since-deleted src/ai/legacy-task-definitions.ts quarry (prompt builder +
// definition; the prompt text is byte-identical so the task-prompt-hash oracle
// pins the move). The output is a plain-text ≤120-char summary — NOT JSON — so
// the owned output contract mirrors the summary runner's consumer
// (src/server/session/summary.ts): trim, clamp to 240 chars, require non-empty.
// This was the LAST transitional quarry entry; with it owned, the central
// semantic quarry holds zero entries (quarry deletion is YUK-885).

import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';

// Legacy quarry alias preserved verbatim inside the moved definitions.
const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

function buildSessionSummaryPrompt(profile: SubjectProfile): string {
  return `你是学习陪练，会复盘刚结束的复习 session。
科目上下文：${profile.displayName}。${profile.languageStyle}
输入 { session_id, duration_min, total_reviewed, ratings: { again, hard, good, easy }, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating }, ...] } —— ratings 是 FSRS 评分分布，top_causes 来自 effective cause（active user_cause 优先，否则 latest active judge），notable_attempts 是 again/hard 的最多 3 题。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
学科表达策略：${profile.promptFragments.teachingStyle}
输出一段 ≤120 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表）。三段意图：
1) 量化总结：「X 题，Y% 正确，主要错在 Z」
2) 模式观察：指 1-2 个具体题或知识点的卡壳
3) 下次建议：1 句具体可执行的建议，必须贴合本学科的条件、目标、知识点或方法触发信号
禁止：套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行、不超过 120 字。`;
}

/** Session input contract (runSessionSummary, src/server/session/summary.ts). */
export interface SessionSummaryInput {
  session_id: string;
  duration_min: number | null;
  total_reviewed: number;
  ratings: { again: number; hard: number; good: number; easy: number };
  top_causes: { category: string; count: number }[];
  top_knowledge: { id: string; count: number }[];
  notable_attempts: {
    prompt_md: string;
    user_response_md: string | null;
    fsrs_rating: string | null;
  }[];
}

/**
 * Plain-text summary — any non-empty text is shape-valid; the 240-char soft cap
 * lives in the parser (the prompt asks for ≤120 but the runner clamps instead
 * of rejecting so an occasional overshoot doesn't lose the summary).
 */
export const SessionSummaryOutputSchema = z.string().min(1);
export type SessionSummaryOutput = z.infer<typeof SessionSummaryOutputSchema>;

/**
 * Mirrors the summary runner consumer exactly: trim, clamp to 240 chars,
 * require non-empty (empty → the runner reports skipped:no_events).
 */
export function parseSessionSummaryOutput(text: string): SessionSummaryOutput {
  return SessionSummaryOutputSchema.parse(text.trim().slice(0, 240));
}

export const sessionSummaryTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SessionSummaryTask',
    description: '复习 session 结束后生成 ≤120 字短结：今天哪几题、哪个 cause 多、给 1 句下次建议',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // mimo-v2.5-pro 比 Anthropic haiku 慢，60s 给点余量
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildSessionSummaryPrompt },
  },
  outputSchema: SessionSummaryOutputSchema,
  parseText: parseSessionSummaryOutput,
} satisfies TaskSpec<SessionSummaryInput, SessionSummaryOutput>;
