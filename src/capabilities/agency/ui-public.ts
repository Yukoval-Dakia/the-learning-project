// Client-only public contribution surface.
export { AgentNotesResponseSchema } from './api/contracts';
export { AgentNotesBoard } from './ui/AgentNotesBoard';
export { type AgentNoteClient, AgentNoteClientProvider } from './ui/agent-note-client';
export { LearningIntentComposer } from './ui/LearningIntentComposer';
export type { AgentNotesResponse } from './ui/types';

export const loadAgentNotesPage = () => import('./ui/page').then((module) => module.default);
