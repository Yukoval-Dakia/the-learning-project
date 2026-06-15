import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const runMock = vi.hoisted(() => vi.fn());
const writeUserAskMock = vi.hoisted(() => vi.fn());
const bossSendMock = vi.hoisted(() => vi.fn());
const getStartedBossMock = vi.hoisted(() => vi.fn());
const findOrCreateMock = vi.hoisted(() => vi.fn());
const writeJobEventMock = vi.hoisted(() => vi.fn());
const shouldEnqueueMock = vi.hoisted(() => vi.fn());

vi.mock('@/db/client', () => ({ db: {} }));
// YUK-364 — schema 镜像真实形态的关键字段（durable / triggered_by / user_message），
// 让 durable 分支可被触发；其余字段省略（route 只读这几个）。
vi.mock('@/capabilities/copilot/server/chat', () => ({
  CopilotChatRequest: z.object({
    user_message: z.string(),
    triggered_by: z.enum(['chat', 'chip']),
    chip_kind: z.string().optional(),
    durable: z.boolean().optional(),
  }),
  runCopilotChatStreaming: runMock,
  writeCopilotUserAsk: writeUserAskMock,
}));
vi.mock('@/capabilities/copilot/server/copilot-run-status', () => ({
  COPILOT_RUN_TABLE: 'copilot_run',
  COPILOT_RUN_EVENTS: { QUEUED: 'copilot_run.queued' },
}));
vi.mock('@/server/boss/client', () => ({ getStartedBoss: getStartedBossMock }));
vi.mock('@/server/events/writer', () => ({ writeJobEvent: writeJobEventMock }));
vi.mock('@/server/runtime-env', () => ({ shouldEnqueueBackgroundJobs: shouldEnqueueMock }));
vi.mock('@/server/session', () => ({
  Conversation: { findOrCreateCopilotConversation: findOrCreateMock },
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
    shouldEnqueueMock.mockReturnValue(false);
    runMock.mockImplementation(async (_db, _req, onDelta) => {
      onDelta('你');
      onDelta('好');
      return { session_id: 's1', reply_event_id: 'e1' };
    });
    const res = await post({ user_message: 'hi', triggered_by: 'chat' });
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
    shouldEnqueueMock.mockReturnValue(false);
    runMock.mockRejectedValue(new Error('db exploded: secret detail'));
    const res = await post({ user_message: 'hi', triggered_by: 'chat' });
    const text = await readAll(res);
    expect(text).toBe('event: reply\ndata: {"error":"Internal Server Error"}\n\n');
    expect(text).not.toContain('secret detail');
  });
});

// YUK-364 — durable 分流。
describe('POST /api/copilot/chat — durable dispatch (YUK-364)', () => {
  it('durable:true + chat + enqueue-enabled → 202 JSON { run_id }，boss.send(copilot_run)，不开 SSE 流', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockResolvedValue({ sessionId: 'sess_1', created: true });
    writeUserAskMock.mockResolvedValue('copilot_user_ask_RID');
    writeJobEventMock.mockResolvedValue(1);
    getStartedBossMock.mockResolvedValue({ send: bossSendMock });
    bossSendMock.mockResolvedValue('jobid');
    runMock.mockClear();

    const res = await post({ user_message: '讲讲这道题', triggered_by: 'chat', durable: true });

    expect(res.status).toBe(202);
    expect(res.headers.get('Content-Type') ?? '').toContain('application/json');
    expect(await res.json()).toEqual({ run_id: 'copilot_user_ask_RID', session_id: 'sess_1' });
    // user_ask 写入 = run handle。
    expect(writeUserAskMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sessionId: 'sess_1', userMessage: '讲讲这道题' }),
    );
    // queued 初态事件。
    expect(writeJobEventMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        business_table: 'copilot_run',
        business_id: 'copilot_user_ask_RID',
        event_type: 'copilot_run.queued',
      }),
    );
    // 投递 durable job。
    expect(bossSendMock).toHaveBeenCalledWith(
      'copilot_run',
      expect.objectContaining({
        run_id: 'copilot_user_ask_RID',
        user_message: '讲讲这道题',
        triggered_by: 'chat',
      }),
    );
    // 同步 streaming 路径不被走。
    expect(runMock).not.toHaveBeenCalled();
  });

  it('durable:true 但 enqueue-disabled（测试环境）→ 降级回 inline SSE，不 enqueue', async () => {
    shouldEnqueueMock.mockReturnValue(false);
    bossSendMock.mockClear();
    runMock.mockClear();
    runMock.mockImplementation(async () => ({ session_id: 's1', reply_event_id: 'e1' }));

    const res = await post({ user_message: 'hi', triggered_by: 'chat', durable: true });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });

  it('durable:true 但 triggered_by=chip → 降级回 inline（chip 不入 durable 面）', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    bossSendMock.mockClear();
    runMock.mockClear();
    runMock.mockImplementation(async () => ({ session_id: 's1', reply_event_id: 'e1' }));

    const res = await post({ user_message: 'hi', triggered_by: 'chip', durable: true });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });

  it('durable absent → 同步 SSE 路径 byte-identical（零回归）', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    bossSendMock.mockClear();
    runMock.mockClear();
    runMock.mockImplementation(async () => ({ session_id: 's1', reply_event_id: 'e1' }));

    const res = await post({ user_message: 'hi', triggered_by: 'chat' });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });
});
