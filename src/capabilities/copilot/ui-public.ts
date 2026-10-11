// Client-only public contribution surface.

export type { CopilotSkillContextT } from './server/chat-contracts';
export { CopilotDock } from './ui/CopilotDock';
export {
  type CopilotCancelResult,
  type CopilotClient,
  CopilotClientProvider,
  type CopilotCreateSessionResponse,
  type CopilotSessionsResponse,
  type CopilotTurnsResponse,
  httpCopilotClient,
  useCopilotClient,
} from './ui/copilot-client';
