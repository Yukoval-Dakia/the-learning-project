import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const runMock = vi.hoisted(() => vi.fn());
const writeUserAskMock = vi.hoisted(() => vi.fn());
const writeReplyMock = vi.hoisted(() => vi.fn());
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
    // YUK-364 (bot-review C3) — 镜像 skill_context（route 用它把 teaching turn 排除
    // 出 durable 面）；最小形态够触发分支即可。
    skill_context: z
      .object({
        skill: z.enum(['teaching', 'solve', 'quiz']),
        ref: z.object({ kind: z.string(), id: z.string() }),
      })
      .optional(),
  }),
  runCopilotChatStreaming: runMock,
  writeCopilotUserAsk: writeUserAskMock,
  writeCopilotReply: writeReplyMock,
}));
vi.mock('@/capabilities/copilot/server/copilot-run-status', () => ({
  COPILOT_RUN_TABLE: 'copilot_run',
  COPILOT_RUN_EVENTS: { QUEUED: 'copilot_run.queued', FAILED: 'copilot_run.failed' },
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
    // mockReset 清掉调用记录，让 invocationCallOrder happen-before 断言只看本用例。
    findOrCreateMock.mockReset().mockResolvedValue({ sessionId: 'sess_1', created: true });
    writeUserAskMock.mockReset().mockResolvedValue('copilot_user_ask_RID');
    writeJobEventMock.mockReset().mockResolvedValue(1);
    getStartedBossMock.mockReset().mockResolvedValue({ send: bossSendMock });
    bossSendMock.mockReset().mockResolvedValue('jobid');
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
    // 投递 durable job——session_id 透传进 job data（handler F1 写 reply 要用）。
    expect(bossSendMock).toHaveBeenCalledWith(
      'copilot_run',
      expect.objectContaining({
        run_id: 'copilot_user_ask_RID',
        session_id: 'sess_1',
        user_message: '讲讲这道题',
        triggered_by: 'chat',
      }),
    );
    // 同步 streaming 路径不被走。
    expect(runMock).not.toHaveBeenCalled();

    // YUK-364 (F5) — happen-before 顺序：user_ask（commit run handle）→ QUEUED 进度
    // 事件 → boss.send 投递。防未来重排成 boss.send 先于 user_ask 写入的 race
    // （worker 拾起一个 user_ask 还没 commit 的 run）。
    const askOrder = writeUserAskMock.mock.invocationCallOrder[0] as number;
    const queuedOrder = writeJobEventMock.mock.invocationCallOrder[0] as number;
    const sendOrder = bossSendMock.mock.invocationCallOrder[0] as number;
    expect(askOrder).toBeLessThan(queuedOrder);
    expect(queuedOrder).toBeLessThan(sendOrder);
  });

  it('F2 — boss.send throw（user_ask/QUEUED 已 commit）→ 补偿写 FAILED + reply error event，该轮不 phantom，返 500', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockResolvedValue({ sessionId: 'sess_F2', created: true });
    writeUserAskMock.mockReset().mockResolvedValue('copilot_user_ask_F2');
    writeJobEventMock.mockReset().mockResolvedValue(1);
    writeReplyMock.mockReset().mockResolvedValue({ replyEventId: 're_F2', cleanedReply: '' });
    getStartedBossMock.mockResolvedValue({ send: bossSendMock });
    bossSendMock.mockReset().mockRejectedValue(new Error('boss down'));
    runMock.mockClear();

    const res = await post({ user_message: '讲讲这道题', triggered_by: 'chat', durable: true });

    // 普通 JSON error（绝不开半截 SSE 流）。
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get('Content-Type') ?? '').toContain('application/json');

    // 补偿：FAILED job_event（status→failed 非卡死 queued）。
    expect(writeJobEventMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        business_table: 'copilot_run',
        business_id: 'copilot_user_ask_F2',
        event_type: 'copilot_run.failed',
        payload: expect.objectContaining({ reason: 'enqueue_failed' }),
      }),
    );
    // 补偿：copilot_reply error domain event（chained user_ask）让该轮不是 phantom。
    expect(writeReplyMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sessionId: 'sess_F2',
        userAskEventId: 'copilot_user_ask_F2',
        actorRef: 'agent:copilot',
      }),
    );
    // 同步 streaming 路径不被走。
    expect(runMock).not.toHaveBeenCalled();
  });

  it('F2 — findOrCreateConversation throw（user_ask 未写）→ 无补偿（无 phantom 风险），返 500', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockReset().mockRejectedValue(new Error('conv create failed'));
    writeUserAskMock.mockReset();
    writeReplyMock.mockReset();
    bossSendMock.mockReset();
    runMock.mockClear();

    const res = await post({ user_message: 'hi', triggered_by: 'chat', durable: true });

    expect(res.status).toBeGreaterThanOrEqual(500);
    // user_ask 没写 → 无 phantom → 不补偿（runId 未知，守卫不进补偿块）。
    expect(writeUserAskMock).not.toHaveBeenCalled();
    expect(writeReplyMock).not.toHaveBeenCalled();
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

  it('C3 — durable:true 但带 skill_context（teaching）→ 降级回 inline（teaching 短路不入 durable 面）', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    bossSendMock.mockClear();
    runMock.mockClear();
    runMock.mockImplementation(async () => ({ session_id: 's1', reply_event_id: 'e1' }));

    const res = await post({
      user_message: '讲讲这道题',
      triggered_by: 'chat',
      durable: true,
      skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_1' } },
    });
    // teaching turn 留 inline：SSE 流，不 enqueue durable job（否则丢结构化协议）。
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });
});
