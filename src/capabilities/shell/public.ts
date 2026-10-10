// YUK-885 — public port repointed from a central deep import.
export type {
  WorkbenchHeatDay,
  WorkbenchSessionRow,
  WorkbenchSummary,
} from './server/workbench-summary';

type LoadWorkbenchSummary = typeof import('./server/workbench-summary').loadWorkbenchSummary;
export const loadWorkbenchSummary: LoadWorkbenchSummary = async (...args) => {
  const workbench = await import('./server/workbench-summary');
  return workbench.loadWorkbenchSummary(...args);
};

export { loadOvernightDigest } from './server/overnight-digest';

export { loadPrepDeskConjectures } from './server/prep-desk';
export { type ProposalInboxQuery, readProposalInbox } from './server/proposal-inbox-read';
export { isCandidateError, validateAckableOutcome } from './server/teaching-brief';
export type {
  BriefSeenPayload,
  PrimaryActionStartedPayload,
} from './server/teaching-brief-interactions';
