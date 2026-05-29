import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  DREAMING_MAX_PROPOSALS,
  DREAMING_OBJECTIVE,
  runDreamingNightly,
} from '@/server/boss/handlers/dreaming_nightly';
import type { ActiveGoal } from '@/server/goals/queries';

describe('runDreamingNightly', () => {
  it('runs DreamingTask with the generic MCP bridge and dreaming allowlist', async () => {
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
      task_run_id: 'task_dreaming_1',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
      cost_usd: 0.001,
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runDreamingNightly(db, {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      // YUK-143 — North-Star: stub the active-goals reader so these no-DB unit
      // tests don't hit the real listActiveGoals query (db is a {} stub).
      listActiveGoalsFn: async () => [],
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    expect(result).toMatchObject({
      processed: 1,
      proposals_created: 1,
      pending_after: 2,
      task_run_id: 'task_dreaming_1',
    });
    expect(buildMcpServerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
        toolNames: resolveDomainToolNames('dreaming'),
        taskKind: 'DreamingTask',
        ctx: expect.objectContaining({
          callerActor: { kind: 'agent', ref: 'dreaming' },
          causedByEventId: expect.stringMatching(/^dreaming_trigger_/),
        }),
      }),
    );
    const buildOptions = buildMcpServerFn.mock.calls[0]?.[0];
    if (!buildOptions?.beforeExecute) throw new Error('expected beforeExecute gate');
    for (let i = 0; i < DREAMING_MAX_PROPOSALS; i++) {
      expect(buildOptions.beforeExecute?.({ name: `propose_${i}`, effect: 'propose' })).toBe(
        undefined,
      );
    }
    expect(buildOptions.beforeExecute?.({ name: 'propose_over_cap', effect: 'propose' })).toMatch(
      /proposal cap reached/,
    );
    expect(buildOptions.beforeExecute?.({ name: 'query_records', effect: 'read' })).toBeUndefined();
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'DreamingTask',
      expect.objectContaining({
        run_kind: 'nightly',
        pending_proposals_before: 1,
        budget: expect.objectContaining({ max_proposals: DREAMING_MAX_PROPOSALS }),
      }),
      expect.objectContaining({
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('dreaming')],
      }),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:trigger_dreaming_scan',
        actor_kind: 'cron',
        actor_ref: 'nightly_dreaming',
      }),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:dreaming_scan',
        actor_kind: 'agent',
        actor_ref: 'dreaming',
        outcome: 'success',
        payload: expect.objectContaining({ proposals_created: 1, pending_after: 2 }),
      }),
    );
  });

  it('writes a failure event and rethrows when DreamingTask fails', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await expect(
      runDreamingNightly(db, {
        listProposalInboxRowsFn: vi.fn(async () => []),
        buildMcpServerFn: vi.fn(() => ({}) as never),
        runAgentTaskFn: vi.fn(async () => {
          throw new Error('model down');
        }),
        writeEventFn,
        // YUK-143 — stub the active-goals reader (db is a {} stub here).
        listActiveGoalsFn: async () => [],
        now: () => new Date('2026-05-28T03:00:00.000Z'),
      }),
    ).rejects.toThrow('model down');

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:dreaming_scan',
        outcome: 'failure',
        payload: expect.objectContaining({ error: 'model down' }),
      }),
    );
  });

  // YUK-143 / ADR-0025 — North-Star: when active goals exist, the DreamingTask
  // input carries them as `active_goals` (with scope_knowledge_ids) and the
  // objective includes the goal-bias guidance. Purely additive (ND-5).
  it('threads active goals into the DreamingTask input with goal-bias objective', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const goals: ActiveGoal[] = [
      {
        id: 'goal_1',
        title: '攻克虚词「之」',
        subject_id: 'wenyan',
        scope_knowledge_ids: ['k_zhi_1', 'k_zhi_2'],
        sequence_hint: 0,
      },
      {
        id: 'goal_2',
        title: '熟练判断句',
        subject_id: 'wenyan',
        scope_knowledge_ids: ['k_judge_1'],
        sequence_hint: 1,
      },
    ];
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_dreaming_goals',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runDreamingNightly(db, {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      listActiveGoalsFn: async () => goals,
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'DreamingTask',
      expect.objectContaining({
        run_kind: 'nightly',
        active_goals: [
          {
            id: 'goal_1',
            title: '攻克虚词「之」',
            subject_id: 'wenyan',
            scope_knowledge_ids: ['k_zhi_1', 'k_zhi_2'],
            sequence_hint: 0,
          },
          {
            id: 'goal_2',
            title: '熟练判断句',
            subject_id: 'wenyan',
            scope_knowledge_ids: ['k_judge_1'],
            sequence_hint: 1,
          },
        ],
        objective: DREAMING_OBJECTIVE,
      }),
      expect.anything(),
    );
    const firstCallArgs = runAgentTaskFn.mock.calls[0] as unknown as unknown[];
    const taskInput = firstCallArgs[1] as { objective: string };
    expect(taskInput.objective).toContain('scope_knowledge_ids');
    expect(taskInput.objective).toContain('ND-5');
  });

  // YUK-143 / ADR-0025 — back-compat: empty active goals → empty active_goals
  // array, behaves exactly as before (additive-only guarantee, ND-5).
  it('emits empty active_goals when no goals are active (back-compat)', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_dreaming_no_goals',
      text: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runDreamingNightly(db, {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      listActiveGoalsFn: async () => [],
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    const firstCallArgs = runAgentTaskFn.mock.calls[0] as unknown as unknown[];
    const taskInput = firstCallArgs[1] as {
      active_goals: unknown[];
      run_kind: string;
    };
    expect(taskInput.active_goals).toEqual([]);
    expect(taskInput.run_kind).toBe('nightly');
  });
});
