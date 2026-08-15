import type { TaskDefinition } from './task-spec';

// ADR-0031 / YUK-304 (lane B) — buildQuizIntentParsePrompt deleted with
// QuizIntentParseTask (the YUK-275 C-form free-text 求卷 parser): chat.ts no
// longer pre-dispatches quiz intents; the copilot model decides + orchestrates.

// YUK-358 决定3：buildEmbeddedCheckGeneratePrompt 已删（内嵌判分自测孤儿链真删）。

// Lane D (YUK-482): buildKnowledgeProposePrompt removed alongside KnowledgeProposeTask
// (answer-wrong → propose-new-KC coupling). Content-driven KC creation does not use it.

// 模型选型规则（与 architecture § 五 对齐）：
//   - Sonnet 主力（归因 / 变式 / 判分）
//   - Haiku 廉价兜底（视觉 OCR-like / 备选）
//   - Opus 顶级 reasoning（ai_flexible / multimodal / weekly review）
//

// YUK-870 (F3.5b) — the quarry is EMPTY: the last transitional entry
// (SessionSummaryTask) is now a full Practice-owned TaskSpec. The empty map and
// the defineTransitionalTask machinery stay until the quarry deletion (YUK-885).
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
  // YUK-358 决定3：EmbeddedCheckGenerateTask 已删（内嵌判分自测孤儿链真删）。
  // 其余 Task（VariantGen / Judge* / Dreaming / Maintenance 等）见
  // docs/architecture.md § 五，按需补全。
} satisfies Record<string, TaskDefinition>;
