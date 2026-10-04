// Stable server contract for consumers outside the copilot capability.

export type {
  GetRecentReviewEventsOpts,
  QuestionTimelineEntry,
  ReviewEvent,
} from '@/kernel/read-models/question-activity';
export {
  getQuestionAttemptOutcomeCounts,
  getQuestionTimeline,
  getRecentReviewEvents,
} from '@/kernel/read-models/question-activity';
// YUK-1007 — copilot 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { copilotConfigEffectiveFacts } from './server/config-effective-facts';
// Migration readiness checks consume this read-only port.
export { assertCopilotLegacyDrained } from './server/legacy-drain-readiness';
// YUK-892 — memory-brief reader for non-LLM read paths (today summary, demos).
export { MEMORY_BRIEF_STALE_AFTER_MS, executeMemoryBrief } from './server/tools/memory-brief';
