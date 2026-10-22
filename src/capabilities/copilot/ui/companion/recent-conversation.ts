// One row of 对话记录: a server session reduced to what the list shows.

import type { CopilotSessionsResponse } from '../copilot-client';

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
