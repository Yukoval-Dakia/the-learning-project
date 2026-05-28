// Wave 5 / T-D3/C — POST /api/copilot/chat
//
// Single endpoint that handles both surfaces ('chat' default | 'chip' direct
// trigger) via `triggered_by` field. See src/server/copilot/chat.ts for the
// two-surface routing contract.

import { db } from '@/db/client';
import { CopilotChatRequest, runCopilotChat } from '@/server/copilot/chat';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const parsed = CopilotChatRequest.parse(body);
    const result = await runCopilotChat(db, parsed);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
