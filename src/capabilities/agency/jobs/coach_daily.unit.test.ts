import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import type { ProposalFeedbackCell } from '@/server/proposals/adaptive-bias';
import {
  COACH_DAILY_OBJECTIVE,
  COACH_MAX_PROPOSALS,
  buildCoachDailyHandler,
  parseCoachOutputSafely,
  runCoach,
} from './coach_daily';

const VALID_TODAY_PLAN = {
  daily_focus: '今天先把上周的「之、其、于」复盘做完',
  // YUK-203 U4 — brief fields included so the parsed (default-filled) plan
  // round-trips against this literal in the today_plan assertion below.
  review_session_proposal: {
    count: 12,
    estimated_minutes: 20,
    knowledge_focus: [],
    subject_mix: [],
    intent_tags: [],
  },
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
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      // P5.4-L2 / YUK-174 — stub the feedback reader (db is a {} stub) so the
      // cold-start no-op path runs without querying.
      loadProposalFeedbackFn: async () => [],
      // codex #3356884494 — stub the agent-note reader so these no-DB unit tests
      // don't hit the real readAgentNotes query (db is a {} stub). The dedicated
      // "injects agent_notes" test below overrides this.
      readAgentNotesFn: async () => [],
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
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      // P5.4-L2 / YUK-174 — stub the feedback reader (db is a {} stub) so the
      // cold-start no-op path runs without querying.
      loadProposalFeedbackFn: async () => [],
      // codex #3356884494 — stub the agent-note reader (db is a {} stub here).
      readAgentNotesFn: async () => [],
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

  // P5.4-L2 / YUK-174 (Facet A + C, §3.3) — the per-(kind, relation) reason
  // digest reaches the CoachTask input scoped to Coach's actable kinds (now
  // INCLUDING knowledge_edge, AB-4) and the objective carries the ND-5 clause.
  it('threads a proposal_feedback digest into the CoachTask input scoped to actable kinds', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_feedback',
      text: JSON.stringify(VALID_TODAY_PLAN),
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const digest: ProposalFeedbackCell[] = [
      {
        kind: 'knowledge_edge',
        relation: 'prerequisite',
        accept_count: 1,
        dismiss_count: 9,
        total: 10,
        acceptance_rate: 0.1,
        top_dismiss_reasons: ['no order evidence'],
        top_rubric_gates: ['prerequisite_no_order_evidence'],
      },
      {
        kind: 'completion',
        relation: null,
        accept_count: 0,
        dismiss_count: 3,
        total: 3,
        acceptance_rate: 0,
        top_dismiss_reasons: ['too early'],
        top_rubric_gates: [],
      },
      // record_links is NOT a Coach-actable kind → must be filtered out.
      {
        kind: 'record_links',
        relation: null,
        accept_count: 0,
        dismiss_count: 2,
        total: 2,
        acceptance_rate: 0,
        top_dismiss_reasons: ['irrelevant link'],
        top_rubric_gates: [],
      },
    ];

    await runCoach(db, 'daily', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      listActiveGoalsFn: async () => [],
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      loadProposalFeedbackFn: async () => digest,
      readAgentNotesFn: async () => [],
      now: () => new Date('2026-05-28T20:00:00.000Z'),
    });

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      objective: string;
      proposal_feedback: Array<{ kind: string; relation: string | null }>;
    };
    const kinds = taskInput.proposal_feedback.map((c) => c.kind);
    // Coach CAN act on knowledge_edge (AB-4) + completion; record_links is out.
    expect(kinds).toContain('knowledge_edge');
    expect(kinds).toContain('completion');
    expect(kinds).not.toContain('record_links');
    // Objective carries the ND-5 reason-feedback + when-to-propose-an-edge clause.
    expect(taskInput.objective).toBe(COACH_DAILY_OBJECTIVE);
    expect(taskInput.objective).toContain('proposal_feedback');
    expect(taskInput.objective).toContain('ND-5');
    expect(taskInput.objective).toContain('knowledge_edge');
  });

  it('emits an empty proposal_feedback on cold start (no-op back-compat)', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_cold',
      text: JSON.stringify(VALID_TODAY_PLAN),
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runCoach(db, 'daily', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      listActiveGoalsFn: async () => [],
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      loadProposalFeedbackFn: async () => [],
      readAgentNotesFn: async () => [],
      now: () => new Date('2026-05-28T20:00:00.000Z'),
    });

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      proposal_feedback: unknown[];
    };
    expect(taskInput.proposal_feedback).toEqual([]);
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
        // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
        listActiveItemsFn: async () => [],
        // P5.4-L2 / YUK-174 — stub the feedback reader (db is a {} stub here).
        loadProposalFeedbackFn: async () => [],
        // codex #3356884494 — stub the agent-note reader (db is a {} stub here).
        readAgentNotesFn: async () => [],
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
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      // P5.4-L2 / YUK-174 — stub the feedback reader (db is a {} stub) so the
      // cold-start no-op path runs without querying.
      loadProposalFeedbackFn: async () => [],
      // codex #3356884494 — stub the agent-note reader (db is a {} stub here).
      readAgentNotesFn: async () => [],
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

  // codex #3356884494 / AF §4 — un-expired agent_notes (HINTS, not facts) reach
  // the CoachTask input and the objective describes them as hints. The reader
  // already filters expiry/target (notes.test.ts covers that); here we only
  // assert the Coach wiring (mirrors dreaming_nightly's injection test). Before
  // this fix quiz_verify's question_pool_gap hints (for_agent='coach') were
  // durable but had no Coach consumer.
  it('injects agent_notes into the CoachTask input and objective', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_notes',
      text: JSON.stringify(VALID_TODAY_PLAN),
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runCoach(db, 'daily', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      listActiveGoalsFn: async () => [],
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      loadProposalFeedbackFn: async () => [],
      readAgentNotesFn: async () => [
        {
          id: 'agent_note_coach_1',
          created_at: new Date('2026-05-28T02:00:00.000Z'),
          target_agents: ['coach'],
          source_task_kind: 'quiz_verify',
          refs: [{ kind: 'knowledge', id: 'k1' }],
          summary_md: 'pool gap on k1',
          signal_kind: 'question_pool_gap',
          confidence: 0.6,
        },
      ],
      now: () => new Date('2026-05-28T20:00:00.000Z'),
    });

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      objective: string;
      agent_notes: Array<{ id: string; signal_kind: string; confidence?: number }>;
    };
    expect(taskInput.agent_notes).toEqual([
      {
        id: 'agent_note_coach_1',
        signal_kind: 'question_pool_gap',
        summary_md: 'pool gap on k1',
        refs: [{ kind: 'knowledge', id: 'k1' }],
        source_task_kind: 'quiz_verify',
        confidence: 0.6,
      },
    ]);
    // Objective labels notes as hints, not facts (ND-5 additive).
    expect(taskInput.objective).toContain('agent_notes');
    expect(taskInput.objective).toContain('HINT');
    expect(taskInput.objective).toContain('ND-5');
  });

  // codex #3356884494 — cold start (no notes) is byte-compatible: the
  // agent_notes field is empty and the run is unchanged.
  it('emits an empty agent_notes on cold start (no-op back-compat)', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_notes_cold',
      text: JSON.stringify(VALID_TODAY_PLAN),
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runCoach(db, 'daily', {
      listProposalInboxRowsFn,
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn,
      listActiveGoalsFn: async () => [],
      // YUK-203 U4 — stub the active learning-items reader (db is a {} stub).
      listActiveItemsFn: async () => [],
      loadProposalFeedbackFn: async () => [],
      readAgentNotesFn: async () => [],
      now: () => new Date('2026-05-28T20:00:00.000Z'),
    });

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      agent_notes: unknown[];
    };
    expect(taskInput.agent_notes).toEqual([]);
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

