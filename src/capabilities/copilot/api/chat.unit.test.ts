import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const runMock = vi.hoisted(() => vi.fn());
const writeUserAskMock = vi.hoisted(() => vi.fn());
const writeReplyMock = vi.hoisted(() => vi.fn());
const bossSendMock = vi.hoisted(() => vi.fn());
const bossGetJobByIdMock = vi.hoisted(() => vi.fn());
const getStartedBossMock = vi.hoisted(() => vi.fn());
const findOrCreateMock = vi.hoisted(() => vi.fn());
const writeJobEventMock = vi.hoisted(() => vi.fn());
const shouldEnqueueMock = vi.hoisted(() => vi.fn());
const dbExecuteMock = vi.hoisted(() => vi.fn());
const findAcceptanceMock = vi.hoisted(() => vi.fn());
const reconcileAcceptanceMock = vi.hoisted(() => vi.fn());
const reserveAcceptanceMock = vi.hoisted(() => vi.fn());
const hasTerminalMock = vi.hoisted(() => vi.fn());
const withDispatchLockMock = vi.hoisted(() => vi.fn());
const hashDurableInputMock = vi.hoisted(() => vi.fn());

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
vi.mock('@/capabilities/copilot/server/durable-dispatch', () => ({
  COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH: 200,
  findCopilotDurableAcceptance: findAcceptanceMock,
  reconcileCopilotDurableAcceptance: reconcileAcceptanceMock,
  reserveCopilotDurableAcceptance: reserveAcceptanceMock,
  hasTerminalCopilotRun: hasTerminalMock,
  withCopilotDurableDispatchLock: withDispatchLockMock,
  hashCopilotDurableInput: hashDurableInputMock,
}));
vi.mock('@/server/boss/client', () => ({ getStartedBoss: getStartedBossMock }));
vi.mock('@/server/events/writer', () => ({ writeJobEvent: writeJobEventMock }));
vi.mock('@/server/runtime-env', () => ({ shouldEnqueueBackgroundJobs: shouldEnqueueMock }));
vi.mock('@/server/session', () => ({
  Conversation: { findOrCreateCopilotConversation: findOrCreateMock },
}));

import {
  COPILOT_INLINE_PROVIDER_SESSION_BUDGET_MS,
  COPILOT_INLINE_SSE_HEARTBEAT_MS,
  POST,
} from '@/capabilities/copilot/api/chat';
import { CopilotDurableRunResponseSchema } from '@/capabilities/copilot/api/contracts';
import { __resetRateLimitForTests, checkRateLimit } from '@/server/http/rate-limit';

const post = (body: unknown, idempotencyKey?: string) =>
  POST(
    new Request('http://test/api/copilot/chat', {
      method: 'POST',
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      body: JSON.stringify(body),
    }),
    {},
  );

const readAll = (res: Response) => new Response(res.body).text();

