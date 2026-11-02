// Client-only public contribution surface.

export type { CopilotSkillContextT } from './server/chat-contracts';
export { CompanionMount } from './ui/companion/CompanionMount';
export type { CompanionLayout } from './ui/companion/CompanionPanel';
export {
  type CopilotCancelResult,
  type CopilotClient,
  CopilotClientProvider,
  type CopilotCreateSessionResponse,
  type CopilotSessionsResponse,
  type CopilotTurnsResponse,
  buildCopilotTurnsQuery,
  httpCopilotClient,
  useCopilotClient,
} from './ui/copilot-client';