// YUK-203 U4 / D11① — active_items attention pressure feed.
describe('runCoach active_items feed', () => {
  it('passes injected active learning items into the CoachTask input', async () => {
    const db = {} as never;
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_coach_items',
      text: JSON.stringify(VALID_TODAY_PLAN),
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
      cost_usd: 0.001,
    }));

    await runCoach(db, 'daily', {
      listProposalInboxRowsFn: vi.fn(async () => []),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      runAgentTaskFn,
      writeEventFn: vi.fn(async (_db, input) => input.id),
      listActiveGoalsFn: async () => [],
      listActiveItemsFn: async () => [
        { id: 'li_1', knowledge_ids: ['k_zhi', 'k_qi'], status: 'in_progress', user_pinned: false },
        { id: 'li_2', knowledge_ids: ['k_yu'], status: 'pending', user_pinned: true },
      ],
      loadProposalFeedbackFn: async () => [],
      readAgentNotesFn: async () => [],
      now: () => new Date('2026-06-04T20:00:00.000Z'),
    });

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      active_items: Array<{ id: string; knowledge_ids: string[] }>;
    };
    expect(taskInput.active_items).toEqual([
      { id: 'li_1', knowledge_ids: ['k_zhi', 'k_qi'], status: 'in_progress', user_pinned: false },
      { id: 'li_2', knowledge_ids: ['k_yu'], status: 'pending', user_pinned: true },
    ]);
  });
});

