import type { SubjectProfile } from '@/subjects/profile';
import { causeTaxonomyList } from './cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskDefinition } from './task-spec';

// ADR-0031 / YUK-304 (lane B) — buildQuizIntentParsePrompt deleted with
// QuizIntentParseTask (the YUK-275 C-form free-text 求卷 parser): chat.ts no
// longer pre-dispatches quiz intents; the copilot model decides + orchestrates.

// YUK-358 决定3：buildEmbeddedCheckGeneratePrompt 已删（内嵌判分自测孤儿链真删）。

// Lane D (YUK-482): buildKnowledgeProposePrompt removed alongside KnowledgeProposeTask
// (answer-wrong → propose-new-KC coupling). Content-driven KC creation does not use it.

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

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

// 模型选型规则（与 architecture § 五 对齐）：
//   - Sonnet 主力（归因 / 变式 / 判分）
//   - Haiku 廉价兜底（视觉 OCR-like / 备选）
//   - Opus 顶级 reasoning（ai_flexible / multimodal / weekly review）
//

export const legacyTaskDefinitions = {
  // Lane D (YUK-482): KnowledgeProposeTask was removed. It existed solely for the
  // answer-wrong → propose-new-KC coupling (failure attempt → propose a more
  // precise child node). KC creation is a CONTENT-axis action, independent of
  // answer correctness; the surviving content-driven KC paths use applyProposeNew /
  // writeKnowledgeProposeEvent directly (cold-start-bridge / image-candidate-accept
  // matcher / agent proposal-tools) and the maintenance producer KnowledgeReviewTask.
  // YUK-349 B3 PR-2 — empty-frontier prerequisite bootstrap. Unlike the
  // failure-driven KnowledgeEdgeProposeTask above (cross-attempt pattern mining),
  // this is CURRICULUM-driven: given the tree + the KCs lacking prerequisite
  // coverage, propose up to 5 TEMPORARY prerequisite edges from genuine
  // curriculum dependency. PROPOSE-ONLY / low-confidence — the nightly handler
  // writes a `propose` event (NEVER a live knowledge_edge row), the owner accepts
  // in the inbox, real edges replace the temps. Fires only when learnableFrontier
  // is empty (cold-start bootstrap, ADR-0037 #4).
  SessionSummaryTask: {
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
  // YUK-358 决定3：EmbeddedCheckGenerateTask 已删（内嵌判分自测孤儿链真删）。
  // 其余 Task（VariantGen / Judge* / Dreaming / Maintenance 等）见
  // docs/architecture.md § 五，按需补全。
} satisfies Record<string, TaskDefinition>;
