// YUK-266 (C1) — wire-level SSE framing smoke for POST /api/copilot/chat.
//
// db partition: the route imports `@/db/client` (a real DB surface), so this file
// is correctly classified into the db partition (NOT fastTestInclude). We mock the
// chat service (`runCopilotChatStreaming`) so the SDK never runs — the unit
// chat.test.ts already proves the service contract; this test proves ONLY the
// byte-level SSE framing the Dock parses (a `delta` line then a `reply` line whose
// JSON parses to a CopilotChatResult), plus the Zod-parse error fallback.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatMocks = vi.hoisted(() => ({
  // Default: stream one delta, resolve a full result.
  impl: async (
    _db: unknown,
    _req: unknown,
    onDelta: (t: string) => void,
  ): Promise<Record<string, unknown>> => {
    onDelta('OK');
    return {
      task_run_id: 'task_real',
      reply: 'OK',
      surface: 'copilot',
      triggered_by: 'chat',
      session_id: 'ls_route',
      reply_event_id: 'copilot_reply_route',
    };
  },
}));

vi.mock('@/server/copilot/chat', async () => {
  const actual =
    await vi.importActual<typeof import('@/server/copilot/chat')>('@/server/copilot/chat');
  return {
    ...actual,
    runCopilotChatStreaming: vi.fn((db: unknown, req: unknown, onDelta: (t: string) => void) =>
      chatMocks.impl(db, req, onDelta),
    ),
  };
});

import { POST } from './route';

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/copilot/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readSse(
  res: Response,
): Promise<{ raw: string; frames: Array<{ event: string; data: string }> }> {
  const raw = await res.text();
  const frames = raw
    .split('\n\n')
    .filter((f) => f.trim().length > 0)
    .map((f) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of f.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      return { event, data: data.join('\n') };
    });
  return { raw, frames };
}

describe('POST /api/copilot/chat — SSE framing (C1)', () => {
  beforeEach(() => {
    chatMocks.impl = async (_db, _req, onDelta) => {
      onDelta('OK');
      return {
        task_run_id: 'task_real',
        reply: 'OK',
        surface: 'copilot',
        triggered_by: 'chat',
        session_id: 'ls_route',
        reply_event_id: 'copilot_reply_route',
      };
    };
  });

  it('streams a delta frame then a terminal reply frame carrying the CopilotChatResult', async () => {
    const res = await POST(postRequest({ user_message: '你好', triggered_by: 'chat' }));

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');

    const { frames } = await readSse(res);
    // First a delta, then the terminal reply.
    expect(frames[0]?.event).toBe('delta');
    expect(JSON.parse(frames[0]?.data ?? '{}')).toEqual({ text: 'OK' });

    const replyFrame = frames.find((f) => f.event === 'reply');
    expect(replyFrame).toBeDefined();
    const parsed = JSON.parse(replyFrame?.data ?? '{}') as {
      reply?: string;
      reply_event_id?: string;
    };
    expect(parsed.reply).toBe('OK');
    expect(parsed.reply_event_id).toBe('copilot_reply_route');
  });

  it('emits a terminal reply frame with an error when the service throws (last-resort guard)', async () => {
    chatMocks.impl = async () => {
      throw new Error('envelope resolve failed');
    };
    const res = await POST(postRequest({ user_message: '你好', triggered_by: 'chat' }));
    const { frames } = await readSse(res);
    const replyFrame = frames.find((f) => f.event === 'reply');
    expect(replyFrame).toBeDefined();
    const parsed = JSON.parse(replyFrame?.data ?? '{}') as { error?: string };
    expect(parsed.error).toContain('envelope resolve failed');
  });

  it('returns a non-streamed JSON error for a malformed body (Zod parse before stream)', async () => {
    const res = await POST(postRequest({ triggered_by: 'chat' })); // missing user_message
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
