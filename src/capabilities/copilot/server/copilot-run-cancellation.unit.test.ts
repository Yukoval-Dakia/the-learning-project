import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCopilotRunCancellationControl,
  persistCopilotRunCancellationMarker,
} from './copilot-run-cancellation';

function piCall(toolName = 'mcp__loom_v2__query_events') {
  return { id: 'tool_use_cross_subject_probe_6', name: toolName };
}

function piArgs() {
  return {
    window_days: 45,
    answer_ids: Array.from({ length: 48 }, (_, index) => `answer_${index + 1}`),
    transfer_variants: Array.from({ length: 9 }, (_, index) => `transfer_${index + 1}`),
  };
}

describe('Copilot run cancellation control', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows a complex tool call while the persisted run remains active', async () => {
    const read = vi.fn(async () => false);
    const control = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_user_ask_48_answers_6_probes_3_docs_9_transfers',
      readCancelRequestFn: read,
    });

    await expect(
      control.piBeforeToolCall(piCall(), piArgs(), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(control.signal.aborted).toBe(false);
  });

  it('denies the next SDK tool and aborts the root run after a persisted Stop', async () => {
    const control = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_user_ask_material_and_transfer_audit',
      readCancelRequestFn: async () => true,
    });

    const result = await control.piBeforeToolCall(
      piCall('Task'),
      { subagent_type: 'copilot-researcher', description: 'spawn' },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ block: true, reason: expect.any(String) });
    expect(control.hasConfirmedCancellation).toBe(true);
    expect(control.signal.aborted).toBe(true);
  });

  it('fails closed for one new effect when cancellation state is unavailable without lying about Stop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const control = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_user_ask_db_probe_unavailable',
      readCancelRequestFn: async () => {
        throw new Error('read replica unavailable');
      },
    });

    const result = await control.piBeforeToolCall(piCall(), piArgs(), new AbortController().signal);

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining('temporarily unavailable'),
    });
    expect(control.hasConfirmedCancellation).toBe(false);
    expect(control.signal.aborted).toBe(false);
  });

  it('piBeforeToolCall mirrors the SDK gate: clear→pass, cancel→block, aborted signal→block', async () => {
    const call = { id: 'tool_use_pi_gate', name: 'mcp__loom_v2__query_events' };

    const clear = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_pi_gate_clear',
      readCancelRequestFn: async () => false,
    });
    await expect(clear.piBeforeToolCall(call, {})).resolves.toBeUndefined();

    const stopped = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_pi_gate_stopped',
      readCancelRequestFn: async () => true,
    });
    await expect(stopped.piBeforeToolCall(call, {})).resolves.toMatchObject({
      block: true,
      reason: expect.any(String),
    });
    expect(stopped.hasConfirmedCancellation).toBe(true);

    // An already-aborted signal short-circuits before the durable probe.
    const aborted = new AbortController();
    aborted.abort();
    const read = vi.fn(async () => false);
    const signalled = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_pi_gate_signal',
      readCancelRequestFn: read,
    });
    await expect(signalled.piBeforeToolCall(call, {}, aborted.signal)).resolves.toMatchObject({
      block: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('never overlaps slow polling reads and disposes the recursive timer', async () => {
    vi.useFakeTimers();
    let resolveRead!: (value: boolean) => void;
    const read = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const control = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_user_ask_long_pure_text_generation',
      pollIntervalMs: 500,
      readCancelRequestFn: read,
    });

    control.startPolling();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(1);

    resolveRead(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(2);

    control.dispose();
    resolveRead(false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('tracks a materializing tool until its execute, log and mirror barrier settles', async () => {
    const control = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_user_ask_author_question_then_stop',
      readCancelRequestFn: async () => false,
    });

    control.onToolExecutionStarted({ name: 'author_question' });
    expect(control.materializingToolStarted).toBe(true);
    const waiting = control.waitForInFlight(1_000);
    let drained = false;
    void waiting.then((value) => {
      drained = value;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    control.onToolExecutionSettled();
    await expect(waiting).resolves.toBe(true);
  });

  it('never carries a prepared primary view into a cancelled outcome marker', async () => {
    const write = vi.fn(async (_db: unknown, params: { preparedReply?: unknown }) => {
      expect(params.preparedReply).toEqual({ text: '已完成但随后取消。' });
      return { replyEventId: 'reply_cancelled', cleanedReply: '已完成但随后取消。' };
    });

    await persistCopilotRunCancellationMarker({} as never, {
      runId: 'run_cancelled_primary_view',
      sessionId: 'session_cancelled_primary_view',
      actorRef: 'agent:copilot',
      partialText: '已完成但随后取消。',
      preparedReply: {
        text: '已完成但随后取消。',
        primaryView: {
          source: 'tool_result',
          ref: { kind: 'query_knowledge', id: 'toolu_read_1' },
        },
      },
      checkpointSafe: true,
      writeCopilotReplyFn: write as never,
    });

    expect(write).toHaveBeenCalledTimes(1);
  });
});
