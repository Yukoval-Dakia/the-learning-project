// YUK-266 (C1) — wire-level SSE framing + reply-row landing for POST
// /api/copilot/chat.
//
// db partition: imports tests/helpers/db (real Postgres testcontainer). We mock
// ONLY the AI runner seam (streamTaskCollecting) so the SDK subprocess never
// spawns; the REAL runCopilotChatStreaming runs against the fork DB, so this test
// proves both the byte-level SSE framing the Dock parses (a `delta` line then a
// `reply` line whose JSON parses to a CopilotChatResult) AND that exactly one
// experimental:copilot_reply event row lands (the S3a persistence contract). The
// unit chat.test.ts covers the service routing; this is the wire-level smoke.

import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// Mock the runner's streaming primitive: stream one delta, resolve a clean result.
// No SDK subprocess; everything else in runCopilotChatStreaming hits the real DB.
vi.mock('@/server/ai/runner', async () => {
  const actual = await vi.importActual<typeof import('@/server/ai/runner')>('@/server/ai/runner');
  return {
    ...actual,
    streamTaskCollecting: vi.fn(
      async (_kind: string, _input: unknown, _ctx: unknown, onDelta: (t: string) => void) => {
        onDelta('OK');
        return {
          task_run_id: 'task_route_real',
          text: 'OK',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
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

async function readSse(res: Response): Promise<Array<{ event: string; data: string }>> {
  const raw = await res.text();
  return raw
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
}

describe('POST /api/copilot/chat — SSE framing + reply row (C1)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('streams a delta frame then a terminal reply frame and lands one copilot_reply row', async () => {
    const res = await POST(postRequest({ user_message: '你好', triggered_by: 'chat' }));

    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');

    const frames = await readSse(res);
    // First a delta, then a terminal reply carrying the CopilotChatResult.
    expect(frames[0]?.event).toBe('delta');
    expect(JSON.parse(frames[0]?.data ?? '{}')).toEqual({ text: 'OK' });

    const replyFrame = frames.find((f) => f.event === 'reply');
    expect(replyFrame).toBeDefined();
    const parsed = JSON.parse(replyFrame?.data ?? '{}') as {
      reply?: string;
      reply_event_id?: string;
      session_id?: string;
    };
    expect(parsed.reply).toBe('OK');
    expect(parsed.reply_event_id).toMatch(/^copilot_reply_/);

    // Exactly one copilot_reply event row landed, carrying the streamed text +
    // the real task_run_id from the (mocked) runner.
    const db = testDb();
    const replyRows = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:copilot_reply'));
    expect(replyRows).toHaveLength(1);
    const payload = replyRows[0]?.payload as { reply_md?: string; task_run_id?: string };
    expect(payload.reply_md).toBe('OK');
    expect(payload.task_run_id).toBe('task_route_real');
    expect(replyRows[0]?.task_run_id).toBe('task_route_real');
  });

  it('returns a non-streamed JSON error for a malformed body (Zod parse before stream)', async () => {
    const res = await POST(postRequest({ triggered_by: 'chat' })); // missing user_message
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
