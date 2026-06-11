import { describe, expect, it, vi } from 'vitest';

import type { ActiveGoal } from '@/capabilities/agency/server/goals/queries';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  DREAMING_ACCEPTANCE_RATE_TOP_N,
  DREAMING_MAX_PROPOSALS,
  DREAMING_OBJECTIVE,
  runDreamingNightly,
} from './dreaming_nightly';

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
      // U8 / AF §4 — stub the agent-note reader so these no-DB unit tests don't
      // hit the real readAgentNotes query (db is a {} stub). The dedicated
      // "injects agent_notes" test below overrides this.
      readAgentNotesFn: async () => [],
      // T-AR (YUK-TAR) — stub the acceptance-rate reader so this no-DB unit test
      // doesn't hit the real getProposalAcceptanceRates query (db is a {} stub).
      loadProposalAcceptanceRatesFn: async () => [],
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
        // U8 / AF §4 — stub the agent-note reader (db is a {} stub here).
        readAgentNotesFn: async () => [],
        // T-AR (YUK-TAR) — stub the acceptance-rate reader (db is a {} stub here).
        loadProposalAcceptanceRatesFn: async () => [],
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
      // U8 / AF §4 — stub the agent-note reader (db is a {} stub here).
      readAgentNotesFn: async () => [],
      loadProposalAcceptanceRatesFn: async () => [],
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
      // U8 / AF §4 — stub the agent-note reader so these no-DB unit tests don't
      // hit the real readAgentNotes query (db is a {} stub). The dedicated
      // "injects agent_notes" test below overrides this.
      readAgentNotesFn: async () => [],
      loadProposalAcceptanceRatesFn: async () => [],
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

  // T-AR (YUK-TAR) — acceptance-rate SIGNAL: when proposal_acceptance_rates are
  // present, the DreamingTask input carries them (capped + already sorted) and
  // the objective includes the acceptance-rate bias hint. Purely additive (ND-5).
  it('threads the acceptance-rate signal into the DreamingTask input with bias objective', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    // P5.4-L2 / YUK-174 — the reader now returns the per-(kind, relation) digest;
    // the all-kind RATE the existing feed surfaces is rolled up from it (strict
    // subset). DREAMING_TOOLS spreads KNOWLEDGE_REVIEW_TOOLS, so knowledge_edge /
    // knowledge_node ARE Dreaming-actable — their reason fields DO appear in
    // proposal_feedback (the edge cell carries its relation), as asserted below.
    const acceptanceRates = [
      {
        kind: 'completion',
        relation: null,
        acceptance_rate: 0.9,
        accept_count: 9,
        dismiss_count: 1,
        total: 10,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
      {
        kind: 'knowledge_node',
        relation: null,
        acceptance_rate: 0.5,
        accept_count: 2,
        dismiss_count: 2,
        total: 4,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
      {
        kind: 'archive',
        relation: null,
        acceptance_rate: 0.1,
        accept_count: 1,
        dismiss_count: 9,
        total: 10,
        top_dismiss_reasons: ['archived too aggressively'],
        top_rubric_gates: [],
      },
      {
        kind: 'knowledge_edge',
        relation: 'related_to',
        acceptance_rate: 0.05,
        accept_count: 1,
        dismiss_count: 19,
        total: 20,
        top_dismiss_reasons: ['dumping ground'],
        top_rubric_gates: ['related_to_dumping_ground'],
      },
    ];
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_dreaming_rates',
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
      // U8 / AF §4 — stub the agent-note reader so these no-DB unit tests don't
      // hit the real readAgentNotes query (db is a {} stub). The dedicated
      // "injects agent_notes" test below overrides this.
      readAgentNotesFn: async () => [],
      loadProposalAcceptanceRatesFn: async () => acceptanceRates,
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'DreamingTask',
      expect.objectContaining({
        run_kind: 'nightly',
        // Rolled up per-kind, sorted by acceptance_rate DESC. The knowledge_edge
        // cell adds a 4th kind to the RATE feed (background bias for every kind).
        proposal_acceptance_rates: [
          { kind: 'completion', acceptance_rate: 0.9, accept_count: 9, dismiss_count: 1 },
          { kind: 'knowledge_node', acceptance_rate: 0.5, accept_count: 2, dismiss_count: 2 },
          { kind: 'archive', acceptance_rate: 0.1, accept_count: 1, dismiss_count: 9 },
          { kind: 'knowledge_edge', acceptance_rate: 0.05, accept_count: 1, dismiss_count: 19 },
        ],
        objective: DREAMING_OBJECTIVE,
      }),
      expect.anything(),
    );
    const firstCallArgs = runAgentTaskFn.mock.calls[0] as unknown as unknown[];
    const taskInput = firstCallArgs[1] as {
      objective: string;
      proposal_feedback: Array<{ kind: string; relation: string | null }>;
    };
    expect(taskInput.objective).toContain('proposal_acceptance_rates');
    expect(taskInput.objective).toContain('historical acceptance');
    expect(taskInput.objective).toContain('ND-5');
    // The objective also describes the new reason-feedback fields.
    expect(taskInput.objective).toContain('proposal_feedback');

    // P5.4-L2 / YUK-174 (Facet A, §3.2) — REASON fields are scoped to Dreaming's
    // ACTUAL actable kinds (DREAMING_TOOLS grants knowledge_edge +
    // knowledge_mutation via KNOWLEDGE_REVIEW_TOOLS, plus learning-item / record).
    // completion / knowledge_node / archive / knowledge_edge all reach
    // proposal_feedback; the edge cell additionally carries its relation.
    const feedbackKinds = taskInput.proposal_feedback.map((c) => c.kind);
    expect(feedbackKinds).toContain('completion');
    expect(feedbackKinds).toContain('archive');
    expect(feedbackKinds).toContain('knowledge_node');
    const edgeCell = taskInput.proposal_feedback.find((c) => c.kind === 'knowledge_edge');
    expect(edgeCell?.relation).toBe('related_to');
  });

  // T-AR (YUK-TAR) — caps the surfaced kinds to the top N so the input stays
  // bounded, preserving the already-sorted order from getProposalAcceptanceRates.
  it('caps proposal_acceptance_rates to the top N kinds', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const manyRates = Array.from({ length: 14 }, (_, i) => ({
      kind: `kind_${i}`,
      relation: null,
      acceptance_rate: (14 - i) / 14,
      accept_count: 14 - i,
      dismiss_count: i,
      total: 14,
      top_dismiss_reasons: [],
      top_rubric_gates: [],
    }));
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_dreaming_cap',
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
      // U8 / AF §4 — stub the agent-note reader so these no-DB unit tests don't
      // hit the real readAgentNotes query (db is a {} stub). The dedicated
      // "injects agent_notes" test below overrides this.
      readAgentNotesFn: async () => [],
      loadProposalAcceptanceRatesFn: async () => manyRates,
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    const firstCallArgs = runAgentTaskFn.mock.calls[0] as unknown as unknown[];
    const taskInput = firstCallArgs[1] as {
      proposal_acceptance_rates: { kind: string }[];
    };
    expect(taskInput.proposal_acceptance_rates).toHaveLength(DREAMING_ACCEPTANCE_RATE_TOP_N);
    // Top N preserved in order from the (already-sorted) reader output.
    expect(taskInput.proposal_acceptance_rates[0].kind).toBe('kind_0');
  });

  // T-AR (YUK-TAR) — cold-start back-compat: empty acceptance-rate signal →
  // empty proposal_acceptance_rates array, model has nothing to bias on and
  // behaves exactly as before (additive-only / no-op guarantee, ND-5).
  it('emits empty proposal_acceptance_rates on cold start (no-op back-compat)', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_dreaming_cold',
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
      // U8 / AF §4 — stub the agent-note reader so these no-DB unit tests don't
      // hit the real readAgentNotes query (db is a {} stub). The dedicated
      // "injects agent_notes" test below overrides this.
      readAgentNotesFn: async () => [],
      loadProposalAcceptanceRatesFn: async () => [],
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    const firstCallArgs = runAgentTaskFn.mock.calls[0] as unknown as unknown[];
    const taskInput = firstCallArgs[1] as { proposal_acceptance_rates: unknown[] };
    expect(taskInput.proposal_acceptance_rates).toEqual([]);
  });

  // U8 / AF §4 — un-expired agent_notes (HINTS, not facts) reach the DreamingTask
  // input and the objective describes them as hints. The reader already filters
  // expiry/target (notes.test.ts covers that); here we only assert the wiring.
  it('injects agent_notes into the DreamingTask input and objective', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const listProposalInboxRowsFn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_dreaming_notes',
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
      loadProposalAcceptanceRatesFn: async () => [],
      readAgentNotesFn: async () => [
        {
          id: 'agent_note_1',
          created_at: new Date('2026-05-28T02:00:00.000Z'),
          target_agents: ['dreaming'],
          source_task_kind: 'quiz_verify',
          refs: [{ kind: 'knowledge', id: 'k1' }],
          summary_md: 'pool gap on k1',
          signal_kind: 'question_pool_gap',
          confidence: 0.6,
        },
      ],
      now: () => new Date('2026-05-28T03:00:00.000Z'),
    });

    const firstCallArgs = runAgentTaskFn.mock.calls[0] as unknown as unknown[];
    const taskInput = firstCallArgs[1] as {
      objective: string;
      agent_notes: Array<{ id: string; signal_kind: string; confidence?: number }>;
    };
    expect(taskInput.agent_notes).toEqual([
      {
        id: 'agent_note_1',
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
});
