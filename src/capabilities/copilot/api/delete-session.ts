import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { requestCopilotConversationDeletion } from '../server/conversation-lifecycle';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await requestCopilotConversationDeletion(db, params.id));
  } catch (err) {
    return errorResponse(err);
  }
}
