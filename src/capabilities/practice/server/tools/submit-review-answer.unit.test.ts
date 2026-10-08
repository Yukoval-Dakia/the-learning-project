import { beforeEach, expect, it, vi } from 'vitest';
import type { ToolContext } from '@/kernel/tools/types';
import { buildPiDomainAgentTools } from '@/server/ai/tools/pi-tools';
import { __resetRegistryForTests, registerTool } from '@/server/ai/tools/registry';
import { submitReviewAnswerTool } from './submit-review-answer';

const logs = vi.hoisted(() => ({ calls: [] as unknown[], events: [] as unknown[] }));
vi.mock('@/server/ai/log', () => ({
  writeToolCallLog: async (_db: unknown, entry: unknown) => {
    logs.calls.push(entry);
    return 'review-tool-log';
  },
  setToolCallLogMirroredEventId: async () => {},
}));
vi.mock('@/kernel/events', () => ({
  writeEvent: async (_db: unknown, entry: unknown) => {
    logs.events.push(entry);
    return 'review-tool-event';
  },
}));

beforeEach(() => {
  __resetRegistryForTests();
  registerTool(submitReviewAnswerTool);
  logs.calls.length = 0;
  logs.events.length = 0;
});

function mounted(submit: NonNullable<ToolContext['reviewAnswer']>['submit']) {
  const ctx: ToolContext = {
    db: {} as never,
    taskRunId: 'root-review-task',
    sessionId: 'conversation-review',
    causedByEventId: 'accepted-review-turn',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
    reviewAnswer: {
      originalRef: 'accepted-review-turn',
      sessionId: 'conversation-review',
      submit,
    },
  };
  const [tool] = buildPiDomainAgentTools({
    ctx,
    serverName: 'loom',
    toolNames: ['submit_review_answer'],
  });
  return { ctx, tool };
}

it.each([
  { kind: 'pending', run_id: 'judge_native_immutable-original' },
  {
    kind: 'committed',
    status: 'effective',
    submission_id: 'immutable-original',
    attempt_id: 'accepted-attempt',
    candidate_id: 'frozen-candidate',
  },
] satisfies Awaited<ReturnType<NonNullable<ToolContext['reviewAnswer']>['submit']>>[])(
  'real Pi AgentTool preserves the server %s receipt and agent tool-use identity',
  async (receipt) => {
    const submit = vi.fn(async () => receipt);
    const { tool } = mounted(submit);
    const signal = new AbortController().signal;
    expect(tool.name).toBe('mcp__loom__submit_review_answer');
    const result = await tool.execute(
      'pi-review-call',
      { original_ref: 'accepted-review-turn' },
      signal,
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          summary:
            receipt.kind === 'pending'
              ? 'review answer · grading pending'
              : `review answer · ${receipt.status}`,
          output: receipt,
          tool_use_id: 'pi-review-call',
        }),
      },
    ]);
    expect(submit).toHaveBeenCalledExactlyOnceWith(signal);
    expect(logs.calls).toHaveLength(1);
    expect(logs.events).toEqual([
      expect.objectContaining({
        actor_kind: 'agent',
        actor_ref: 'agent:copilot',
        caused_by_event_id: 'accepted-review-turn',
        action: 'tool_use',
      }),
    ]);
  },
);

it('refuses forged answers and actor/independence flags through the actual Pi execution seam', async () => {
  const submit = vi.fn(async () => ({ kind: 'pending' as const, run_id: 'should-not-run' }));
  const { tool } = mounted(submit);
  for (const args of [
    { original_ref: 'other-turn' },
    { original_ref: 'accepted-review-turn', response_md: '模型生成的长答案。'.repeat(150) },
    {
      original_ref: 'accepted-review-turn',
      actor_kind: 'user',
      actor_ref: 'self',
      independent: true,
    },
    { original_ref: 'accepted-review-turn', assessment: { response_set: { entries: [] } } },
  ]) {
    const result = await tool.execute('pi-forged-call', args);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('error') }),
    ]);
  }
  expect(submit).not.toHaveBeenCalled();
});

it('denies a missing/cross-session binding and propagates the Pi abort signal', async () => {
  const submit = vi.fn(async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { kind: 'pending' as const, run_id: 'should-not-run' };
  });
  const { ctx, tool } = mounted(submit);
  for (const unbound of [
    { ...ctx, reviewAnswer: undefined },
    { ...ctx, sessionId: 'other-session' },
    { ...ctx, causedByEventId: 'another-turn' },
  ]) {
    await expect(
      submitReviewAnswerTool.execute(unbound, { original_ref: 'accepted-review-turn' }),
    ).rejects.toMatchObject({ code: 'review_answer_unbound' });
  }
  const controller = new AbortController();
  controller.abort();
  await tool.execute(
    'pi-aborted-call',
    { original_ref: 'accepted-review-turn' },
    controller.signal,
  );
  expect(submit).not.toHaveBeenCalled();
});
