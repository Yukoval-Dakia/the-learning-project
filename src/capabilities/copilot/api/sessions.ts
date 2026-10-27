import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { createCopilotSession, readCopilotSessions } from '../server/conversation-requests';

export async function GET(): Promise<Response> {
  try {
    const result = await readCopilotSessions(db);
    return Response.json(result.body, { headers: result.headers });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(): Promise<Response> {
  try {
    const result = await createCopilotSession(db);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err);
  }
}
