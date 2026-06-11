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
    ).rejects.toThrow(/wrote 0 review-plan artifacts \(expected exactly 1/);

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

  // #3357817915 (handler second layer) — duplicate papers from one run fail the
  // job rather than leaving the user with multiple review papers.
  it('fails the job when the task wrote more than one review-plan artifact', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_rp_dup',
      text: 'wrote two plans',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const countReviewPlanArtifactsFn = vi.fn(async () => 2);

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
    ).rejects.toThrow(/wrote 2 review-plan artifacts \(expected exactly 1/);

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:review_plan',
        outcome: 'failure',
      }),
    );
  });

  // #3358031881 — pg-boss retry idempotency: the per-run identity is keyed on
  // the stable job.id, not a per-attempt random id.
  it('derives a deterministic tool_context_task_run_id from jobId', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_rp_job',
      text: 'ok',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    // No prior artifact (resume pre-check 0), one after the run (verification).
    const countReviewPlanArtifactsFn = vi
      .fn<(db: unknown, id: string) => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    const result = await runReviewPlan(
      db,
      { run_kind: 'daily', mode: 'initial_plan' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn,
        writeEventFn,
        countReviewPlanArtifactsFn,
        jobId: 'job_abc123',
      },
    );

    expect(result.tool_context_task_run_id).toBe('review_plan_tool_job_abc123');
    // The resume pre-check + the post-run verification both keyed on the
    // job-derived id.
    expect(countReviewPlanArtifactsFn).toHaveBeenCalledWith(db, 'review_plan_tool_job_abc123');
  });

  // #3358031881 — resume path: a prior attempt of this job already wrote the
  // paper. This retry must NOT re-run the agent; it records a resumed success
  // scan and returns.
  it('short-circuits (resumes) without running the agent when the job already wrote a plan', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('agent must not run on resume');
    });
    // Prior attempt's artifact already present (pre-check returns 1).
    const countReviewPlanArtifactsFn = vi.fn(async () => 1);

    const result = await runReviewPlan(
      db,
      { run_kind: 'daily', mode: 'initial_plan' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn,
        writeEventFn,
        countReviewPlanArtifactsFn,
        jobId: 'job_resume',
      },
    );

    expect(result).toEqual({
      processed: 1,
      tool_context_task_run_id: 'review_plan_tool_job_resume',
    });
    // Agent never invoked.
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    // The pre-check ran with the job-derived id.
    expect(countReviewPlanArtifactsFn).toHaveBeenCalledWith(db, 'review_plan_tool_job_resume');
    // A resumed success scan is recorded for audit.
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:review_plan',
        outcome: 'success',
        payload: expect.objectContaining({ resumed: true }),
      }),
    );
  });

  // #3358031881 — regression: with jobId present but NO prior artifact, the
  // normal path still runs (pre-check 0 → agent → post-run 1).
  it('runs normally when jobId is present but no prior artifact exists', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_rp_fresh',
      text: 'ok',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    // Pre-check 0 (no resume), post-run 1 (verification passes).
    const countReviewPlanArtifactsFn = vi
      .fn<(db: unknown, id: string) => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    const result = await runReviewPlan(
      db,
      { run_kind: 'daily', mode: 'initial_plan' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn,
        writeEventFn,
        countReviewPlanArtifactsFn,
        jobId: 'job_fresh',
      },
    );

    expect(result).toMatchObject({ processed: 1, task_run_id: 'task_rp_fresh' });
    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
    // No resumed flag on the success scan for a normal run.
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:review_plan',
        outcome: 'success',
        payload: expect.not.objectContaining({ resumed: true }),
      }),
    );
  });

  // #3358031881 — fallback: with no jobId, the id is random (two calls differ).
  it('falls back to a random tool_context_task_run_id when no jobId is given', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const makeRun = () =>
      vi.fn(async () => ({
        task_run_id: 'task_rp_rand',
        text: 'ok',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      }));
    const countReviewPlanArtifactsFn = vi.fn(async () => 1);

    const first = await runReviewPlan(
      db,
      { run_kind: 'daily', mode: 'initial_plan' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: makeRun(),
        writeEventFn,
        countReviewPlanArtifactsFn,
      },
    );
    const second = await runReviewPlan(
      db,
      { run_kind: 'daily', mode: 'initial_plan' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: makeRun(),
        writeEventFn,
        countReviewPlanArtifactsFn,
      },
    );

    expect(first.tool_context_task_run_id).toMatch(/^review_plan_tool_/);
    expect(second.tool_context_task_run_id).toMatch(/^review_plan_tool_/);
    expect(first.tool_context_task_run_id).not.toBe(second.tool_context_task_run_id);
  });
});
