import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import { COACH_MAX_PROPOSALS, runCoach } from '@/server/boss/handlers/coach_daily';

describe('runCoach', () => {
  it('runs CoachTask with the coach allowlist and writes trigger + success events (daily)', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'p_before', status: 'pending' }])
      .mockResolvedValueOnce([
        { id: 'p_before', status: 'pending' },
        { id: 'p_new', status: 'pending' },
      ]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_1',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
      cost_usd: 0.001,
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCoach(db, 'daily', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      now: () => new Date('2026-05-28T20:00:00.000Z'),
    });

    expect(result).toMatchObject({
      processed: 1,
      proposals_created: 1,
      pending_after: 2,
      task_run_id: 'task_coach_1',
    });
    expect(buildMcpServerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
        toolNames: resolveDomainToolNames('coach'),
        taskKind: 'CoachTask',
        ctx: expect.objectContaining({
          callerActor: { kind: 'agent', ref: 'coach' },
          causedByEventId: expect.stringMatching(/^coach_trigger_/),
        }),
      }),
    );

    const buildOptions = buildMcpServerFn.mock.calls[0]?.[0];
    if (!buildOptions?.beforeExecute) throw new Error('expected beforeExecute gate');
    for (let i = 0; i < COACH_MAX_PROPOSALS; i++) {
      expect(buildOptions.beforeExecute?.({ name: `propose_${i}`, effect: 'propose' })).toBe(
        undefined,
      );
    }
    expect(buildOptions.beforeExecute?.({ name: 'propose_over_cap', effect: 'propose' })).toMatch(
      /proposal cap reached/,
    );
    expect(buildOptions.beforeExecute?.({ name: 'query_records', effect: 'read' })).toBeUndefined();

    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'CoachTask',
      expect.objectContaining({
        run_kind: 'daily',
        pending_proposals_before: 1,
        budget: expect.objectContaining({ max_proposals: COACH_MAX_PROPOSALS }),
      }),
      expect.objectContaining({
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('coach')],
      }),
    );

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:trigger_coach_scan',
        actor_kind: 'cron',
        actor_ref: 'nightly_coach',
      }),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:coach_scan',
        actor_kind: 'agent',
        actor_ref: 'coach',
        outcome: 'success',
        payload: expect.objectContaining({
          run_kind: 'daily',
          proposals_created: 1,
          pending_after: 2,
        }),
      }),
    );
  });

  it('uses weekly_coach actor_ref + weekly objective when runKind=weekly', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_weekly_1',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCoach(db, 'weekly', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      now: () => new Date('2026-05-31T20:00:00.000Z'),
    });

    expect(result.proposals_created).toBe(0);
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'CoachTask',
      expect.objectContaining({ run_kind: 'weekly' }),
      expect.anything(),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:trigger_coach_scan',
        actor_ref: 'weekly_coach',
      }),
    );
  });

  it('writes failure event and rethrows on CoachTask error', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]);

    await expect(
      runCoach(db, 'daily', {
        listProposalInboxRowsFn,
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        now: () => new Date('2026-05-28T20:00:00.000Z'),
      }),
    ).rejects.toThrow('boom');

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:coach_scan',
        outcome: 'failure',
        payload: expect.objectContaining({ error: 'boom', run_kind: 'daily' }),
      }),
    );
  });
});