beforeEach(() => {
  __resetRateLimitForTests();
  dbExecuteMock.mockReset().mockResolvedValue([{ count: 0 }]);
  findAcceptanceMock.mockReset().mockResolvedValue(null);
  reconcileAcceptanceMock.mockReset().mockResolvedValue(null);
  hashDurableInputMock.mockReset().mockImplementation((input) => JSON.stringify(input));
  hasTerminalMock.mockReset().mockResolvedValue(false);
  withDispatchLockMock
    .mockReset()
    .mockImplementation(async (database, _runId, run) => run(database));
  reserveAcceptanceMock.mockReset().mockImplementation(async (database, input) => {
    input.assertActive?.();
    const runId = await writeUserAskMock(database, {
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      now: new Date(),
    });
    input.assertActive?.();
    const bossJobId = '11111111-1111-5111-8111-111111111111';
    await writeJobEventMock(database, {
      business_table: 'copilot_run',
      business_id: runId,
      event_type: 'copilot_run.queued',
      payload: {
        ...input.queuedPayload,
        input_hash: input.inputHash,
        boss_job_id: bossJobId,
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      },
    });
    input.assertActive?.();
    return {
      outcome: 'created',
      acceptance: {
        runId,
        sessionId: input.sessionId,
        inputHash: input.inputHash,
        bossJobId,
      },
    };
  });
  bossGetJobByIdMock.mockReset().mockResolvedValue(null);
  bossSendMock.mockReset().mockResolvedValue('jobid');
  getStartedBossMock.mockReset().mockResolvedValue({
    send: bossSendMock,
    getJobById: bossGetJobByIdMock,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
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

  it('YUK-832 — evidence review 静默窗用 SSE comment 保活，不泄露 candidate', async () => {
    vi.useFakeTimers();
    shouldEnqueueMock.mockReturnValue(false);
    let finishRun!: (value: { session_id: string; reply_event_id: string }) => void;
    runMock.mockReset().mockImplementation(
      async () =>
        new Promise<{ session_id: string; reply_event_id: string }>((resolve) => {
          finishRun = resolve;
        }),
    );

    const res = await post({ user_message: '核对完整证据链。', triggered_by: 'chat' });
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const firstRead = reader?.read();

    await vi.advanceTimersByTimeAsync(COPILOT_INLINE_SSE_HEARTBEAT_MS);
    const first = await firstRead;
    expect(new TextDecoder().decode(first?.value)).toBe(': keepalive\n\n');
    expect(runMock).toHaveBeenCalledTimes(1);

    finishRun({ session_id: 's-safe', reply_event_id: 'e-safe' });
    const terminal = await reader?.read();
    expect(new TextDecoder().decode(terminal?.value)).toBe(
      'event: reply\ndata: {"session_id":"s-safe","reply_event_id":"e-safe"}\n\n',
    );
    expect((await reader?.read())?.done).toBe(true);
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
  it('YUK-757 — lost-202 replay returns the original handle before backlog or rate gates', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    shouldEnqueueMock.mockReturnValue(true);
    dbExecuteMock.mockResolvedValue([{ count: 5 }]);
    checkRateLimit();
    const body = {
      user_message:
        '读取 45 天的 36 道跨章节错题，聚类定义域、退化分支和方向单位证据，再生成 9 道迁移题逐题验证。',
      triggered_by: 'chat' as const,
      ambient_context: {
        route: '/subjects/physics/mistakes?window=45d',
        focused_entity: { kind: 'knowledge', id: 'kc_faraday_parameter_transfer' },
      },
    };
    const inputHash = JSON.stringify(body);
    findAcceptanceMock.mockResolvedValue({
      runId: 'copilot_user_ask_recovered_lost_202',
      sessionId: 'sess_recovered_lost_202',
      inputHash,
      bossJobId: '22222222-2222-5222-8222-222222222222',
    });
    bossGetJobByIdMock.mockResolvedValue({ state: 'active' });
    runMock.mockClear();
    bossSendMock.mockClear();
    dbExecuteMock.mockClear();

    const response = await post(body, 'turn-key-lost-202');

    expect(response.status).toBe(202);
    expect(response.headers.get('Location')).toBe(
      '/api/jobs/copilot_run/copilot_user_ask_recovered_lost_202/events',
    );
    await expect(response.json()).resolves.toEqual({
      run_id: 'copilot_user_ask_recovered_lost_202',
      session_id: 'sess_recovered_lost_202',
      checkpoint_event_id: 'copilot_user_ask_recovered_lost_202',
    });
    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — lost-202 replay survives a transient fast lookup failure via locked reconciliation', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    const body = {
      user_message:
        '恢复此前已受理的跨章节证据核对：36 道真实作答、三轮延迟复习、五个未教学探针与九道迁移题。',
      triggered_by: 'chat' as const,
      durable: true,
    };
    const acceptance = {
      runId: 'copilot_user_ask_lost_202_lookup_recovery',
      sessionId: 'sess_lost_202_lookup_recovery',
      inputHash: JSON.stringify(body),
      bossJobId: '66666666-6666-5666-8666-666666666666',
    };
    findAcceptanceMock.mockRejectedValueOnce(new Error('read replica connection reset'));
    reconcileAcceptanceMock.mockResolvedValueOnce(acceptance);
    bossGetJobByIdMock.mockResolvedValueOnce({ state: 'active', id: acceptance.bossJobId });

    const response = await post(body, 'turn-key-lost-202-lookup-recovery');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      run_id: acceptance.runId,
      session_id: acceptance.sessionId,
    });
    expect(reconcileAcceptanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
      'turn-key-lost-202-lookup-recovery',
    );
    expect(reserveAcceptanceMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — unavailable lost-202 lookup and locked reconciliation return explicit ambiguous 503', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findAcceptanceMock.mockRejectedValueOnce(new Error('primary lookup unavailable'));
    reconcileAcceptanceMock.mockRejectedValueOnce(new Error('locked reconciliation unavailable'));

    const response = await post(
      {
        user_message:
          '恢复已提交的函数退化分支与电磁方向单位核对，不要创建第二批迁移题或重复物化提案。',
        triggered_by: 'chat',
        durable: true,
      },
      'turn-key-lost-202-both-lookups-unavailable',
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ error: 'copilot_enqueue_ambiguous' });
    expect(reserveAcceptanceMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — same key with changed focused evidence returns 409 without touching the accepted run', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    const body = {
      user_message: '核对这一组含参函数错题的退化分支。',
      triggered_by: 'chat' as const,
      ambient_context: {
        route: '/subjects/math/mistakes',
        focused_entity: { kind: 'knowledge', id: 'kc_parameter_domain' },
      },
    };
    findAcceptanceMock.mockResolvedValue({
      runId: 'copilot_user_ask_bound_to_other_evidence',
      sessionId: 'sess_idempotency_conflict',
      inputHash: JSON.stringify({
        ...body,
        ambient_context: {
          ...body.ambient_context,
          focused_entity: { kind: 'knowledge', id: 'kc_derivative_sign_change' },
        },
      }),
      bossJobId: '33333333-3333-5333-8333-333333333333',
    });
    writeReplyMock.mockClear();
    bossSendMock.mockClear();

    const response = await post(body, 'turn-key-conflict');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'idempotency_conflict' });
    expect(getStartedBossMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(writeReplyMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — lost acceptance COMMIT acknowledgement is reconciled under the stable key and dispatched', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    const body = {
      user_message:
        '读取 45 天内 36 道含参函数和电磁感应错题，按定义域、退化分支、方向单位交叉聚证，再生成九道迁移题并逐题跑 validator。',
      triggered_by: 'chat' as const,
      durable: true,
      ambient_context: {
        route: '/subjects/physics/mistakes?window=45d',
        focused_entity: { kind: 'knowledge', id: 'kc_faraday_parameter_transfer' },
      },
    };
    const acceptance = {
      runId: 'copilot_user_ask_acceptance_commit_ack_lost',
      sessionId: 'sess_acceptance_commit_ack_lost',
      inputHash: JSON.stringify(body),
      bossJobId: '55555555-5555-5555-8555-555555555555',
    };
    findOrCreateMock.mockResolvedValue({ sessionId: acceptance.sessionId, created: true });
    reserveAcceptanceMock.mockRejectedValueOnce(new Error('connection lost after COMMIT'));
    reconcileAcceptanceMock.mockResolvedValueOnce(acceptance);

    const response = await post(body, 'turn-key-acceptance-commit-ack-lost');

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      run_id: acceptance.runId,
      session_id: acceptance.sessionId,
    });
    expect(reconcileAcceptanceMock).toHaveBeenCalledWith(
      expect.objectContaining({ execute: dbExecuteMock }),
      'turn-key-acceptance-commit-ack-lost',
    );
    expect(bossSendMock).toHaveBeenCalledWith(
      'copilot_run',
      expect.objectContaining({
        run_id: acceptance.runId,
        session_id: acceptance.sessionId,
        user_message: body.user_message,
      }),
      { id: acceptance.bossJobId },
    );
  });

  it('YUK-757 — unavailable locked acceptance reconciliation returns retryable 503 without dispatch', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockResolvedValue({
      sessionId: 'sess_acceptance_reconciliation_unavailable',
      created: true,
    });
    reserveAcceptanceMock.mockRejectedValueOnce(new Error('COMMIT result unknown'));
    reconcileAcceptanceMock.mockRejectedValueOnce(
      new Error('idempotency lock database unavailable'),
    );

    const response = await post(
      {
        user_message:
          '读取三轮真实作答和两份讲义，核对函数参数退化分支后生成七道迁移题并保留逐题校验证据。',
        triggered_by: 'chat',
        durable: true,
      },
      'turn-key-acceptance-reconciliation-unavailable',
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ error: 'copilot_enqueue_ambiguous' });
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(writeReplyMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — send acknowledgement loss with stable job readback stays accepted and never compensates', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockResolvedValue({ sessionId: 'sess_send_ack_lost', created: true });
    writeUserAskMock.mockResolvedValue('copilot_user_ask_send_ack_lost');
    writeJobEventMock.mockClear();
    writeReplyMock.mockClear();
    bossGetJobByIdMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ state: 'created', id: 'stable-job' });
    bossSendMock.mockRejectedValueOnce(new Error('socket closed after COMMIT'));

    const response = await post(
      {
        user_message:
          '交叉读取三份函数讲义、两轮错题与先修图谱，重建四档迁移梯度并预览 validator 结果。',
        triggered_by: 'chat',
        durable: true,
      },
      'turn-key-send-ack-lost',
    );

    expect(response.status).toBe(202);
    expect(bossGetJobByIdMock).toHaveBeenCalledTimes(2);
    expect(writeJobEventMock.mock.calls.map((call) => call[1]?.event_type)).toEqual([
      'copilot_run.queued',
    ]);
    expect(writeReplyMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — client abort after committed acceptance still dispatches instead of stranding QUEUED', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    const controller = new AbortController();
    const body = {
      user_message:
        '交叉读取 42 次真实作答、三轮延迟复习和五个未教学探针，再生成九道含参迁移题并逐题保留 validator 证据。',
      triggered_by: 'chat' as const,
      durable: true,
      ambient_context: {
        route: '/subjects/math/mistakes?window=45d',
        focused_entity: { kind: 'knowledge', id: 'kc_parameter_domain_transfer' },
      },
    };
    findOrCreateMock.mockResolvedValue({ sessionId: 'sess_abort_after_acceptance', created: true });
    reserveAcceptanceMock.mockImplementationOnce(async (database, input) => {
      input.assertActive?.();
      await writeUserAskMock(database, {
        sessionId: input.sessionId,
        userMessage: input.userMessage,
        now: expect.any(Date),
      });
      await writeJobEventMock(database, {
        business_table: 'copilot_run',
        business_id: 'copilot_user_ask_abort_after_acceptance',
        event_type: 'copilot_run.queued',
        payload: input.queuedPayload,
      });
      // Simulate the exact COMMIT→route continuation window: acceptance is
      // durable, but the browser disappears before boss.send begins.
      controller.abort();
      return {
        outcome: 'created',
        acceptance: {
          runId: 'copilot_user_ask_abort_after_acceptance',
          sessionId: input.sessionId,
          inputHash: JSON.stringify(body),
          bossJobId: '44444444-4444-5444-8444-444444444444',
        },
      };
    });

    const response = await POST(
      new Request('http://test/api/copilot/chat', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'turn-key-abort-after-acceptance' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      {},
    );

    expect(response.status).toBe(202);
    expect(controller.signal.aborted).toBe(true);
    expect(bossSendMock).toHaveBeenCalledWith(
      'copilot_run',
      expect.objectContaining({
        run_id: 'copilot_user_ask_abort_after_acceptance',
        session_id: 'sess_abort_after_acceptance',
        user_message: body.user_message,
      }),
      { id: '44444444-4444-5444-8444-444444444444' },
    );
    expect(writeReplyMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — send and readback ambiguity keeps QUEUED for same-key recovery', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockResolvedValue({ sessionId: 'sess_send_ambiguous', created: true });
    writeUserAskMock.mockResolvedValue('copilot_user_ask_send_ambiguous');
    writeJobEventMock.mockClear();
    writeReplyMock.mockClear();
    bossGetJobByIdMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('readback database unavailable'));
    bossSendMock.mockRejectedValueOnce(new Error('send acknowledgement unavailable'));

    const response = await post(
      {
        user_message: '核验 24 道电磁感应题的方向、单位和极端参数，然后只 propose 一份修订方案。',
        triggered_by: 'chat',
        durable: true,
      },
      'turn-key-send-ambiguous',
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ error: 'copilot_enqueue_ambiguous' });
    expect(writeJobEventMock.mock.calls.map((call) => call[1]?.event_type)).toEqual([
      'copilot_run.queued',
    ]);
    expect(writeReplyMock).not.toHaveBeenCalled();
  });

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
    getStartedBossMock
      .mockReset()
      .mockResolvedValue({ send: bossSendMock, getJobById: bossGetJobByIdMock });
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
      { id: '11111111-1111-5111-8111-111111111111' },
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
    let dispatchLockHeld = false;
    withDispatchLockMock.mockReset().mockImplementation(async (database, _runId, run) => {
      dispatchLockHeld = true;
      try {
        return await run(database);
      } finally {
        dispatchLockHeld = false;
      }
    });
    writeJobEventMock.mockReset().mockImplementation(async (_database, input) => {
      if (input.event_type === 'copilot_run.failed') expect(dispatchLockHeld).toBe(true);
      return 1;
    });
    writeReplyMock.mockReset().mockImplementation(async () => {
      expect(dispatchLockHeld).toBe(true);
      return { replyEventId: 're_F2', cleanedReply: '' };
    });
    getStartedBossMock.mockResolvedValue({ send: bossSendMock, getJobById: bossGetJobByIdMock });
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
    // Definitive absence + FAILED/reply compensation are one dispatch-lock
    // transaction. A same-key contender never gets an enqueue window between
    // send readback and compensation.
    expect(withDispatchLockMock).toHaveBeenCalledTimes(1);
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

  it('ordinary chat returns the foreground SSE framing byte-identically', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const requestStartedAt = Date.now();
    shouldEnqueueMock.mockReturnValue(true);
    bossSendMock.mockClear();
    runMock.mockClear();
    runMock.mockImplementation(async () => ({ session_id: 's1', reply_event_id: 'e1' }));

    const res = await post({ user_message: 'hi', triggered_by: 'chat' });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
    expect(runMock.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        providerSessionDeadlineAt: requestStartedAt + COPILOT_INLINE_PROVIDER_SESSION_BUDGET_MS,
      }),
    );
  });

  it('YUK-757 — AI funnel rejects an ordinary turn before it starts', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    shouldEnqueueMock.mockReturnValue(true);
    checkRateLimit();
    runMock.mockClear();
    writeUserAskMock.mockClear();
    writeJobEventMock.mockClear();
    bossSendMock.mockClear();

    const res = await post({
      user_message:
        '读取近 60 天 48 道电磁感应与含参函数错题，交叉核验证据、生成 12 道迁移题并逐题跑 validator。',
      triggered_by: 'chat',
    });

    expect(res.status).toBe(429);
    expect(runMock).not.toHaveBeenCalled();
    expect(writeUserAskMock).not.toHaveBeenCalled();
    expect(writeJobEventMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — one ordinary foreground turn consumes one shared AI-funnel slot', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    shouldEnqueueMock.mockReturnValue(true);
    runMock.mockResolvedValue({ session_id: 's_rate_limited_inline', reply_event_id: 'e_inline' });

    const first = await post({
      user_message: '根据最近两次延迟复习，解释为什么这一步要先检查定义域。',
      triggered_by: 'chat',
    });
    expect(first.status).toBe(200);
    await readAll(first);

    const second = await post({
      user_message: '再解释一次。',
      triggered_by: 'chat',
    });
    expect(second.status).toBe(429);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('YUK-757 — abort during the atomic durable ask reservation never enqueuees or compensates', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockReset().mockResolvedValue({
      sessionId: 'sess_abort_during_ask_commit',
      created: true,
    });
    let releaseAsk: ((runId: string) => void) | undefined;
    writeUserAskMock.mockReset().mockImplementationOnce(
      async () =>
        await new Promise<string>((resolve) => {
          releaseAsk = resolve;
        }),
    );
    writeJobEventMock.mockReset().mockResolvedValue(1);
    writeReplyMock.mockReset().mockResolvedValue('reply_abort_during_ask_commit');
    getStartedBossMock.mockClear();
    bossSendMock.mockClear();
    const controller = new AbortController();
    const pending = POST(
      new Request('http://test/api/copilot/chat', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          user_message:
            '读取 48 道含参方程、两轮延迟复习与四个未教学探针，并逐题保留 validator 证据。',
          triggered_by: 'chat',
          durable: true,
        }),
      }),
      {},
    );

    await vi.waitFor(() => expect(writeUserAskMock).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseAsk?.('copilot_user_ask_abort_during_commit');
    const response = await pending;

    expect(response.status).toBe(499);
    // Production reserveCopilotDurableAcceptance owns ask + QUEUED in one DB
    // transaction. The post-ask abort throws inside that transaction, so there
    // is no committed phantom to compensate and no job may be sent.
    expect(writeJobEventMock).not.toHaveBeenCalled();
    expect(writeReplyMock).not.toHaveBeenCalled();
    expect(getStartedBossMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
  });

  it('YUK-757 — abort before atomic acceptance returns does not send or append FAILED', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    findOrCreateMock.mockReset().mockResolvedValue({
      sessionId: 'sess_abort_during_queued_commit',
      created: true,
    });
    writeUserAskMock.mockReset().mockResolvedValue('copilot_user_ask_abort_during_queued');
    let releaseQueued: ((eventId: number) => void) | undefined;
    writeJobEventMock
      .mockReset()
      .mockImplementationOnce(
        async () =>
          await new Promise<number>((resolve) => {
            releaseQueued = resolve;
          }),
      )
      .mockResolvedValue(2);
    writeReplyMock.mockReset().mockResolvedValue('reply_abort_during_queued_commit');
    getStartedBossMock.mockClear();
    bossSendMock.mockClear();
    const controller = new AbortController();
    const pending = POST(
      new Request('http://test/api/copilot/chat', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          user_message: '后台核对 36 道跨章节练习、三轮延迟复习与四个迁移探针，再生成三档梯度。',
          triggered_by: 'chat',
          durable: true,
        }),
      }),
      {},
    );

    await vi.waitFor(() => expect(writeJobEventMock).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseQueued?.(1);
    const response = await pending;

    expect(response.status).toBe(499);
    // The unit seam records the attempted QUEUED insert; the real store DB test
    // proves its surrounding transaction rolls both ask + QUEUED back.
    expect(writeJobEventMock).toHaveBeenCalledTimes(1);
    expect(writeJobEventMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ event_type: 'copilot_run.queued' }),
    );
    expect(writeReplyMock).not.toHaveBeenCalled();
    expect(getStartedBossMock).not.toHaveBeenCalled();
    expect(bossSendMock).not.toHaveBeenCalled();
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
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalled();
  });

  it('YUK-929 — ordinary chat remains foreground even when durable execution is available', async () => {
    shouldEnqueueMock.mockReturnValue(true);
    runMock.mockReset().mockResolvedValue({
      session_id: 's_foreground_root',
      reply_event_id: 'e_foreground_root',
    });
    bossSendMock.mockClear();

    const res = await post({
      user_message:
        '请帮我把这道含参函数的定义域、退化条件和三个常见错因讲清楚，并给一个可以自己检查的步骤。',
      triggered_by: 'chat',
    });

    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(bossSendMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('YUK-757 — durable:false cannot bypass the shared Copilot AI-funnel limit', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    shouldEnqueueMock.mockReturnValue(true);
    checkRateLimit();
    runMock.mockClear();

    const res = await post({
      user_message: '解释这一步为什么要先检查定义域。',
      triggered_by: 'chat',
      durable: false,
    });

    expect(res.status).toBe(429);
    expect(runMock).not.toHaveBeenCalled();
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
