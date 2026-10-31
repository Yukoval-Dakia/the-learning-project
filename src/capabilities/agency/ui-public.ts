// Client-only public contribution surface.
export { AgentNotesResponseSchema } from './api/contracts';
export type { AgentNotesBoardProps } from './ui/AgentNotesBoard';
export { AgentNotesBoard } from './ui/AgentNotesBoard';
export {
  type AgentNoteClient,
  AgentNoteClientProvider,
  httpAgentNoteClient,
  useAgentNoteClient,
} from './ui/agent-note-client';
export type { LearningIntentComposerProps } from './ui/LearningIntentComposer';
export { LearningIntentComposer } from './ui/LearningIntentComposer';
export type { AgentNotesResponse } from './ui/types';

export const loadAgentNotesPage = () => import('./ui/page').then((module) => module.default);
