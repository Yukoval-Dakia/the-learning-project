import type { Db } from '@/db/client';
import { CopilotTurnsQuerySchema } from '../api/contracts';
import { getCopilotConversationSnapshot } from './turns';

export async function readCopilotTurns(db: Db, params: URLSearchParams) {
  const raw = params.get('limit');
  const query = CopilotTurnsQuerySchema.parse({
    limit: raw ?? undefined,
    session_id: params.get('session_id') ?? undefined,
  });
  const limit = query.limit === undefined ? undefined : Number.parseInt(query.limit, 10);
  return getCopilotConversationSnapshot(db, {
    limit,
    sessionId: query.session_id,
  });
}
