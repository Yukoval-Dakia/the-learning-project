// Client-only public contribution surface.
export { getWorkbenchSummary } from './ui/workbench-api';

export const loadTodayPage = () => import('./ui/TodayPage').then((module) => module.default);
export const loadInboxPage = () => import('./ui/InboxPage').then((module) => module.default);
export const loadCoachHub = () => import('./ui/CoachHub').then((module) => module.default);

export { ProposalPageResponseSchema } from './api/contracts';
export type { CoachCalibrationReader } from './ui/CoachCalibrationView';
export type { CoachWeeklyReader } from './ui/CoachHub';
export type { CoachEffectivenessReader } from './ui/EffectivenessTrendPanel';
export { proposalDecisionBody } from './ui/inbox-api';
export type { WorkbenchClient } from './ui/workbench-client';
export { WorkbenchClientProvider, useWorkbenchClient } from './ui/workbench-client';
