import { describe, expect, it, vi } from 'vitest';
import {
  type CopilotRunJobFrame,
  consumeDurableCopilotRun,
  createCopilotRunView,
  foldCopilotRunFrames,
  parseCopilotSseStream,
  parseInlineSubtaskEvent,
} from './subtask-events';

function frame(
  eventId: number,
  eventType: string,
  payload: Record<string, unknown>,
): CopilotRunJobFrame {
  return { event_id: eventId, event_type: eventType, payload };
}

function sseBody(frames: CopilotRunJobFrame[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(
    frames.map((item) => `id: ${item.event_id}\ndata: ${JSON.stringify(item)}\n\n`).join(''),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

describe('Copilot subtask event fold', () => {
  it('folds realistic interleaved, duplicated and out-of-order learning subtasks by stable id', () => {
    const events: CopilotRunJobFrame[] = [
      // Deliberately arrives before both starts. The fold must order by the
      // durable event id rather than array order.
      frame(107, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'cluster-week-errors',
        label: '子任务已完成',
        status: 'completed',
        summary: '定位到两个稳定薄弱点：分数通分的最小公倍数选择，以及文言虚词「之」的指代判断。',
        transcript: '不应进入前台的子 agent 对话',
        reasoning_content: '不应进入前台的隐藏推理',
      }),
      frame(102, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'build-gradient-set',
        label: '为「分数通分」与「之」的用法生成 3 档梯度练习',
        status: 'running',
      }),
      frame(101, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'cluster-week-errors',
        label: '扫描近 7 天的 42 次作答并聚类错因',
        status: 'running',
      }),
      // Exact replay duplicate.
      frame(101, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'cluster-week-errors',
        label: '扫描近 7 天的 42 次作答并聚类错因',
        status: 'running',
      }),
      frame(108, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'build-gradient-set',
        label: '子任务未完成',
        status: 'failed',
        error: '第二档图文题缺少可核验的几何示意，已保留第一、三档结果供 Copilot 收口。',
      }),
      // A malformed late producer heartbeat must not regress a terminal card.
      frame(109, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'cluster-week-errors',
        label: '扫描近 7 天的 42 次作答并聚类错因',
        status: 'running',
      }),
      frame(110, 'copilot_run.done', { task_run_id: 'weekly-rebuild-run' }),
      // A producer notification after the parent terminal must not create a
      // ghost third card, while the replay cursor still advances over it.
      frame(111, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'post-terminal-ghost',
        label: '不应在终态后出现的任务',
        status: 'running',
      }),
    ];

    const result = foldCopilotRunFrames(createCopilotRunView(), events);

    expect(result.phase).toBe('completed');
    expect(result.lastEventId).toBe(111);
    expect(result.subtasks).toEqual([
      {
        id: 'cluster-week-errors',
        label: '扫描近 7 天的 42 次作答并聚类错因',
        status: 'completed',
        summary: '定位到两个稳定薄弱点：分数通分的最小公倍数选择，以及文言虚词「之」的指代判断。',
        lastEventId: 107,
      },
      {
        id: 'build-gradient-set',
        label: '为「分数通分」与「之」的用法生成 3 档梯度练习',
        status: 'failed',
        error: '第二档图文题缺少可核验的几何示意，已保留第一、三档结果供 Copilot 收口。',
        lastEventId: 108,
      },
    ]);
    expect(JSON.stringify(result.subtasks)).not.toContain('transcript');
    expect(JSON.stringify(result.subtasks)).not.toContain('reasoning_content');
  });

  it('accepts only the public inline payload and rejects malformed lifecycle frames', () => {
    expect(
      parseInlineSubtaskEvent(
        JSON.stringify({
          step_kind: 'subtask',
          subtask_id: 'preview-rational-equations',
          label: '预演含参数的一元分式方程题组',
          status: 'completed',
          summary: '三题均通过确定性 validator；保留一个增根陷阱作为最高梯度。',
          reasoning_content: 'private chain of thought',
          prompt: 'private child prompt',
        }),
      ),
    ).toEqual({
      step_kind: 'subtask',
      subtask_id: 'preview-rational-equations',
      label: '预演含参数的一元分式方程题组',
      status: 'completed',
      summary: '三题均通过确定性 validator；保留一个增根陷阱作为最高梯度。',
    });
    expect(
      parseInlineSubtaskEvent(
        JSON.stringify({
          step_kind: 'subtask',
          subtask_id: 'missing-label',
          status: 'running',
        }),
      ),
    ).toBeNull();
    expect(parseInlineSubtaskEvent('{broken-json')).toBeNull();
  });

  it('keeps lifecycle identity strict while clamping overlong display copy', () => {
    const label = `核对${'含参分式方程与定义域证据'.repeat(30)}`;
    const summary = `完成：${'三个独立未教学探针复现同一错误；'.repeat(70)}`;
    const parsed = parseInlineSubtaskEvent(
      JSON.stringify({
        step_kind: 'subtask',
        subtask_id: 'audit-transfer-evidence',
        label,
        status: 'completed',
        summary,
      }),
    );

    expect(parsed?.label).toHaveLength(160);
    expect(parsed?.label.endsWith('…')).toBe(true);
    expect(parsed?.summary).toHaveLength(800);
    expect(parsed?.summary?.endsWith('…')).toBe(true);
    const failed = parseInlineSubtaskEvent(
      JSON.stringify({
        step_kind: 'subtask',
        subtask_id: 'audit-image-evidence',
        label: '复核图文题的几何证据链',
        status: 'failed',
        error: `未完成：${'原始扫描页缺少可辨识的辅助线，无法确定性复原作图条件；'.repeat(50)}`,
      }),
    );
    expect(failed?.error).toHaveLength(800);
    expect(failed?.error?.endsWith('…')).toBe(true);
    expect(
      parseInlineSubtaskEvent(
        JSON.stringify({
          step_kind: 'subtask',
          subtask_id: 'x'.repeat(161),
          label: '这个帧必须因折叠键不可信而被拒绝',
          status: 'running',
        }),
      ),
    ).toBeNull();
  });
});

