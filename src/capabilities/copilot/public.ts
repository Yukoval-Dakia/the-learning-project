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
// copilot 拥有配置键的 consumer-effective 事实（真实 reader 调用）：
// 组合根 facts seam 聚合进 GET /api/admin/config keys[].effective。
export { copilotConfigEffectiveFacts } from './server/config-effective-facts';
export { createCopilotSession, readCopilotSessions } from './server/conversation-requests';
export { loadCopilotSummary } from './server/copilot-summary';
export { dispatchSessionHead } from './server/durable-dispatch';
// Migration readiness checks consume this read-only port.
export { assertCopilotLegacyDrained } from './server/legacy-drain-readiness';
export { dismissCopilotNudge, markCopilotNudgeOpened } from './server/nudge-actions';
export { loadActiveNudges } from './server/nudge-read';
export { cancelCopilotRun } from './server/run-cancel-request';
// memory-brief reader for non-LLM read paths (today summary, demos).
export { MEMORY_BRIEF_STALE_AFTER_MS, executeMemoryBrief } from './server/tools/memory-brief';
export { readCopilotTurns } from './server/turns-request';

// task composition uses the narrow task-public entry directly.
export { copilotTaskSpecs } from './task-public';
