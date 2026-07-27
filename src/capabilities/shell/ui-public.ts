// Client-only public contribution surface.
export { getWorkbenchSummary } from './ui/workbench-api';

export const loadTodayPage = () => import('./ui/TodayPage').then((module) => module.default);
export const loadInboxPage = () => import('./ui/InboxPage').then((module) => module.default);
export const loadCoachHub = () => import('./ui/CoachHub').then((module) => module.default);
