// Wave 5 / T-D3/C — POST /api/copilot/chat
//
// Single endpoint that handles both surfaces ('chat' default | 'chip' direct
// trigger) via `triggered_by` field. See src/server/copilot/chat.ts for the
// two-surface routing contract.
//
// YUK-266 (C1) — the POST now streams over SSE (text/event-stream). Two event
// names:
//   • event: delta — data: {"text":"<chunk>"} — one per assistant-message chunk.
//   • event: reply — data: <CopilotChatResult JSON> — the terminal event, the
//     exact shape the non-streaming path returned (session_id / reply_event_id /
//     skill_turn). The Dock keeps its structured-turn rendering unchanged.
// Streaming failure degrades gracefully: runCopilotChatStreaming persists whatever
// text was collected and resolves a CopilotChatResult (with an optional `error`
// note), so a turn is never lost — the route still emits a terminal `reply` event.
// Zod parse errors happen BEFORE the stream is constructed and fall back to the
// existing errorResponse (NOT streamed).

import { db } from '@/db/client';
import { CopilotChatRequest, runCopilotChatStreaming } from '@/server/copilot/chat';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

// SSE framing helper: `event: <name>\ndata: <json>\n\n`.
function encodeSse(name: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function POST(req: Request): Promise<Response> {
  // Parse BEFORE constructing the stream so a bad body returns a normal JSON
  // error (the existing contract) instead of a half-open SSE stream.
  let parsed: ReturnType<typeof CopilotChatRequest.parse>;
  try {
    const body = await req.json();
    parsed = CopilotChatRequest.parse(body);
  } catch (err) {
    return errorResponse(err);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await runCopilotChatStreaming(
          db,
          parsed,
          (text) => controller.enqueue(encodeSse('delta', { text })),
          {},
          req.signal,
        );
        controller.enqueue(encodeSse('reply', result));
      } catch (err) {
        // runCopilotChatStreaming degrades internally and resolves rather than
        // throwing; this catch is the last-resort guard (e.g. the conversation
        // envelope resolve threw before any reply could be built). Emit a terminal
        // `reply` event so the Dock shows its error affordance.
        //
        // YUK-266 — match errorResponse's sanitization contract (src/server/http/
        // errors.ts): unhandled errors can carry DB/internal detail, so log the
        // real message + stack server-side and emit a FIXED generic string to the
        // client instead of raw err.message.
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error('[copilot/chat] unhandled streaming error', {
          message,
          stack,
          timestamp: new Date().toISOString(),
        });
        controller.enqueue(encodeSse('reply', { error: 'Internal Server Error' }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
