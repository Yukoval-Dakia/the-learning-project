export { AiNoticeDismissBodySchema, TeachingBriefAckBodySchema } from './api/contracts';
export type {
  WorkbenchHeatDay,
  WorkbenchSessionRow,
  WorkbenchSummary,
  WorkbenchSummaryParts,
} from './server/workbench-summary';

type LoadWorkbenchSummary = typeof import('./server/workbench-summary').loadWorkbenchSummary;
export const loadWorkbenchSummary: LoadWorkbenchSummary = async (...args) => {
  const workbench = await import('./server/workbench-summary');
  return workbench.loadWorkbenchSummary(...args);
};

export { getAutoAppliedDigest } from './server/auto-applied-read';
export { listProposalBatchAccepts } from './server/batch-accepts-read';
export { loadPrepDeskConjectures } from './server/prep-desk';
export { loadActiveProbes } from './server/prep-desk-probes';
export { type ProposalInboxQuery, readProposalInbox } from './server/proposal-inbox-read';
export { type LearnerSubjectRow, loadLearnerSubjects } from './server/subjects-list';
export {
  isCandidateError,
  loadTeachingBrief,
  validateAckableOutcome,
} from './server/teaching-brief';
export { acknowledgeTeachingBriefOutcome } from './server/teaching-brief-ack';
export type {
  BriefSeenPayload,
  PrimaryActionStartedPayload,
} from './server/teaching-brief-interactions';

export const listDismissedAiNotices: typeof import('./server/ai-notice-dismissals').listDismissedAiNotices =
  async (...args) =>
    (await import('./server/ai-notice-dismissals')).listDismissedAiNotices(...args);
export const dismissAiNotices: typeof import('./server/ai-notice-dismissals').dismissAiNotices =
  async (...args) => (await import('./server/ai-notice-dismissals')).dismissAiNotices(...args);
