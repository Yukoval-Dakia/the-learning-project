import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const runMock = vi.hoisted(() => vi.fn());

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/capabilities/copilot/server/chat', () => ({
  CopilotChatRequest: z.object({ message: z.string() }),
  runCopilotChatStreaming: runMock,
}));

import { POST } from '@/capabilities/copilot/api/chat';

const post = (body: unknown) =>
  POST(
    new Request('http://test/api/copilot/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    {},
  );

const readAll = (res: Response) => new Response(res.body).text();

describe('POST /api/copilot/chat — SSE via SSEStreamingApi', () => {
  it('delta 帧 FIFO 先于终态 reply 帧，framing 与旧栈逐字节一致', async () => {
    runMock.mockImplementation(async (_db, _req, onDelta) => {
      onDelta('你');
      onDelta('好');
      return { session_id: 's1', reply_event_id: 'e1' };
    });
    const res = await post({ message: 'hi' });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(await readAll(res)).toBe(
      'event: delta\ndata: {"text":"你"}\n\n' +
        'event: delta\ndata: {"text":"好"}\n\n' +
        'event: reply\ndata: {"session_id":"s1","reply_event_id":"e1"}\n\n',
    );
  });

  it('zod 解析失败 → JSON errorResponse，绝不开流', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type') ?? '').toContain('application/json');
  });

  it('runCopilotChatStreaming 抛错 → 固定 Internal Server Error，真实信息不出站', async () => {
    runMock.mockRejectedValue(new Error('db exploded: secret detail'));
    const res = await post({ message: 'hi' });
    const text = await readAll(res);
    expect(text).toBe('event: reply\ndata: {"error":"Internal Server Error"}\n\n');
    expect(text).not.toContain('secret detail');
  });
});
