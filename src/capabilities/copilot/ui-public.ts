// Client-only public contribution surface.

export type { CopilotSkillContextT } from './server/chat-contracts';
export { CompanionMount, type CompanionMountProps } from './ui/companion/CompanionMount';
export type { CompanionLayout } from './ui/companion/CompanionPanel';
export {
  type RecentConversation,
  type RecentConversationsResult,
  useRecentConversations,
} from './ui/companion/use-recent-conversations';
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