describe('durable Copilot run SSE replay', () => {
  it('keeps the existing inline parser contract across CRLF chunks and a terminal frame without blank-line suffix', async () => {
    const chunks = [
      'event: delta\r\ndata: {"text":"先核"}\r\n',
      '\r\nevent: reply\r\ndata: {"reply":"先核证据，再生成练习。"}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const parsed = [];
    for await (const event of parseCopilotSseStream(body)) parsed.push(event);

    expect(parsed).toEqual([
      { event: 'delta', data: '{"text":"先核"}' },
      { event: 'reply', data: '{"reply":"先核证据，再生成练习。"}' },
    ]);
  });

  it('counts raw keepalive chunks as transport activity without surfacing a business frame', async () => {
    const onActivity = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
        controller.enqueue(
          new TextEncoder().encode('event: delta\ndata: {"text":"继续核验证据"}\n\n'),
        );
        controller.close();
      },
    });
    const parsed = [];

    for await (const event of parseCopilotSseStream(body, { onActivity })) parsed.push(event);

    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(parsed).toEqual([{ event: 'delta', data: '{"text":"继续核验证据"}' }]);
  });

  it('reconnects with Last-Event-ID and does not duplicate a card or delta reply', async () => {
    const fetchResponse = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          sseBody([
            frame(200, 'copilot_run.queued', { session_id: 'copilot-session-weekly-rebuild' }),
            frame(201, 'copilot_run.step', {
              step_kind: 'subtask',
              subtask_id: 'audit-evidence-chain',
              label: '核对 18 道错题的证据链与判分归因',
              status: 'running',
            }),
            frame(202, 'copilot_run.delta', { text: '我先核对了近一周错题，' }),
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          sseBody([
            // A proxy may replay the cursor frame. Stable event-id folding must
            // keep the sentence and the card singular.
            frame(202, 'copilot_run.delta', { text: '我先核对了近一周错题，' }),
            frame(203, 'copilot_run.step', {
              step_kind: 'subtask',
              subtask_id: 'audit-evidence-chain',
              label: '核对 18 道错题的证据链与判分归因',
              status: 'completed',
              summary: '18 道题均能追到原始作答；2 道旧题缺 token 成本，但不影响错因聚类。',
            }),
            frame(204, 'copilot_run.delta', { text: '再按可迁移错因重排了梯度。' }),
            frame(205, 'copilot_run.reply', {
              reply_md:
                '我核对了近一周错题，再按可迁移错因重排了梯度。新的练习从通分策略迁移到含参分式方程。',
              checkpoint_event_id: 'ask_weekly_rebuild',
            }),
            frame(206, 'copilot_run.done', { task_run_id: 'task_weekly_rebuild' }),
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );
    const snapshots: string[] = [];

    const result = await consumeDurableCopilotRun({
      location: '/api/jobs/copilot_run/ask_weekly_rebuild/events',
      fetchResponse,
      onUpdate: (state) => snapshots.push(`${state.phase}:${state.replyText}`),
      maxReconnects: 2,
      reconnectBaseDelayMs: 0,
    });

    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(fetchResponse.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(new Headers(fetchResponse.mock.calls[1]?.[1]?.headers).get('Last-Event-ID')).toBe('202');
    expect(result.phase).toBe('completed');
    expect(result.lastEventId).toBe(206);
    expect(result.replyText).toBe(
      '我核对了近一周错题，再按可迁移错因重排了梯度。新的练习从通分策略迁移到含参分式方程。',
    );
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]?.status).toBe('completed');
    expect(snapshots.some((snapshot) => snapshot.includes('我先核对了近一周错题，我先核对'))).toBe(
      false,
    );
  });

  it('resumes a previously accepted run from its saved cursor without redispatching work', async () => {
    const interruptedFrames = [
      frame(310, 'copilot_run.queued', { session_id: 'copilot-session-transfer-audit' }),
      frame(311, 'copilot_run.step', {
        step_kind: 'subtask',
        subtask_id: 'audit-transfer-evidence',
        label: '核对 27 次分式方程作答、5 次延迟复习与 3 个未教学探针',
        status: 'running',
      }),
      frame(312, 'copilot_run.delta', {
        text: '我已把同分母、异分母与含参题分开核对，',
      }),
    ];
    const interruptedPayload = new TextEncoder().encode(
      interruptedFrames
        .map((item) => `id: ${item.event_id}\ndata: ${JSON.stringify(item)}\n\n`)
        .join(''),
    );
    let delivered = false;
    const interruptedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(interruptedPayload);
          return;
        }
        controller.error(new Error('wifi dropped after 202 Accepted'));
      },
    });
    const firstFetch = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(interruptedBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    let checkpoint = createCopilotRunView();

    await expect(
      consumeDurableCopilotRun({
        location: '/api/jobs/copilot_run/ask_transfer_audit/events',
        fetchResponse: firstFetch,
        maxReconnects: 0,
        onUpdate: (state) => {
          checkpoint = state;
        },
      }),
    ).rejects.toThrow('wifi dropped after 202 Accepted');
    expect(checkpoint.lastEventId).toBe(312);
    expect(checkpoint.subtasks).toHaveLength(1);

    const resumeFetch = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(
          sseBody([
            frame(313, 'copilot_run.step', {
              step_kind: 'subtask',
              subtask_id: 'audit-transfer-evidence',
              label: '核对 27 次分式方程作答、5 次延迟复习与 3 个未教学探针',
              status: 'completed',
              summary: '错误集中在含参题的定义域前置检查；三个独立探针复现，证据充分。',
            }),
            frame(314, 'copilot_run.delta', { text: '并用独立探针排除了偶然失误。' }),
            frame(315, 'copilot_run.reply', {
              reply_md:
                '我已把同分母、异分母与含参题分开核对，并用独立探针排除了偶然失误。下一组练习应先固定定义域，再处理通分。',
              checkpoint_event_id: 'ask_transfer_audit',
            }),
            frame(316, 'copilot_run.done', { task_run_id: 'task_transfer_audit' }),
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

    const resumed = await consumeDurableCopilotRun({
      location: '/api/jobs/copilot_run/ask_transfer_audit/events',
      fetchResponse: resumeFetch,
      initialState: checkpoint,
    });

    expect(resumeFetch).toHaveBeenCalledTimes(1);
    expect(new Headers(resumeFetch.mock.calls[0]?.[1]?.headers).get('Last-Event-ID')).toBe('312');
    expect(resumed.phase).toBe('completed');
    expect(resumed.lastEventId).toBe(316);
    expect(resumed.subtasks).toEqual([
      expect.objectContaining({
        id: 'audit-transfer-evidence',
        status: 'completed',
        summary: '错误集中在含参题的定义域前置检查；三个独立探针复现，证据充分。',
      }),
    ]);
    expect(resumed.replyText).toBe(
      '我已把同分母、异分母与含参题分开核对，并用独立探针排除了偶然失误。下一组练习应先固定定义域，再处理通分。',
    );
    expect(firstFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts an idle transport and resumes the accepted run from the last durable cursor', async () => {
    let silentSignal: AbortSignal | undefined;
    const fetchResponse = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async (_input, init) => {
        silentSignal = init?.signal ?? undefined;
        const queued = new TextEncoder().encode(
          `id: 501\ndata: ${JSON.stringify(
            frame(501, 'copilot_run.step', {
              step_kind: 'subtask',
              subtask_id: 'rebuild-transfer-gradient',
              label: '重建含参分式方程的三档迁移练习，并逐题复核定义域陷阱',
              status: 'running',
            }),
          )}\n\n`,
        );
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(queued);
            silentSignal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('transport idle', 'AbortError')),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
      .mockResolvedValueOnce(
        new Response(
          sseBody([
            frame(502, 'copilot_run.step', {
              step_kind: 'subtask',
              subtask_id: 'rebuild-transfer-gradient',
              label: '重建含参分式方程的三档迁移练习，并逐题复核定义域陷阱',
              status: 'completed',
              summary: '三档共 12 题均通过确定性 validator；最高档保留两个增根与定义域交叉陷阱。',
            }),
            frame(503, 'copilot_run.reply', {
              reply_md: '练习已按迁移距离重排，并保留了可核验的定义域证据。',
              checkpoint_event_id: 'ask_rebuild_transfer_gradient',
            }),
            frame(504, 'copilot_run.done', { task_run_id: 'task_rebuild_transfer_gradient' }),
          ]),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      );

    const result = await consumeDurableCopilotRun({
      location: '/api/jobs/copilot_run/ask_rebuild_transfer_gradient/events',
      fetchResponse,
      idleTimeoutMs: 10,
      reconnectBaseDelayMs: 0,
      maxReconnects: 1,
    });

    expect(silentSignal?.aborted).toBe(true);
    expect(fetchResponse).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchResponse.mock.calls[1]?.[1]?.headers).get('Last-Event-ID')).toBe('501');
    expect(result).toEqual(
      expect.objectContaining({
        phase: 'completed',
        lastEventId: 504,
        replyText: '练习已按迁移距离重排，并保留了可核验的定义域证据。',
        subtasks: [
          expect.objectContaining({
            id: 'rebuild-transfer-gradient',
            status: 'completed',
            summary: '三档共 12 题均通过确定性 validator；最高档保留两个增根与定义域交叉陷阱。',
          }),
        ],
      }),
    );
  });

  it('stops an in-backoff reconnect immediately when the owning UI aborts', async () => {
    const owner = new AbortController();
    const fetchResponse = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(new Uint8Array(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    const run = consumeDurableCopilotRun({
      location: '/api/jobs/copilot_run/ask_owner_closed/events',
      fetchResponse,
      signal: owner.signal,
      reconnectBaseDelayMs: 60_000,
      maxReconnects: 3,
    });

    await vi.waitFor(() => expect(fetchResponse).toHaveBeenCalledTimes(1));
    owner.abort();

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchResponse).toHaveBeenCalledTimes(1);
  });
});
