import { afterEach, describe, expect, it, vi } from 'vitest';

import { TAVILY_MCP_ALLOWED_TOOLS, buildTavilyMcpServer } from '@/server/ai/mcp/tavily';
import { resolveDomainToolNames, resolveMcpAllowedTools } from '@/server/ai/tools/allowlists';
import { PROPOSAL_FEEDBACK_BUDGET } from '@/server/ai/tools/budgets';
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
        // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
        // is never touched (these are pure routing/wiring unit tests).
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
        now: () => new Date('2026-05-28T20:00:00.000Z'),
      },
    );

    expect(result.surface).toBe('copilot');
    expect(result.triggered_by).toBe('chat');
    expect(result.user_ask_event_id).toBeDefined();
    expect(result.reply).toBe('OK');

    // Two events: the user ask + the persisted reply (AF S3a). The ask is first.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    expect(writeEventFn).toHaveBeenNthCalledWith(
      1,
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

  // AF S3a / YUK-203 U3 — the conversation envelope is resolved once per turn;
  // its session_id is stamped on the ask payload and a reply event is persisted
  // chained to the ask. Both surfaces (chat/chip) share the same envelope.
  it('resolves a conversation session, stamps session_id on the ask, and persists a reply event', async () => {
    const db = {} as never;
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_session',
      text: 'REPLY',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const findOrCreateConversationFn = vi.fn(async () => ({
      sessionId: 'ls_envelope',
      created: false,
    }));

    const result = await runCopilotChat(
      db,
      { user_message: '继续上次的话题', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        findOrCreateConversationFn,
        loadProposalFeedbackFn: async () => [],
        now: () => new Date('2026-06-04T00:00:00.000Z'),
      },
    );

    // Envelope resolved exactly once, result carries it + the reply event id.
    expect(findOrCreateConversationFn).toHaveBeenCalledTimes(1);
    expect(result.session_id).toBe('ls_envelope');
    expect(result.reply_event_id).toMatch(/^copilot_reply_/);

    // Two events: the user ask (session_id stamped) and the reply (chained to ask).
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const askCall = writeEventFn.mock.calls[0]?.[1];
    expect(askCall?.action).toBe('experimental:copilot_user_ask');
    // codex #3356884490 — the user ask carries the session_id on BOTH the events
    // column (so promote_conversation_idle's event.session_id = ls.id join sees
    // it as a user turn for this session) AND the payload (portable copy).
    expect(askCall?.session_id).toBe('ls_envelope');
    expect((askCall?.payload as { session_id?: string }).session_id).toBe('ls_envelope');

    const replyCall = writeEventFn.mock.calls[1]?.[1];
    expect(replyCall?.action).toBe('experimental:copilot_reply');
    expect(replyCall?.actor_kind).toBe('agent');
    expect(replyCall?.session_id).toBe('ls_envelope');
    expect(replyCall?.caused_by_event_id).toBe(askCall?.id);
    const replyPayload = replyCall?.payload as {
      session_id?: string;
      reply_md?: string;
      in_reply_to_event_id?: string;
    };
    expect(replyPayload.session_id).toBe('ls_envelope');
    expect(replyPayload.reply_md).toBe('REPLY');
    expect(replyPayload.in_reply_to_event_id).toBe(askCall?.id);
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
        // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
        // is never touched (these are pure routing/wiring unit tests).
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
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
        // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
        // is never touched (these are pure routing/wiring unit tests).
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
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
        // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
        // is never touched (these are pure routing/wiring unit tests).
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
        now: () => new Date('2026-05-28T20:00:00.000Z'),
      },
    );

    expect(result.surface).toBe('copilot_user_suggested_mistake_action');
    expect(result.triggered_by).toBe('chip');
    expect(result.user_ask_event_id).toBeUndefined();

    // Two events written — chip_trigger (NOT user_ask) + the persisted reply
    // (AF S3a). The first is the chip trigger; the chip path never writes a
    // user_ask event.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const writeArg = writeEventFn.mock.calls[0]?.[1];
    expect(writeArg?.action).toBe('experimental:copilot_chip_trigger');
    expect(writeArg?.action).not.toBe('experimental:copilot_user_ask');
    expect(writeArg?.actor_kind).toBe('system');
    expect(writeArg?.actor_ref).toBe('ui:copilot_chip');
    // codex #3356884490 — the chip trigger also carries the session_id column
    // (not just payload) so chip-driven activity is attributed to this session
    // for the idle clock + replay scoping, same as the ask path.
    expect(writeArg?.session_id).toBe('ls_unit');
    expect((writeArg?.payload as { session_id?: string }).session_id).toBe('ls_unit');
    // The second event is the reply turn (no user_ask anywhere on the chip path).
    const replyArg = writeEventFn.mock.calls[1]?.[1];
    expect(replyArg?.action).toBe('experimental:copilot_reply');
    expect(
      writeEventFn.mock.calls.some((c) => c[1]?.action === 'experimental:copilot_user_ask'),
    ).toBe(false);
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
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
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
    expect(JSON.stringify(taskInput.proposal_feedback).length).toBeLessThanOrEqual(
      PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars,
    );
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
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
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
    expect(JSON.stringify(taskInput.proposal_feedback).length).toBeLessThanOrEqual(
      PROPOSAL_FEEDBACK_BUDGET.maxSerializedChars,
    );
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
        // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
        // is never touched (these are pure routing/wiring unit tests).
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      proposal_feedback: unknown[];
    };
    expect(taskInput.proposal_feedback).toEqual([]);
  });

  // YUK-198 — Tavily remote MCP wiring. Copilot folds in the hosted Tavily MCP
  // server (web grounding) ONLY when TAVILY_API_KEY is configured. When the key
  // is absent the run is byte-for-byte the pre-YUK-198 behaviour: no tavily
  // server in mcpServers, no tavily tools in allowedTools.
  describe('Tavily MCP wiring (YUK-198)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const baseDeps = () => {
      const runAgentTaskFn = vi.fn(async () => ({
        task_run_id: 'task_copilot_tavily',
        text: 'OK',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      }));
      const buildMcpServerFn = vi.fn(
        (_opts: BuildMcpServerOptions) => ({ name: 'fake-loom' }) as never,
      );
      const writeEventFn = vi.fn(async (_db, input) => input.id);
      return { runAgentTaskFn, buildMcpServerFn, writeEventFn };
    };

    it('registers the tavily http server + tools when buildTavilyMcpServerFn returns a config', async () => {
      const { runAgentTaskFn, buildMcpServerFn, writeEventFn } = baseDeps();

      await runCopilotChat(
        {} as never,
        { user_message: '查一下最新的资料', triggered_by: 'chat' },
        {
          buildMcpServerFn,
          runAgentTaskFn,
          writeEventFn,
          loadProposalFeedbackFn: async () => [],
          // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
          // is never touched (these are pure routing/wiring unit tests).
          findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
          buildTavilyMcpServerFn: () => ({
            type: 'http',
            url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-test',
          }),
          now: () => new Date('2026-06-01T00:00:00.000Z'),
        },
      );

      const ctx = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
        mcpServers: Record<string, unknown>;
        allowedTools: string[];
      };
      // loom (domain tools) is still present; tavily is added alongside it.
      expect(Object.keys(ctx.mcpServers)).toEqual(expect.arrayContaining(['loom', 'tavily']));
      expect(ctx.mcpServers.tavily).toMatchObject({
        type: 'http',
        url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-test',
      });
      // Tavily search + extract namespaced tool names are appended after the
      // domain allowlist.
      for (const tool of TAVILY_MCP_ALLOWED_TOOLS) {
        expect(ctx.allowedTools).toContain(tool);
      }
      // Existing domain tools are untouched.
      for (const tool of resolveMcpAllowedTools('copilot')) {
        expect(ctx.allowedTools).toContain(tool);
      }
    });

    it('does NOT register tavily when buildTavilyMcpServerFn returns null (env-absent no-op)', async () => {
      const { runAgentTaskFn, buildMcpServerFn, writeEventFn } = baseDeps();

      await runCopilotChat(
        {} as never,
        { user_message: '随便聊聊', triggered_by: 'chat' },
        {
          buildMcpServerFn,
          runAgentTaskFn,
          writeEventFn,
          loadProposalFeedbackFn: async () => [],
          // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
          // is never touched (these are pure routing/wiring unit tests).
          findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
          buildTavilyMcpServerFn: () => null,
          now: () => new Date('2026-06-01T00:00:00.000Z'),
        },
      );

      const ctx = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
        mcpServers: Record<string, unknown>;
        allowedTools: string[];
      };
      expect(Object.keys(ctx.mcpServers)).toEqual(['loom']);
      expect(ctx.mcpServers.tavily).toBeUndefined();
      for (const tool of TAVILY_MCP_ALLOWED_TOOLS) {
        expect(ctx.allowedTools).not.toContain(tool);
      }
      // Domain allowlist is exactly the copilot surface set — nothing extra.
      expect(ctx.allowedTools).toEqual([...resolveMcpAllowedTools('copilot')]);
    });

    it('defaults to the env-gated builder: TAVILY_API_KEY present → tavily wired', async () => {
      const { runAgentTaskFn, buildMcpServerFn, writeEventFn } = baseDeps();
      vi.stubEnv('TAVILY_API_KEY', 'tvly-from-env');

      await runCopilotChat(
        {} as never,
        { user_message: '上网查查', triggered_by: 'chat' },
        {
          buildMcpServerFn,
          runAgentTaskFn,
          writeEventFn,
          loadProposalFeedbackFn: async () => [],
          // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
          // is never touched (these are pure routing/wiring unit tests).
          findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
          // No buildTavilyMcpServerFn → uses the real env-reading default.
          now: () => new Date('2026-06-01T00:00:00.000Z'),
        },
      );

      const ctx = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
        mcpServers: Record<string, { type?: string; url?: string }>;
        allowedTools: string[];
      };
      expect(ctx.mcpServers.tavily?.type).toBe('http');
      expect(ctx.mcpServers.tavily?.url).toContain('tavilyApiKey=tvly-from-env');
      // Sanity: the default builder agrees with the wiring under this env.
      expect(buildTavilyMcpServer()).not.toBeNull();
    });

    it('defaults to the env-gated builder: TAVILY_API_KEY absent → no tavily', async () => {
      const { runAgentTaskFn, buildMcpServerFn, writeEventFn } = baseDeps();
      vi.stubEnv('TAVILY_API_KEY', '');

      await runCopilotChat(
        {} as never,
        { user_message: '不联网', triggered_by: 'chat' },
        {
          buildMcpServerFn,
          runAgentTaskFn,
          writeEventFn,
          loadProposalFeedbackFn: async () => [],
          // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
          // is never touched (these are pure routing/wiring unit tests).
          findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
          now: () => new Date('2026-06-01T00:00:00.000Z'),
        },
      );

      const ctx = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
        mcpServers: Record<string, unknown>;
        allowedTools: string[];
      };
      expect(ctx.mcpServers.tavily).toBeUndefined();
      expect(buildTavilyMcpServer()).toBeNull();
    });
  });
});
