// Client-only public contribution surface.
export { AgentNotesBoard } from './ui/AgentNotesBoard';
export { LearningIntentComposer } from './ui/LearningIntentComposer';
export type { AgentNotesResponse } from './ui/types';

export const loadAgentNotesPage = () => import('./ui/page').then((module) => module.default);
