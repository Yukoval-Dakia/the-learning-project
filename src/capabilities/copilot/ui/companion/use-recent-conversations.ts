// The shell's 「最近」 list: newest conversations from GET /api/copilot/sessions. The companion writes
// its own fresh reads into the same cache entry, so the list follows new conversations at once.

import { useQuery } from '@tanstack/react-query';
import { type CopilotSessionsResponse, useCopilotClient } from '../copilot-client';

export const RECENT_CONVERSATIONS_KEY = ['copilot', 'sessions', 'recent'] as const;

export interface RecentConversation {
  id: string;
  /** summary_md when the server has one, else the date. */
  title: string;
  updatedAt: string;
  /** Can still be continued (active/idle); others are read-only history. */
  continuable: boolean;
}

export function conversationDateTitle(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '对话';
  return `对话 · ${date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function toRecentConversation(
  session: CopilotSessionsResponse['sessions'][number],
): RecentConversation {
  return {
    id: session.id,
    title: session.title?.trim() || conversationDateTitle(session.updated_at),
    updatedAt: session.updated_at,
    continuable: session.status === 'active' || session.status === 'idle',
  };
}

export interface RecentConversationsResult {
  conversations: RecentConversation[];
  isLoading: boolean;
  isError: boolean;
}

export function useRecentConversations(limit = 5): RecentConversationsResult {
  const client = useCopilotClient();
  const query = useQuery({
    queryKey: RECENT_CONVERSATIONS_KEY,
    queryFn: ({ signal }) => client.listSessions(signal),
    staleTime: 30_000,
  });
  return {
    conversations: (query.data?.sessions ?? []).slice(0, limit).map(toRecentConversation),
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
