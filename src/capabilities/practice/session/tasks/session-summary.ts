// SessionSummaryTask is Practice-owned. The output is plain text, not JSON; the
// runner's consumer (src/capabilities/practice/session/server/session-summary.ts)
// trims, clamps to 600 chars and requires non-empty.

import { z } from 'zod';
import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;
const SUMMARY_MAX_CHARS = 600;

function buildSessionSummaryPrompt(profile: SubjectProfile): string {
  return `你是学习陪练，会复盘刚结束的练习 session。
科目上下文：${profile.displayName}。${profile.languageStyle}
输入 { session_id, duration_min, numeric_summary, numeric_facts, process_signals, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating, duration_ms, self_confidence, hints_used, final_hint_level }, ...] }。
numeric_summary 是服务端按本场有效判分算好的量化总结，会原样放在最终摘要开头，你写的内容紧接在它后面，所以不要再复述本场总题数和总正确率；numeric_facts 是同一批真实数字（total_reviewed 总题数、graded 有效判分题数、correct/partial/incorrect 分布、correct_pct 正确率、duration_min 用时分钟、可空）。
process_signals 是本场的作答过程信号：timed_answers 有用时记录的题数、median_duration_ms 用时中位数、rushed_tail_answers 末尾连续用时不到中位数一半的题数（0 表示没有明显偏短）、low_confidence_answers 自评 1-2 分的题数、hinted_answers 用过提示的题数、max_hint_level 触达的最高提示档。
top_causes 只来自本场有效判分错误的题，count 是真实计数；category_label 是可供文案使用的可读错因，优先用 label、不要复述裸 id。top_knowledge 每项有 name（知识点名称）、count（本场引用次数）、incorrect（本场判错次数）。
notable_attempts 是判错或部分对的最多 3 题，带 duration_ms（用时毫秒）、self_confidence（1-5 自评）、hints_used / final_hint_level（提示使用）。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
学科表达策略：${profile.promptFragments.teachingStyle}
输出一段 ≤220 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表，不要写标题），包含三部分：
1) 错因归纳：点名错得最多的 1-2 个知识点（用 top_knowledge[].name），说清卡在哪一步，可以引用 top_causes 的 category_label 与 count；两个知识点以上时说明它们的共同模式
2) 过程观察：只在 process_signals 有数据时才写，例如「后两题用时明显偏短」「有两题自评很低但还是判错」「有一半题用了提示」；必须原样引用 numeric_facts / process_signals 里的真实数字，不自算、不约数、不补全
3) 下次建议：1 句具体可执行的建议，贴合本学科的条件、目标、知识点或方法触发信号；优先指向 top_knowledge 里 incorrect 最高的知识点
禁止：编造或估算 numeric_facts / process_signals 之外的计数、百分比、用时；套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行。`;
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
  /** Answer-process observations computed from the session's attempt payloads. */
  process_signals: {
    timed_answers: number;
    median_duration_ms: number | null;
    rushed_tail_answers: number;
    low_confidence_answers: number;
    hinted_answers: number;
    max_hint_level: number | null;
  };
  top_causes: { category: string; category_label: string | null; count: number }[];
  top_knowledge: { id: string; name: string; count: number; incorrect: number }[];
  notable_attempts: {
    prompt_md: string;
    user_response_md: string | null;
    fsrs_rating: string | null;
    duration_ms: number | null;
    self_confidence: number | null;
    hints_used: number | null;
    final_hint_level: number | null;
  }[];
}

/** Any non-empty text is shape-valid; the parser clamps to 600 instead of rejecting. */
export const SessionSummaryOutputSchema = z.string().min(1);
export type SessionSummaryOutput = z.infer<typeof SessionSummaryOutputSchema>;

/** Trim, clamp to 600, require non-empty (empty → runner reports skipped:no_events). */
export function parseSessionSummaryOutput(text: string): SessionSummaryOutput {
  return SessionSummaryOutputSchema.parse(text.trim().slice(0, SUMMARY_MAX_CHARS));
}

export const sessionSummaryTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SessionSummaryTask',
    description: '练习 session 结束后写错因、过程观察与下次建议；可引用服务端给出的本场真实计数',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1 },
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
