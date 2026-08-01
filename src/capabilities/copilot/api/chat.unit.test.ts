import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const runMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const writeUserAskMock = vi.hoisted(() => vi.fn());
const writeReplyMock = vi.hoisted(() => vi.fn());
const bossSendMock = vi.hoisted(() => vi.fn());
const getStartedBossMock = vi.hoisted(() => vi.fn());
const findOrCreateMock = vi.hoisted(() => vi.fn());
const writeJobEventMock = vi.hoisted(() => vi.fn());
const shouldEnqueueMock = vi.hoisted(() => vi.fn());
const dbExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('@/db/client', () => ({ db: { execute: dbExecuteMock } }));
// YUK-364 — schema 镜像真实形态的关键字段（durable / triggered_by / user_message），
// 让 durable 分支可被触发；其余字段省略（route 只读这几个）。
vi.mock('@/capabilities/copilot/server/chat', () => ({
  CopilotChatRequest: z.object({
    user_message: z.string(),
    triggered_by: z.enum(['chat', 'chip']),
    chip_kind: z.string().optional(),
    durable: z.boolean().optional(),
    ambient_context: z
      .object({
        route: z.string(),
        focused_entity: z.object({ kind: z.string(), id: z.string() }).optional(),
      })
      .optional(),
    // YUK-364 (bot-review C3) — 镜像 skill_context（route 用它把 teaching turn 排除
    // 出 durable 面）；最小形态够触发分支即可。
    skill_context: z
      .object({
        skill: z.enum(['teaching', 'solve', 'quiz']),
        ref: z.object({ kind: z.string(), id: z.string() }),
      })
      .optional(),
  }),
  decideCopilotDispatch: dispatchMock,
  runCopilotChatStreaming: runMock,
  writeCopilotUserAsk: writeUserAskMock,
  writeCopilotReply: writeReplyMock,
}));
vi.mock('@/capabilities/copilot/server/copilot-run-status', () => ({
  COPILOT_RUN_TABLE: 'copilot_run',
  COPILOT_RUN_EVENTS: {
    QUEUED: 'copilot_run.queued',
    DONE: 'copilot_run.done',
    FAILED: 'copilot_run.failed',
  },
}));
vi.mock('@/server/boss/client', () => ({ getStartedBoss: getStartedBossMock }));
vi.mock('@/server/events/writer', () => ({ writeJobEvent: writeJobEventMock }));
vi.mock('@/server/runtime-env', () => ({ shouldEnqueueBackgroundJobs: shouldEnqueueMock }));
vi.mock('@/server/session', () => ({
  Conversation: { findOrCreateCopilotConversation: findOrCreateMock },
}));

import { POST } from '@/capabilities/copilot/api/chat';
import { CopilotDurableRunResponseSchema } from '@/capabilities/copilot/api/contracts';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';

