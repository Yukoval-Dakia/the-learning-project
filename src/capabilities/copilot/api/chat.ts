// POST /api/copilot/chat durably accepts every conversation turn.
// Disconnects after acceptance only detach the client; the worker owns execution.

import { requestCopilotChat } from '@/capabilities/copilot/server/chat-request';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

// kernel RouteHandler 双参签名（path 无参数段，_params 不用）。
export async function POST(req: Request, _params: Record<string, string>): Promise<Response> {
  try {
    const { status, body, headers } = await requestCopilotChat(db, {
      readBody: () => req.json(),
      idempotencyKey: req.headers.get('Idempotency-Key'),
      signal: req.signal,
    });
    return Response.json(body, { status, headers });
  } catch (err) {
    // enqueue 任一步失败 → 普通 JSON error，绝不开半截 SSE 流。
    return errorResponse(err);
  }
}
