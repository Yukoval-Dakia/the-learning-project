// Client-only public contribution surface.
export { AgentNotesResponseSchema } from './api/contracts';
export { AgentNotesBoard } from './ui/AgentNotesBoard';
export {
  type AgentNoteClient,
  AgentNoteClientProvider,
  httpAgentNoteClient,
} from './ui/agent-note-client';
export { LearningIntentComposer } from './ui/LearningIntentComposer';
export type LearningIntentProposalClient =
  typeof import('./ui/learning-intent-api').createLearningIntentProposal;
export type { AgentNotesResponse } from './ui/types';

export const loadAgentNotesPage = () => import('./ui/page').then((module) => module.default);
