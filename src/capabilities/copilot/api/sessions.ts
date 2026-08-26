import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { createCopilotConversation, listCopilotConversations } from '@/server/session/conversation';

export async function GET(): Promise<Response> {
  try {
    const sessions = await listCopilotConversations(db);
    return Response.json({ sessions });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(): Promise<Response> {
  try {
    const { session } = await createCopilotConversation(db);
    return Response.json({ session }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
