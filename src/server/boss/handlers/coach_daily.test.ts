import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  COACH_MAX_PROPOSALS,
  parseCoachOutputSafely,
  runCoach,
} from '@/server/boss/handlers/coach_daily';

const VALID_TODAY_PLAN = {
  daily_focus: '今天先把上周的「之、其、于」复盘做完',
  review_session_proposal: { count: 12, estimated_minutes: 20 },
  plan_adjustments: [{ kind: 'defer', learning_item_id: 'li_old' }],
  maintenance_proposals: [],
};

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
      text: JSON.stringify(VALID_TODAY_PLAN),
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
      // YUK-143 — North-Star: stub the active-goals reader so these no-DB unit
      // tests don't hit the real listActiveGoals query (db is a {} stub).
      listActiveGoalsFn: async () => [],
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
          // Wave 5 / T-D6/B: the scan event MUST carry the parsed
          // TodayPlan + a top-level daily_focus so
          // `/api/today/copilot-summary` can render it. Devin Review
          // caught the missing pipeline on PR #179.
          daily_focus: VALID_TODAY_PLAN.daily_focus,
          today_plan: expect.objectContaining({
            daily_focus: VALID_TODAY_PLAN.daily_focus,
            review_session_proposal: VALID_TODAY_PLAN.review_session_proposal,
          }),
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
      text: JSON.stringify({
        ...VALID_TODAY_PLAN,
        weekly_reflection: '本周复盘：稳定上手了「之」字四义。',
        plan_adjustments: [],
      }),
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCoach(db, 'weekly', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      // YUK-143 — North-Star: stub the active-goals reader so these no-DB unit
      // tests don't hit the real listActiveGoals query (db is a {} stub).
      listActiveGoalsFn: async () => [],
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
        // YUK-143 — stub the active-goals reader (db is a {} stub here).
        listActiveGoalsFn: async () => [],
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

  it('falls back to plan_parse_error=true when CoachTask emits non-JSON text', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_garbage',
      text: 'I cannot output JSON today, sorry.',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await runCoach(db, 'daily', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      // YUK-143 — North-Star: stub the active-goals reader so these no-DB unit
      // tests don't hit the real listActiveGoals query (db is a {} stub).
      listActiveGoalsFn: async () => [],
      now: () => new Date('2026-05-28T20:00:00.000Z'),
    });

    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:coach_scan',
        outcome: 'success',
        payload: expect.objectContaining({
          run_kind: 'daily',
          today_plan: null,
          plan_parse_error: true,
        }),
      }),
    );
    // Critically — the run succeeds; no top-level daily_focus is added so
    // copilot-summary falls back to the placeholder string.
    const successCall = writeEventFn.mock.calls.find(
      (call) =>
        (call[1] as { action?: string }).action === 'experimental:coach_scan' &&
        (call[1] as { outcome?: string }).outcome === 'success',
    );
    const payload = (successCall?.[1] as { payload?: Record<string, unknown> })?.payload ?? {};
    expect(payload.daily_focus).toBeUndefined();
  });
});

describe('parseCoachOutputSafely', () => {
  it('parses a raw JSON object', () => {
    const plan = parseCoachOutputSafely(JSON.stringify(VALID_TODAY_PLAN));
    expect(plan?.daily_focus).toBe(VALID_TODAY_PLAN.daily_focus);
  });

  it('extracts JSON from inside a ```json fenced block', () => {
    const wrapped = `Here's the plan:\n\n\`\`\`json\n${JSON.stringify(VALID_TODAY_PLAN)}\n\`\`\`\n`;
    const plan = parseCoachOutputSafely(wrapped);
    expect(plan?.daily_focus).toBe(VALID_TODAY_PLAN.daily_focus);
  });

  it('returns null when text is non-JSON prose', () => {
    expect(parseCoachOutputSafely('Nothing to plan today.')).toBeNull();
  });

  it('returns null when JSON is schema-invalid (missing required fields)', () => {
    expect(parseCoachOutputSafely(JSON.stringify({ daily_focus: 'x' }))).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseCoachOutputSafely('')).toBeNull();
  });
});