// YUK-203 U4 / D5 + Cross-统合 裁定 #2 — the chain send lives in the FACTORY,
// not in runCoach (so the DI-pure runCoach unit/northstar tests need no boss
// stub). It is best-effort: a failed enqueue must NOT throw out of the handler.
describe('buildCoachDailyHandler review_plan chain', () => {
  it('enqueues review_plan after a successful coach run', async () => {
    const db = {} as never;
    const enqueueReviewPlanFn = vi.fn(async () => undefined);
    const handler = buildCoachDailyHandler(db, {
      listProposalInboxRowsFn: vi.fn(async () => []),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      runAgentTaskFn: vi.fn(async () => ({
        task_run_id: 'task_coach_chain',
        text: JSON.stringify(VALID_TODAY_PLAN),
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
        cost_usd: 0.001,
      })),
      writeEventFn: vi.fn(async (_db, input) => input.id),
      listActiveGoalsFn: async () => [],
      listActiveItemsFn: async () => [],
      loadProposalFeedbackFn: async () => [],
      readAgentNotesFn: async () => [],
      enqueueReviewPlanFn,
    });

    await handler([]);

    expect(enqueueReviewPlanFn).toHaveBeenCalledWith({ run_kind: 'daily', mode: 'initial_plan' });
  });

  it('swallows a failed review_plan enqueue (no rethrow)', async () => {
    const db = {} as never;
    const enqueueReviewPlanFn = vi.fn(async () => {
      throw new Error('boss down');
    });
    const handler = buildCoachDailyHandler(db, {
      listProposalInboxRowsFn: vi.fn(async () => []),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      runAgentTaskFn: vi.fn(async () => ({
        task_run_id: 'task_coach_chain_fail',
        text: JSON.stringify(VALID_TODAY_PLAN),
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
        cost_usd: 0.001,
      })),
      writeEventFn: vi.fn(async (_db, input) => input.id),
      listActiveGoalsFn: async () => [],
      listActiveItemsFn: async () => [],
      loadProposalFeedbackFn: async () => [],
      readAgentNotesFn: async () => [],
      enqueueReviewPlanFn,
    });

    // Must resolve (best-effort): a failed enqueue does not undo the coach run.
    await expect(handler([])).resolves.toBeUndefined();
    expect(enqueueReviewPlanFn).toHaveBeenCalled();
  });
});
