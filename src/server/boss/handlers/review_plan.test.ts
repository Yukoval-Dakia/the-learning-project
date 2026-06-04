// YUK-203 U4 / D5 / D7 — review_plan handler DI test.
//
// DI-pure (db={}, all seams injected) like coach_daily.test.ts. Asserts the
// surface resolves to EXACTLY the 4 ReviewPlanTask tools, that NO memory tool
// is granted (D7 regression guard), and that trigger + success scan events are
// written.

import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import { runReviewPlan } from './review_plan';

describe('runReviewPlan', () => {
  it('runs ReviewPlanTask with exactly the 4-tool review_plan surface and NO memory tool', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_rp_1',
      text: 'ok',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
      cost_usd: 0.002,
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    // The model persisted a plan this run → verification passes.
    const countReviewPlanArtifactsFn = vi.fn(async () => 1);

    const result = await runReviewPlan(
      db,
      { run_kind: 'daily', mode: 'initial_plan' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        countReviewPlanArtifactsFn,
        now: () => new Date('2026-06-04T19:45:00.000Z'),
      },
    );

    expect(result).toMatchObject({ processed: 1, task_run_id: 'task_rp_1' });

    // Surface = exactly the 4 planner tools.
    const surface = resolveDomainToolNames('review_plan');
    expect(surface).toEqual([
      'read_coach_brief',
      'get_review_knowledge_snapshot',
      'select_review_question_candidates',
      'write_review_plan',
    ]);
    // RED LINE (D7): no memory tool ever appears on the surface.
    expect(surface).not.toContain('query_memory_brief');
    expect(surface).not.toContain('search_memory_facts');

    expect(buildMcpServerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
        toolNames: surface,
        taskKind: 'ReviewPlanTask',
        ctx: expect.objectContaining({
          callerActor: { kind: 'agent', ref: 'review_plan' },
          causedByEventId: expect.stringMatching(/^review_plan_trigger_/),
        }),
      }),
    );

    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'ReviewPlanTask',
      expect.objectContaining({ run_kind: 'daily', mode: 'initial_plan' }),
      expect.objectContaining({
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('review_plan')],
      }),
    );

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:trigger_review_plan',
        actor_kind: 'cron',
        actor_ref: 'review_plan',
      }),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:review_plan',
        actor_kind: 'agent',
        outcome: 'success',
        payload: expect.objectContaining({ run_kind: 'daily', mode: 'initial_plan' }),
      }),
    );
  });

  it('writes a failure scan event and rethrows when the task throws', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('llm down');
    });

    await expect(
      runReviewPlan(
        db,
        {},
        {
          buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
          runAgentTaskFn,
          writeEventFn,
        },
      ),
    ).rejects.toThrow(/llm down/);

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:review_plan',
        outcome: 'failure',
        payload: expect.objectContaining({ error: expect.stringContaining('llm down') }),
      }),
    );
  });

  it('fails the job (failure scan + rethrow) when the task wrote no review-plan artifact', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    // Task returns finishReason:'stop' but never called write_review_plan.
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_rp_noplan',
      text: 'I will not call the tool.',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const countReviewPlanArtifactsFn = vi.fn(async () => 0);

    await expect(
      runReviewPlan(
        db,
        { run_kind: 'daily', mode: 'initial_plan' },
        {
          buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
          runAgentTaskFn,
          writeEventFn,
          countReviewPlanArtifactsFn,
        },
      ),
    ).rejects.toThrow(/wrote no review-plan artifact/);

    // The verification ran with the run's tool_context_task_run_id.
    expect(countReviewPlanArtifactsFn).toHaveBeenCalledWith(
      db,
      expect.stringMatching(/^review_plan_tool_/),
    );
    // A failure scan event is recorded; the error carries the finishReason.
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:review_plan',
        outcome: 'failure',
        payload: expect.objectContaining({
          error: expect.stringContaining('finishReason=stop'),
        }),
      }),
    );
  });
});