const post = (body: unknown) =>
  POST(
    new Request('http://test/api/copilot/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    {},
  );

const readAll = (res: Response) => new Response(res.body).text();

beforeEach(() => {
  __resetRateLimitForTests();
  dbExecuteMock.mockReset().mockResolvedValue([{ count: 0 }]);
  dispatchMock.mockReset().mockResolvedValue({
    mode: 'inline',
    reason: 'bounded_answer',
    source: 'model_triage',
    task_run_id: 'copilot_dispatch_default_inline',
  });
});

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

  it('YUK-757 — inline 子任务帧与 Copilot delta 共用 FIFO，且只出白名单字段', async () => {
    shouldEnqueueMock.mockReturnValue(false);
    runMock.mockImplementation(async (_db, _req, onDelta, deps) => {
      await deps.onSubtaskEvent({
        step_kind: 'subtask',
        subtask_id: 'task-cross-artifacts-55',
        label: '核对三份函数讲义、四道错题与知识图谱先修关系',
        status: 'running',
      });
      onDelta('我正在核对这些证据。');
      await deps.onSubtaskEvent({
        step_kind: 'subtask',
        subtask_id: 'task-question-preview-12',
        label: '预览含参数函数辨析题并检查退化分支',
        status: 'running',
      });
      await deps.onSubtaskEvent({
        step_kind: 'subtask',
        subtask_id: 'task-cross-artifacts-55',
        label: '子任务已完成',
        status: 'completed',
      });
      onDelta('结论：驻点之后仍要检查导数是否变号。');
      return { session_id: 's-subtasks', reply_event_id: 'e-subtasks' };
    });

    const res = await post({
      user_message: '交叉核对我的材料，再预览一道能区分驻点与极值点的题。',
      triggered_by: 'chat',
    });
    const text = await readAll(res);
    expect(text).toBe(
      'event: subtask\n' +
        'data: {"step_kind":"subtask","subtask_id":"task-cross-artifacts-55","label":"核对三份函数讲义、四道错题与知识图谱先修关系","status":"running"}\n\n' +
        'event: delta\n' +
        'data: {"text":"我正在核对这些证据。"}\n\n' +
        'event: subtask\n' +
        'data: {"step_kind":"subtask","subtask_id":"task-question-preview-12","label":"预览含参数函数辨析题并检查退化分支","status":"running"}\n\n' +
        'event: subtask\n' +
        'data: {"step_kind":"subtask","subtask_id":"task-cross-artifacts-55","label":"子任务已完成","status":"completed"}\n\n' +
        'event: delta\n' +
        'data: {"text":"结论：驻点之后仍要检查导数是否变号。"}\n\n' +
        'event: reply\n' +
        'data: {"session_id":"s-subtasks","reply_event_id":"e-subtasks"}\n\n',
    );
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('reasoning');
    expect(text).not.toContain('transcript');
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
  it('YUK-693 — outstanding backlog at cap returns 429 before writing or enqueueing', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    dbExecuteMock.mockResolvedValue([{ count: 5 }]);
    findOrCreateMock.mockReset();
    writeUserAskMock.mockReset();
    writeJobEventMock.mockReset();
    bossSendMock.mockReset();

    const res = await post({ user_message: '再排一个任务', triggered_by: 'chat', durable: true });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(findOrCreateMock).not.toHaveBeenCalled();
    expect(writeUserAskMock).not.toHaveBeenCalled();
    expect(writeJobEventMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
  });

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
    expect(res.headers.get('Location')).toBe('/api/jobs/copilot_run/copilot_user_ask_RID/events');
    expect(res.headers.get('Content-Type') ?? '').toContain('application/json');
    expect(CopilotDurableRunResponseSchema.parse(await res.json())).toEqual({
      run_id: 'copilot_user_ask_RID',
      session_id: 'sess_1',
      checkpoint_event_id: 'copilot_user_ask_RID',
    });
    // user_ask 写入 = run handle。
    expect(writeUserAskMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
      expect.objectContaining({ sessionId: 'sess_1', userMessage: '讲讲这道题' }),
    );
    // queued 初态事件。
    expect(writeJobEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
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
    expect(dispatchMock).not.toHaveBeenCalled();

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
      expect.objectContaining({ execute: dbExecuteMock }),
      expect.objectContaining({
        business_table: 'copilot_run',
        business_id: 'copilot_user_ask_F2',
        event_type: 'copilot_run.failed',
        payload: expect.objectContaining({
          reason: 'enqueue_failed',
          checkpoint_event_id: 'copilot_user_ask_F2',
        }),
      }),
    );
    // 补偿：copilot_reply error domain event（chained user_ask）让该轮不是 phantom。
    expect(writeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
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
    expect(dispatchMock).not.toHaveBeenCalled();
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
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('durable absent + model inline decision → 同步 SSE framing byte-identical', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    bossSendMock.mockClear();
    runMock.mockClear();
    runMock.mockImplementation(async () => ({ session_id: 's1', reply_event_id: 'e1' }));

    const res = await post({ user_message: 'hi', triggered_by: 'chat' });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
      { user_message: 'hi' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('YUK-757 — absent + model durable decision returns 202 and stamps bounded dispatch provenance', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    dispatchMock.mockResolvedValue({
      mode: 'durable',
      reason: 'multi_artifact_work',
      source: 'model_triage',
      task_run_id: 'copilot_dispatch_physics_batch',
    });
    findOrCreateMock.mockReset().mockResolvedValue({
      sessionId: 'sess_auto_durable',
      created: true,
    });
    writeUserAskMock.mockReset().mockResolvedValue('copilot_user_ask_AUTO');
    writeJobEventMock.mockReset().mockResolvedValue(1);
    getStartedBossMock.mockReset().mockResolvedValue({ send: bossSendMock });
    bossSendMock.mockReset().mockResolvedValue('job_auto');
    runMock.mockClear();

    const userMessage =
      '读取近 30 天 12 次电磁感应错题，按四类聚类并找重复证据；再生成 8 道新题，逐题核验唯一解、单位和退化条件，最后只 propose 调整计划。';
    const res = await post({
      user_message: userMessage,
      triggered_by: 'chat',
      ambient_context: {
        route: '/subjects/physics/mistakes',
        focused_entity: { kind: 'knowledge', id: 'kc_electromagnetic_induction' },
      },
    });

    expect(res.status).toBe(202);
    expect(res.headers.get('Location')).toBe('/api/jobs/copilot_run/copilot_user_ask_AUTO/events');
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
      {
        user_message: userMessage,
        ambient_context: {
          route: '/subjects/physics/mistakes',
          focused_entity: { kind: 'knowledge', id: 'kc_electromagnetic_induction' },
        },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(writeJobEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
      expect.objectContaining({
        event_type: 'copilot_run.queued',
        payload: expect.objectContaining({
          dispatch: {
            source: 'model_triage',
            reason_code: 'multi_artifact_work',
            task_run_id: 'copilot_dispatch_physics_batch',
          },
        }),
      }),
    );
    expect(bossSendMock).toHaveBeenCalledWith(
      'copilot_run',
      expect.objectContaining({
        user_message: userMessage,
        ambient: {
          route: '/subjects/physics/mistakes',
          focused_entity: { kind: 'knowledge', id: 'kc_electromagnetic_induction' },
        },
      }),
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — abort during model triage stops before any durable acceptance side effect', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockClear();
    writeUserAskMock.mockClear();
    writeJobEventMock.mockClear();
    bossSendMock.mockClear();
    getStartedBossMock.mockClear();
    runMock.mockClear();
    let releaseDecision:
      | ((decision: {
          mode: 'durable';
          reason: 'multi_artifact_work';
          source: 'model_triage';
          task_run_id: string;
        }) => void)
      | undefined;
    dispatchMock.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releaseDecision = resolve;
        }),
    );
    const controller = new AbortController();
    const request = new Request('http://test/api/copilot/chat', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        user_message:
          '读取近 60 天 48 道电磁感应与含参函数错题，交叉核验证据、生成 12 道迁移题并逐题跑 validator。',
        triggered_by: 'chat',
        ambient_context: {
          route: '/subjects/physics/mistakes',
          focused_entity: { kind: 'knowledge', id: 'kc_electromagnetic_induction' },
        },
      }),
    });

    const pending = POST(request, {});
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const classifierSignal = dispatchMock.mock.calls[0]?.[2]?.signal as AbortSignal;
    expect(classifierSignal.aborted).toBe(false);
    controller.abort();
    expect(classifierSignal.aborted).toBe(true);
    releaseDecision?.({
      mode: 'durable',
      reason: 'multi_artifact_work',
      source: 'model_triage',
      task_run_id: 'copilot_dispatch_aborted_before_acceptance',
    });
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({
      error: 'request_aborted',
      message: 'request aborted before acceptance',
    });
    expect(findOrCreateMock).not.toHaveBeenCalled();
    expect(writeUserAskMock).not.toHaveBeenCalled();
    expect(writeJobEventMock).not.toHaveBeenCalled();
    expect(getStartedBossMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — durable:false is an explicit force-inline and skips model triage', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    runMock.mockReset().mockResolvedValue({ session_id: 's_force_inline', reply_event_id: 'e1' });
    bossSendMock.mockClear();

    const res = await post({
      user_message: '把我整套高二物理错题逐题核验、修正并出变式。',
      triggered_by: 'chat',
      durable: false,
    });

    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(dispatchMock).not.toHaveBeenCalled();
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
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
