import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCopilotRunCancellationControl,
  prependCopilotCancellationHook,
} from './copilot-run-cancellation';

function preToolUseInput(toolName = 'mcp__loom_v2__query_events') {
  return {
    hook_event_name: 'PreToolUse' as const,
    session_id: 'session_complex_transfer_review',
    cwd: '/product',
    transcript_path: '/tmp/transcript.jsonl',
    permission_mode: 'bypassPermissions' as const,
    tool_name: toolName,
    tool_input: {
      window_days: 45,
      answer_ids: Array.from({ length: 48 }, (_, index) => `answer_${index + 1}`),
      transfer_variants: Array.from({ length: 9 }, (_, index) => `transfer_${index + 1}`),
    },
    tool_use_id: 'tool_use_cross_subject_probe_6',
  };
}

function hookFrom(control: ReturnType<typeof createCopilotRunCancellationControl>): HookCallback {
  return control.prependSdkHook().PreToolUse?.[0]?.hooks[0] as HookCallback;
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
      hookFrom(control)(preToolUseInput(), 'tool_use_cross_subject_probe_6', {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ continue: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(control.signal.aborted).toBe(false);
  });

  it('denies the next SDK tool and aborts the root run after a persisted Stop', async () => {
    const control = createCopilotRunCancellationControl({
      db: {} as never,
      runId: 'copilot_user_ask_material_and_transfer_audit',
      readCancelRequestFn: async () => true,
    });

    const result = await hookFrom(control)(
      preToolUseInput('Task'),
      'tool_use_spawn_validation_specialist',
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
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

    const result = await hookFrom(control)(preToolUseInput(), 'tool_use_probe_unknown', {
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('temporarily unavailable'),
      },
    });
    expect(control.hasConfirmedCancellation).toBe(false);
    expect(control.signal.aborted).toBe(false);
  });

  it('prepends cancellation ahead of the existing spawn contract without replacing it', () => {
    const cancellationHook = vi.fn(async () => ({ continue: true })) as HookCallback;
    const spawnHook = vi.fn(async () => ({ continue: true })) as HookCallback;
    const existing: NonNullable<Options['hooks']> = {
      PreToolUse: [{ matcher: 'Task', timeout: 8, hooks: [spawnHook] }],
    };

    const merged = prependCopilotCancellationHook(cancellationHook, existing);

    expect(merged.PreToolUse).toHaveLength(2);
    expect(merged.PreToolUse?.[0]?.hooks[0]).toBe(cancellationHook);
    expect(merged.PreToolUse?.[1]).toBe(existing.PreToolUse?.[0]);
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
});
