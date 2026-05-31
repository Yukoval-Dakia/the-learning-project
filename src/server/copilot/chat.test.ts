import { describe, expect, it, vi } from 'vitest';

import { resolveDomainToolNames, resolveMcpAllowedTools } from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import { runCopilotChat } from './chat';

describe('runCopilotChat (two-surface routing)', () => {
  it('chat path uses copilot allowlist and writes experimental:copilot_user_ask', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_1',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCopilotChat(
      db,
      { user_message: '现在有哪些错题可以推荐', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        // P5.4-L2 / YUK-174 — stub the feedback reader so the {}-stub db is never
        // queried (cold-start no-op), mirroring the Dreaming/Coach DI stubs.
        loadProposalFeedbackFn: async () => [],
        now: () => new Date('2026-05-28T20:00:00.000Z'),
      },
    );

    expect(result.surface).toBe('copilot');
    expect(result.triggered_by).toBe('chat');
    expect(result.user_ask_event_id).toBeDefined();
    expect(result.reply).toBe('OK');

    expect(writeEventFn).toHaveBeenCalledTimes(1);
    expect(writeEventFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'experimental:copilot_user_ask',
        actor_kind: 'user',
        actor_ref: 'user:self',
      }),
    );

    expect(buildMcpServerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolNames: resolveDomainToolNames('copilot'),
        taskKind: 'CopilotTask',
        ctx: expect.objectContaining({
          callerActor: { kind: 'agent', ref: 'agent:copilot' },
          causedByEventId: expect.stringMatching(/^copilot_user_ask_/),
        }),
      }),
    );

    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'CopilotTask',
      expect.objectContaining({
        surface: 'copilot',
        triggered_by: 'chat',
        user_message: '现在有哪些错题可以推荐',
      }),
      expect.objectContaining({
        allowedTools: [...resolveMcpAllowedTools('copilot')],
      }),
    );
  });

  // P5.1 / YUK-143 — Copilot wires the per-message context-budget throttle into
  // the MCP bridge: a beforeExecute tool-call ceiling + an interceptInput limit
  // cap. We assert the wiring end-to-end through the budget tracker by driving
  // the captured hooks: 10 tool calls allowed then a soft-stop, and an
  // over-budget node request capped down with a truncation note (graceful, not
  // a throw).
  it('wires the per-message context budget (tool-call ceiling + limit cap) into the bridge', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_budget',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runCopilotChat(
      db,
      { user_message: '看看知识图谱', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        loadProposalFeedbackFn: async () => [],
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );

    const opts = buildMcpServerFn.mock.calls[0]?.[0];
    if (!opts?.beforeExecute || !opts?.interceptInput) {
      throw new Error('expected beforeExecute + interceptInput throttle wiring');
    }

    // Tool-call ceiling: COPILOT_CONTEXT_BUDGET.maxToolCalls = 10 allowed, then
    // a soft-stop string (not a throw).
    for (let i = 0; i < 10; i += 1) {
      expect(opts.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toBeUndefined();
    }
    expect(opts.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toMatch(
      /context budget reached/,
    );

    // Limit cap: an over-budget maxNodes request is capped to remaining
    // nodes+edges budget (≤250) with a truncation note. Run a fresh turn so the
    // accumulator is clean (per-message tracker, spec §3.4).
    await runCopilotChat(
      db,
      { user_message: '展开子图', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        loadProposalFeedbackFn: async () => [],
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );
    const opts2 = buildMcpServerFn.mock.calls[1]?.[0];
    if (!opts2?.interceptInput) throw new Error('expected interceptInput on second turn');
    const capped = opts2.interceptInput(
      { name: 'expand_knowledge_subgraph', effect: 'read' },
      { centerNodeId: 'k_1', maxNodes: 9999 },
    );
    expect((capped.args as { maxNodes: number }).maxNodes).toBe(250);
    expect(capped.truncationNote).toMatchObject({ truncated: true, applied_limit: 250 });
  });

  it('chip path uses copilot_user_suggested_mistake_action allowlist and does NOT write user_ask', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_2',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCopilotChat(
      db,
      { user_message: '出3道变式', triggered_by: 'chip', chip_kind: 'out_3_variants' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        loadProposalFeedbackFn: async () => [],
        now: () => new Date('2026-05-28T20:00:00.000Z'),
      },
    );

    expect(result.surface).toBe('copilot_user_suggested_mistake_action');
    expect(result.triggered_by).toBe('chip');
    expect(result.user_ask_event_id).toBeUndefined();

    // Exactly one event written — chip_trigger, NOT user_ask.
    expect(writeEventFn).toHaveBeenCalledTimes(1);
    const writeArg = writeEventFn.mock.calls[0]?.[1];
    expect(writeArg?.action).toBe('experimental:copilot_chip_trigger');
    expect(writeArg?.action).not.toBe('experimental:copilot_user_ask');
    expect(writeArg?.actor_kind).toBe('system');
    expect(writeArg?.actor_ref).toBe('ui:copilot_chip');
    const payload = writeArg?.payload as { chip_kind?: string } | undefined;
    expect(payload?.chip_kind).toBe('out_3_variants');

    expect(buildMcpServerFn).toHaveBeenCalledWith(
      expect.objectContaining({
        toolNames: resolveDomainToolNames('copilot_user_suggested_mistake_action'),
        ctx: expect.objectContaining({
          callerActor: { kind: 'agent', ref: 'agent:copilot_chip' },
        }),
      }),
    );

    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'CopilotTask',
      expect.objectContaining({
        surface: 'copilot_user_suggested_mistake_action',
        triggered_by: 'chip',
        chip_kind: 'out_3_variants',
      }),
      expect.objectContaining({
        allowedTools: [...resolveMcpAllowedTools('copilot_user_suggested_mistake_action')],
      }),
    );
  });

  // P5.4-L2 / YUK-174 (Facet A, §3.3) — the edge-scoped reason digest reaches the
  // CopilotTask run input as `proposal_feedback`. Copilot proposes ONLY
  // knowledge_edge, so non-edge cells are filtered out; the field is char-bounded
  // at read time.
  it('threads an edge-scoped proposal_feedback digest into the CopilotTask input', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_feedback',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runCopilotChat(
      db,
      { user_message: '能不能连一条边', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        loadProposalFeedbackFn: async () => [
          {
            kind: 'knowledge_edge',
            relation: 'related_to',
            accept_count: 1,
            dismiss_count: 9,
            total: 10,
            acceptance_rate: 0.1,
            top_dismiss_reasons: ['dumping ground'],
            top_rubric_gates: ['related_to_dumping_ground'],
          },
          // Non-edge cell — must NOT reach Copilot (it cannot act on it).
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
        ],
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      proposal_feedback: Array<{ kind: string; relation: string | null }>;
    };
    expect(taskInput.proposal_feedback).toEqual([
      {
        kind: 'knowledge_edge',
        relation: 'related_to',
        acceptance_rate: 0.1,
        top_dismiss_reasons: ['dumping ground'],
        top_rubric_gates: ['related_to_dumping_ground'],
      },
    ]);
    // Char-bound: the serialized field never exceeds the whole-digest cap.
    expect(JSON.stringify(taskInput.proposal_feedback).length).toBeLessThanOrEqual(1200);
  });

  // P5.4-L2 / YUK-174 (P1 fix) — a realistic multi-cell digest must NOT collapse to
  // [] (the per-string maxChars=180 is NOT the whole-digest cap), and reason-bearing
  // (actionable, low-acceptance) cells must be kept ahead of reason-less ones.
  it('keeps reason-bearing edge cells under realistic data (no collapse) and orders them first', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_feedback_multi',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const mkCell = (relation: string, rate: number, reasons: string[], gates: string[]) => ({
      kind: 'knowledge_edge' as const,
      relation,
      accept_count: Math.round(rate * 10),
      dismiss_count: 10 - Math.round(rate * 10),
      total: 10,
      acceptance_rate: rate,
      top_dismiss_reasons: reasons,
      top_rubric_gates: gates,
    });

    await runCopilotChat(
      db,
      { user_message: '连边建议', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        // Sorted acceptance DESC (as the digest emits): high-acceptance reason-less
        // cells first, then low-acceptance reason-bearing ones.
        loadProposalFeedbackFn: async () => [
          mkCell('derived_from', 0.9, [], []),
          mkCell('prerequisite', 0.8, [], []),
          mkCell(
            'related_to',
            0.1,
            ['dumping ground; too vague to be useful'],
            ['related_to_dumping_ground'],
          ),
          mkCell(
            'applied_in',
            0.2,
            ['not actually applied here'],
            ['applied_in_no_application_evidence'],
          ),
        ],
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      proposal_feedback: Array<{ relation: string; top_dismiss_reasons: string[] }>;
    };
    // Did NOT collapse to [] (the P1 bug).
    expect(taskInput.proposal_feedback.length).toBeGreaterThan(0);
    const relations = taskInput.proposal_feedback.map((c) => c.relation);
    // Reason-bearing cells survive truncation.
    expect(relations).toContain('related_to');
    expect(relations).toContain('applied_in');
    // ...and are ordered ahead of any reason-less cell that survived.
    const lastActionable = Math.max(
      relations.indexOf('related_to'),
      relations.indexOf('applied_in'),
    );
    const firstReasonless = relations.findIndex(
      (r) => r === 'derived_from' || r === 'prerequisite',
    );
    if (firstReasonless !== -1) expect(lastActionable).toBeLessThan(firstReasonless);
    // Still whole-digest bounded.
    expect(JSON.stringify(taskInput.proposal_feedback).length).toBeLessThanOrEqual(1200);
  });

  it('emits an empty proposal_feedback on cold start (no-op back-compat)', async () => {
    const db = {} as never;
    const mcpServer = { name: 'fake-loom' } as never;
    const buildMcpServerFn = vi.fn((_opts: BuildMcpServerOptions) => mcpServer);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_cold',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    await runCopilotChat(
      db,
      { user_message: '随便聊聊', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        loadProposalFeedbackFn: async () => [],
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      proposal_feedback: unknown[];
    };
    expect(taskInput.proposal_feedback).toEqual([]);
  });
});
