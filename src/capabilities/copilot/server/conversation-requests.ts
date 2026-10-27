import { DerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db } from '@/db/client';
import { createCopilotConversation, listCopilotConversations } from '@/server/session/conversation';

export async function readCopilotSessions(db: Db) {
  const sessions = await listCopilotConversations(db);
  return {
    body: {
      sessions,
      server_time: new Date().toISOString(),
      supported_derivation_policies: DerivationPolicy.options,
    },
    headers: { 'Cache-Control': 'no-store' },
  };
}

export async function createCopilotSession(db: Db) {
  const { session } = await createCopilotConversation(db);
  return { body: { session }, status: 201 as const };
}
