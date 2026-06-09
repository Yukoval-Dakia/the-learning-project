import { afterEach, describe, expect, it, vi } from 'vitest';

import { TAVILY_MCP_ALLOWED_TOOLS, buildTavilyMcpServer } from '@/server/ai/mcp/tavily';
import { resolveDomainToolNames, resolveMcpAllowedTools } from '@/server/ai/tools/allowlists';
import { PROPOSAL_FEEDBACK_BUDGET } from '@/server/ai/tools/budgets';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  CopilotChatRequest,
  extractPrimaryView,
  runCopilotChat,
  runCopilotChatStreaming,
} from './chat';

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

// AF S4 / YUK-203 U6 — skill routing. A skill_context turn runs a teaching/solve
// behavior pack at the service layer instead of the free-form CopilotTask loop.
// The surface stays 'copilot' (R5), the turn lives on the single Copilot session,
// and a teaching ask_check reply carries turn_kind for the corrective-chip anchor.
describe('runCopilotChat — skill routing (U6)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_copilot', created: false }),
    loadProposalFeedbackFn: async () => [],
    now: () => new Date('2026-06-05T00:00:00.000Z'),
  };

  it('teaching skill: runs on the Copilot session, writes turn_kind + skill_turn, returns skill_turn', async () => {
    // PR #305 review comment #1: the teaching path wraps reply event + question
    // materialization in db.transaction. Stub transaction to execute the callback
    // directly (no real Postgres needed for this unit test).
    const materialized = {
      id: 'q_unit',
      kind: 'short_answer',
      prompt_md: '为什么？',
      choices_md: null,
    };
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
    const writeEventFn = vi.fn(
      async (_db: unknown, input: unknown) => (input as { id: string }).id,
    );
    // Skill returns pendingQuestion (un-persisted) + real task_run_id (PR #305 #1/#3).
    const runTeachingSkillFn = vi.fn(
      async (_params: { sessionId: string; learningItemId: string; userMessage: string }) => ({
        text_md: '我们来看这段——你能说说为什么吗？',
        kind: 'ask_check' as const,
        suggested_next: 'continue' as const,
        task_run_id: 'task_skill_real',
        pendingQuestion: {
          structured_question: {
            kind: 'short_answer' as const,
            reference_md: 'ref',
            prompt_md: '为什么？',
          },
          learningItemId: 'li_unit',
          sessionId: 'ls_copilot',
          fallbackPromptMd: '为什么？',
        },
      }),
    );
    // PR #305 review comment #1: inject a stub materializeAskCheckFn so the unit
    // test's {}-tx stub never needs a real .select(). The full materialization
    // integration test lives in teaching-skill.test.ts.
    const materializeAskCheckFn = vi.fn(async () => ({
      id: 'q_unit',
      kind: 'short_answer',
      prompt_md: '为什么？',
      choices_md: null,
    }));
    // The free-form path must NOT run on a skill turn.
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('CopilotTask must not run on a skill turn');
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    const result = await runCopilotChat(
      db,
      {
        user_message: '帮我讲讲这个',
        triggered_by: 'chat',
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_unit' } },
      },
      {
        ...baseDeps,
        writeEventFn,
        runTeachingSkillFn,
        runAgentTaskFn,
        buildMcpServerFn,
        materializeAskCheckFn,
      },
    );

    // Surface stays 'copilot' (R5: skill ≠ surface).
    expect(result.surface).toBe('copilot');
    // The skill ran against the resolved Copilot session id (no replyEventId param).
    expect(runTeachingSkillFn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ls_copilot', learningItemId: 'li_unit' }),
    );
    expect(runTeachingSkillFn.mock.calls[0]?.[0]).not.toHaveProperty('replyEventId');
    // The free-form CopilotTask loop never ran.
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    // PR #305 review comment #3: result carries the real task_run_id.
    expect(result.task_run_id).toBe('task_skill_real');

    // Two events written (user ask + reply), wrapped in db.transaction for teaching.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const replyCall = writeEventFn.mock.calls[1]?.[1] as {
      id?: string;
      action?: string;
      session_id?: string;
      task_run_id?: string;
      payload?: {
        turn_kind?: string;
        reply_md?: string;
        task_run_id?: string;
        skill_turn?: unknown;
        skill_context?: unknown;
      };
    };
    expect(replyCall?.action).toBe('experimental:copilot_reply');
    expect(replyCall?.session_id).toBe('ls_copilot');
    // PR #305 review comment #3: event.task_run_id = real run id.
    expect(replyCall?.task_run_id).toBe('task_skill_real');
    const replyPayload = replyCall?.payload;
    expect(replyPayload?.turn_kind).toBe('ask_check');
    expect(replyPayload?.reply_md).toBe('我们来看这段——你能说说为什么吗？');
    // PR #305 review comment #3: payload.task_run_id = real run id.
    expect(replyPayload?.task_run_id).toBe('task_skill_real');
    // PR #305 review comment #2: skill_turn persisted in payload for replay.
    expect(replyPayload?.skill_turn).toMatchObject({
      kind: 'ask_check',
      suggested_next: 'continue',
    });
    // PR round-2 (CR 3360614441): skill_context persisted in payload for replay.
    expect(replyPayload?.skill_context).toMatchObject({
      skill: 'teaching',
      ref: { kind: 'learning_item', id: 'li_unit' },
    });
    // The reply event was written inside the transaction (db.transaction called once).
    expect((db as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);
    // The returned skill_turn carries the materialized question (or undefined if
    // materializeAskCheckQuestion was not injected — the stub tx cb returns undefined).
    // Either way, skill_turn.kind is present.
    expect(result.skill_turn?.kind).toBe('ask_check');
    expect(result.skill_turn?.suggested_next).toBe('continue');
  });

  // T-C3-3 (YUK-284) — solve was extracted from the skill_context protocol. A
  // skill_context:{skill:'solve'} (a persisted-old / anomalous value — no live UI
  // seeds it) now 降级 to the free-form CopilotTask path: it does NOT throw and does
  // NOT call any solve runner; it falls through to CopilotTask.
  it('solve skill_context: 降级 to free-form CopilotTask (no throw, no solve routing)', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(
      async (_db: unknown, input: unknown) => (input as { id: string }).id,
    );
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_freeform',
      text: 'FREEFORM',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    const result = await runCopilotChat(
      db,
      {
        user_message: '这道题不会',
        triggered_by: 'chat',
        skill_context: { skill: 'solve', ref: { kind: 'question', id: 'q_solve' } },
      },
      { ...baseDeps, writeEventFn, runAgentTaskFn, buildMcpServerFn },
    );

    // 降级 reached the free-form CopilotTask loop (no crash, no solve routing).
    expect(result.surface).toBe('copilot');
    expect(result.reply).toBe('FREEFORM');
    expect(result.skill_turn).toBeUndefined();
    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
  });

  // ADR-0031 / YUK-304 (lane B) — the quiz C-form service-action intercept is
  // RETIRED. A chip-seeded skill_context:{skill:'quiz'} turn now deliberately
  // falls through to the free-form CopilotTask loop (the model orchestrates
  // query_questions / author_question / write_quiz itself). The wire shape is
  // unchanged; only the routing moved.
  it('quiz skill_context: deliberate free-form route — CopilotTask runs, no quiz interception', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(
      async (_db: unknown, input: unknown) => (input as { id: string }).id,
    );
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_quiz_freeform',
      text: '已为你组好一套练习：[去练习](/practice/art_model)',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const runTeachingSkillFn = vi.fn(async () => {
      throw new Error('teaching pack must not run on a quiz turn');
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    const result = await runCopilotChat(
      db,
      {
        user_message: '给我出套题',
        triggered_by: 'chat',
        skill_context: { skill: 'quiz', ref: { kind: 'knowledge', id: 'kn_x' } },
        ambient_context: {
          route: '/knowledge/kn_x',
          focused_entity: { kind: 'knowledge', id: 'kn_x' },
        },
      },
      {
        ...baseDeps,
        writeEventFn,
        runAgentTaskFn,
        runTeachingSkillFn,
        buildMcpServerFn,
        // Quiz turns are free-form now → history IS assembled; stub the reader
        // so the {}-stub db is never touched.
        loadHistoryFn: async () => [],
      },
    );

    // The free-form loop ran; no behavior pack, no skill_turn.
    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
    expect(runTeachingSkillFn).not.toHaveBeenCalled();
    expect(result.surface).toBe('copilot');
    expect(result.reply).toContain('/practice/art_model');
    expect(result.task_run_id).toBe('task_quiz_freeform');
    expect(result.skill_turn).toBeUndefined();

    // The model received the focused knowledge id via ambient_context (the Dock
    // already sends focused_entity on every skill-active send — zero new plumbing).
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'CopilotTask',
      expect.objectContaining({
        user_message: '给我出套题',
        ambient_context: {
          route: '/knowledge/kn_x',
          focused_entity: { kind: 'knowledge', id: 'kn_x' },
        },
      }),
      expect.anything(),
    );

    // S3a envelope: two events (ask + reply); the reply is the FREE-FORM write —
    // deliberate behavior change: no skill_context persisted on quiz replies any
    // more (Dock replay no longer restores the quiz card from these turns).
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const replyCall = writeEventFn.mock.calls[1]?.[1] as {
      action?: string;
      task_run_id?: string;
      payload?: { skill_context?: unknown; skill_turn?: unknown; reply_md?: string };
    };
    expect(replyCall?.action).toBe('experimental:copilot_reply');
    expect(replyCall?.task_run_id).toBe('task_quiz_freeform');
    expect(replyCall?.payload?.reply_md).toContain('/practice/art_model');
    expect(replyCall?.payload?.skill_context).toBeUndefined();
    expect(replyCall?.payload?.skill_turn).toBeUndefined();
  });

  it('no skill_context: unchanged free-form CopilotTask path (no skill_turn)', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_freeform',
      text: 'FREEFORM',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const runTeachingSkillFn = vi.fn(async () => {
      throw new Error('teaching skill must not run without skill_context');
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    const result = await runCopilotChat(
      db,
      { user_message: '随便聊聊', triggered_by: 'chat' },
      { ...baseDeps, writeEventFn, runAgentTaskFn, runTeachingSkillFn, buildMcpServerFn },
    );

    expect(result.reply).toBe('FREEFORM');
    expect(result.skill_turn).toBeUndefined();
    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
    expect(runTeachingSkillFn).not.toHaveBeenCalled();
  });
});

// ADR-0031 / YUK-304 (lane B) — quiz C→A. The YUK-275 C-form pre-dispatch
// (detectQuizIntent 粗筛 → resolveQuizIntent 四态路由 → runQuizSkill out-port) is
// deleted; a quiz ask (free-text OR chip) is an ordinary free-form CopilotTask
// turn and exits through the standard S3a ask/reply envelope. All deps injected
// → {}-stub db never touched (pure DI unit).
describe('runCopilotChat — quiz C→A free-form routing (ADR-0031)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_copilot', created: false }),
    loadProposalFeedbackFn: async () => [],
    loadHistoryFn: async () => [],
    now: () => new Date('2026-06-10T00:00:00.000Z'),
  };

  function makeDeps(over: Record<string, unknown>) {
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    return {
      writeEventFn,
      buildMcpServerFn,
      deps: { ...baseDeps, writeEventFn, buildMcpServerFn, ...over },
    };
  }

  it('free-text 出题 message routes free-form with the standard reply envelope (no interception)', async () => {
    const db = {} as never;
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_quiz_ft',
      text: '已为你组好一套练习：[去练习](/practice/art_ft)',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const { writeEventFn, deps } = makeDeps({ runAgentTaskFn });

    const result = await runCopilotChat(
      db,
      { user_message: '选两篇高难度古诗词阅读给我', triggered_by: 'chat' },
      deps,
    );

    // The model owns the quiz judgment + orchestration — the free-form loop ran.
    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
    expect(runAgentTaskFn).toHaveBeenCalledWith(
      'CopilotTask',
      expect.objectContaining({
        surface: 'copilot',
        triggered_by: 'chat',
        user_message: '选两篇高难度古诗词阅读给我',
      }),
      expect.anything(),
    );

    // CopilotChatResult envelope matches the free-form contract.
    expect(result.surface).toBe('copilot');
    expect(result.triggered_by).toBe('chat');
    expect(result.reply).toContain('/practice/art_ft');
    expect(result.task_run_id).toBe('task_quiz_ft');
    expect(result.session_id).toBe('ls_copilot');
    expect(result.reply_event_id).toMatch(/^copilot_reply_/);
    expect(result.user_ask_event_id).toMatch(/^copilot_user_ask_/);

    // S3a persistence: ask + reply, reply chained to the ask, no quiz fields.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const askCall = writeEventFn.mock.calls[0]?.[1] as { id?: string; action?: string };
    const replyCall = writeEventFn.mock.calls[1]?.[1] as {
      action?: string;
      caused_by_event_id?: string;
      payload?: { reply_md?: string; skill_context?: unknown; in_reply_to_event_id?: string };
    };
    expect(askCall?.action).toBe('experimental:copilot_user_ask');
    expect(replyCall?.action).toBe('experimental:copilot_reply');
    expect(replyCall?.caused_by_event_id).toBe(askCall?.id);
    expect(replyCall?.payload?.in_reply_to_event_id).toBe(askCall?.id);
    expect(replyCall?.payload?.reply_md).toContain('/practice/art_ft');
    expect(replyCall?.payload?.skill_context).toBeUndefined();
  });

  it('chip quiz turn assembles conversation_history like any free-form turn', async () => {
    const db = {} as never;
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_quiz_chip',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const loadHistoryFn = vi.fn(async () => [
      { role: 'user' as const, text: '上一轮的提问' } as never,
    ]);
    const { deps } = makeDeps({ runAgentTaskFn, loadHistoryFn });

    await runCopilotChat(
      db,
      {
        user_message: '出套题',
        triggered_by: 'chat',
        skill_context: { skill: 'quiz', ref: { kind: 'knowledge', id: 'kn_q' } },
      },
      deps,
    );

    // Quiz turns no longer short-circuit — the history reader IS consulted and
    // the assembled history reaches the run input (防循环 ① shape preserved).
    expect(loadHistoryFn).toHaveBeenCalledTimes(1);
    const input = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      conversation_history: Array<Record<string, unknown>>;
    };
    expect(input.conversation_history).toEqual([{ role: 'user', text: '上一轮的提问' }]);
  });

  it('streaming: a quiz turn (chip or free-text) routes the free-form stream token loop', async () => {
    const db = {} as never;
    const deltas: string[] = [];
    const streamAgentTaskFn = vi.fn(
      async (_k: string, _i: unknown, _c: unknown, onDelta: (t: string) => void) => {
        onDelta('已为你组好');
        onDelta('一套练习');
        return {
          task_run_id: 'task_quiz_stream',
          text: '已为你组好一套练习',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const { deps } = makeDeps({ streamAgentTaskFn });

    const result = await runCopilotChatStreaming(
      db,
      {
        user_message: '给我来一道题',
        triggered_by: 'chat',
        skill_context: { skill: 'quiz', ref: { kind: 'knowledge', id: 'kn_s' } },
      },
      (t) => deltas.push(t),
      deps,
    );

    // Token-loop streaming (NOT the old deterministic one-delta quiz reply).
    expect(streamAgentTaskFn).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['已为你组好', '一套练习']);
    expect(result.reply).toBe('已为你组好一套练习');
    expect(result.task_run_id).toBe('task_quiz_stream');
    expect(result.surface).toBe('copilot');
  });
});

// YUK-284 (C2) — the free-form CopilotTask path forwards ctx.skills =
// resolveCopilotSkills() so the dialogue-methodology SKILL.md loads. The resolver
// is injected (resolveCopilotSkillsFn) so the test never touches disk; the
// behavior-pack (teaching/solve/quiz) service-call paths must NOT receive skills.
describe('runCopilotChat — copilot skill wiring (C2 / YUK-284)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_copilot', created: false }),
    loadProposalFeedbackFn: async () => [],
    now: () => new Date('2026-06-08T00:00:00.000Z'),
  };

  // T-C2-4 — non-streaming free-form ctx carries skills:['copilot'].
  it('non-streaming free-form: ctx carries skills:[copilot] when the resolver hits', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    let capturedCtx: unknown;
    const runAgentTaskFn = vi.fn(async (_kind: string, _input: unknown, ctx: unknown) => {
      capturedCtx = ctx;
      return {
        task_run_id: 'task_freeform',
        text: 'REPLY',
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    await runCopilotChat(
      db,
      { user_message: '解释一下「之」', triggered_by: 'chat' },
      {
        ...baseDeps,
        writeEventFn,
        runAgentTaskFn,
        buildMcpServerFn,
        resolveCopilotSkillsFn: async () => ['copilot'],
      },
    );

    expect(capturedCtx).toMatchObject({ skills: ['copilot'] });
  });

  // T-C2-5 — streaming free-form ctx ALSO carries skills:['copilot'] (审查标注的唯一
  // 差异点：流式分支独立断言，证明 stream/non-stream 两路 skills 加载一致).
  it('streaming free-form: ctx carries skills:[copilot] (stream/non-stream parity)', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    let streamCtx: unknown;
    const streamAgentTaskFn = vi.fn(
      async (_kind: string, _input: unknown, ctx: unknown, onDelta: (t: string) => void) => {
        streamCtx = ctx;
        onDelta('OK');
        return {
          task_run_id: 'task_stream_real',
          text: 'OK',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    await runCopilotChatStreaming(
      db,
      { user_message: '解释一下「之」', triggered_by: 'chat' },
      () => {},
      {
        ...baseDeps,
        writeEventFn,
        streamAgentTaskFn,
        buildMcpServerFn,
        resolveCopilotSkillsFn: async () => ['copilot'],
      },
    );

    expect(streamCtx).toMatchObject({ skills: ['copilot'] });
  });

  // T-C2-6 — resolver miss (SKILL.md absent) → ctx OMITS skills entirely (零回归:
  // spread-when-present keeps the ctx shape byte-for-byte the pre-C2 shape).
  it('resolver miss: free-form ctx omits the skills field entirely (零回归)', async () => {
    const db = {} as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    let capturedCtx: unknown;
    const runAgentTaskFn = vi.fn(async (_kind: string, _input: unknown, ctx: unknown) => {
      capturedCtx = ctx;
      return {
        task_run_id: 'task_freeform',
        text: 'REPLY',
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 2 },
      };
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    await runCopilotChat(
      db,
      { user_message: '随便聊聊', triggered_by: 'chat' },
      {
        ...baseDeps,
        writeEventFn,
        runAgentTaskFn,
        buildMcpServerFn,
        resolveCopilotSkillsFn: async () => undefined,
      },
    );

    expect(capturedCtx).not.toHaveProperty('skills');
  });

  // T-C2-7 — the behavior-pack (teaching — the only pack left after ADR-0031
  // retired the quiz intercept) service-call path does NOT receive copilot
  // skills (service call composes its own task-prompt; it never reads copilot SKILL.md).
  it('behavior-pack path: resolver result is never threaded into the teaching service call', async () => {
    // The teaching pack wraps its reply write in db.transaction — stub it to run
    // the callback directly (no real Postgres for this unit).
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    let teachingParams: unknown;
    const runTeachingSkillFn = vi.fn(async (params: unknown) => {
      teachingParams = params;
      return {
        text_md: '我们来看这段。',
        kind: 'explain' as const,
        suggested_next: 'continue' as const,
        task_run_id: 'task_teaching_real',
      };
    });
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('CopilotTask must not run on a behavior-pack turn');
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    const resolveCopilotSkillsFn = vi.fn(async () => ['copilot'] as string[]);

    await runCopilotChat(
      db,
      {
        user_message: '帮我讲讲这个',
        triggered_by: 'chat',
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_x' } },
      },
      {
        ...baseDeps,
        writeEventFn,
        runTeachingSkillFn,
        runAgentTaskFn,
        buildMcpServerFn,
        resolveCopilotSkillsFn,
      },
    );

    // The free-form CopilotTask loop never ran, and although the resolver is called
    // once eagerly (single fs.access), the result is NEVER threaded into a
    // behavior-pack service call — runTeachingSkillFn receives no skills.
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    expect(runTeachingSkillFn).toHaveBeenCalledTimes(1);
    expect(teachingParams).not.toHaveProperty('skills');
  });
});

// T-C3-7 (YUK-284) — wire-enum backward compat. CopilotChatRequest.parse must still
// accept skill_context.skill ∈ {teaching, solve, quiz} so chip quiz (#348) keeps
// working and persisted-old solve replies still parse. CopilotChatRequest is exported
// by chat.ts → pure schema parse, zero DB (unit; NOT route.test.ts which is DB).
describe('CopilotChatRequest wire enum (C3 / YUK-284)', () => {
  it('accepts skill_context.skill = teaching | solve | quiz (向后兼容)', () => {
    for (const skill of ['teaching', 'solve', 'quiz'] as const) {
      const parsed = CopilotChatRequest.parse({
        user_message: 'x',
        triggered_by: 'chat',
        skill_context: { skill, ref: { kind: 'knowledge', id: 'k1' } },
      });
      expect(parsed.skill_context?.skill).toBe(skill);
    }
  });

  it('rejects an unknown skill_context.skill value', () => {
    expect(() =>
      CopilotChatRequest.parse({
        user_message: 'x',
        triggered_by: 'chat',
        skill_context: { skill: 'bogus', ref: { kind: 'knowledge', id: 'k1' } },
      }),
    ).toThrow();
  });
});

// YUK-266 (C1) — runCopilotChatStreaming streams text deltas then resolves the
// terminal CopilotChatResult. The turn-persistence contract is byte-identical to
// the non-stream path: the SAME single experimental:copilot_reply event is written
// with the full text + the real task_run_id. Streaming failure degrades gracefully.
describe('runCopilotChatStreaming (C1 — SSE streaming entrypoint)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_stream', created: false }),
    loadProposalFeedbackFn: async () => [],
    now: () => new Date('2026-06-07T00:00:00.000Z'),
  };

  it('free-form: streams via streamAgentTaskFn, persists the same two events, returns the non-stream result', async () => {
    const db = {} as never;
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    // The non-stream runner must NOT be used on the streaming path.
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('runAgentTask must not run on the streaming path');
    });
    const streamAgentTaskFn = vi.fn(
      async (_kind: string, _input: unknown, _ctx: unknown, onDelta: (t: string) => void) => {
        onDelta('OK');
        return {
          task_run_id: 'task_stream_real',
          text: 'OK',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const deltas: string[] = [];

    const result = await runCopilotChatStreaming(
      db,
      { user_message: '解释一下「之」', triggered_by: 'chat' },
      (t) => deltas.push(t),
      { ...baseDeps, buildMcpServerFn, runAgentTaskFn, streamAgentTaskFn, writeEventFn },
    );

    // onDelta fired with the chunk; the free-form token loop ran via the stream seam.
    expect(deltas).toEqual(['OK']);
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    expect(streamAgentTaskFn).toHaveBeenCalledTimes(1);

    // Result equals what the non-stream path would return — real task_run_id + reply.
    expect(result.task_run_id).toBe('task_stream_real');
    expect(result.reply).toBe('OK');
    expect(result.session_id).toBe('ls_stream');
    expect(result.reply_event_id).toMatch(/^copilot_reply_/);
    expect(result.error).toBeUndefined();

    // Persistence contract: TWO events (ask + reply); the reply carries reply_md:'OK'
    // and the REAL task_run_id — byte-identical to the non-stream path.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const askCall = writeEventFn.mock.calls[0]?.[1] as { action?: string };
    expect(askCall?.action).toBe('experimental:copilot_user_ask');
    const replyCall = writeEventFn.mock.calls[1]?.[1] as {
      action?: string;
      task_run_id?: string;
      payload?: { reply_md?: string; task_run_id?: string };
    };
    expect(replyCall?.action).toBe('experimental:copilot_reply');
    expect(replyCall?.task_run_id).toBe('task_stream_real');
    expect(replyCall?.payload?.reply_md).toBe('OK');
    expect(replyCall?.payload?.task_run_id).toBe('task_stream_real');
  });

  // ADR-0031 (lane B): quiz turns stream through the token loop now; the
  // one-delta deterministic path belongs to the teaching behavior pack only.
  it('skill turn (teaching): emits ONE delta (the full reply) then resolves the skill result', async () => {
    // The teaching pack wraps its reply write in db.transaction — stub it.
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const runTeachingSkillFn = vi.fn(async () => ({
      text_md: '我们来看这段——先理解整体意思。',
      kind: 'explain' as const,
      suggested_next: 'continue' as const,
      task_run_id: 'task_teaching_stream',
    }));
    // The free-form stream runner must NOT run on a skill turn.
    const streamAgentTaskFn = vi.fn(async () => {
      throw new Error('streamAgentTask must not run on a skill turn');
    });
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    const deltas: string[] = [];

    const result = await runCopilotChatStreaming(
      db,
      {
        user_message: '帮我讲讲这个',
        triggered_by: 'chat',
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_q' } },
      },
      (t) => deltas.push(t),
      { ...baseDeps, writeEventFn, runTeachingSkillFn, streamAgentTaskFn, buildMcpServerFn },
    );

    // Exactly one delta carrying the full deterministic skill reply.
    expect(deltas).toEqual(['我们来看这段——先理解整体意思。']);
    expect(streamAgentTaskFn).not.toHaveBeenCalled();
    expect(result.reply).toBe('我们来看这段——先理解整体意思。');
    expect(result.surface).toBe('copilot');
  });

  it('degrade: a mid-stream throw still persists the collected text + returns an error note', async () => {
    const db = {} as never;
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    // streamTaskCollecting resolves a partial result (it does NOT throw) on SDK
    // error — model that here: onDelta fires then a partial result is returned.
    const streamAgentTaskFn = vi.fn(
      async (_kind: string, _input: unknown, _ctx: unknown, onDelta: (t: string) => void) => {
        onDelta('partial');
        return {
          task_run_id: 'task_stream_partial',
          text: 'partial',
          finishReason: 'error' as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          partial: true,
          error: 'sdk blew up mid-stream',
        };
      },
    );
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const deltas: string[] = [];

    const result = await runCopilotChatStreaming(
      db,
      { user_message: '随便聊聊', triggered_by: 'chat' },
      (t) => deltas.push(t),
      { ...baseDeps, buildMcpServerFn, streamAgentTaskFn, writeEventFn },
    );

    expect(deltas).toEqual(['partial']);
    // The reply event is STILL written with the partial text + real run id.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    const replyCall = writeEventFn.mock.calls[1]?.[1] as {
      action?: string;
      payload?: { reply_md?: string; task_run_id?: string };
    };
    expect(replyCall?.action).toBe('experimental:copilot_reply');
    expect(replyCall?.payload?.reply_md).toBe('partial');
    expect(replyCall?.payload?.task_run_id).toBe('task_stream_partial');
    // The result carries the error note (graceful degrade — turn never lost).
    expect(result.reply).toBe('partial');
    expect(result.error).toBe('sdk blew up mid-stream');
  });

  it('bypasses runAgentTask when streamAgentTaskFn is injected on the streaming path', async () => {
    const db = {} as never;
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    // The streaming entrypoint must consult streamAgentTaskFn, NOT the non-stream
    // runAgentTaskFn. Inject a throwing runAgentTaskFn alongside a stub stream fn and
    // assert the runAgentTask seam is bypassed when a stream fn IS given. (The real
    // default — streamTaskCollecting when no stream fn is injected — runs the live
    // SDK and is covered by runner.stream-collect.test.ts, not here.)
    const runAgentTaskFn = vi.fn(async () => {
      throw new Error('runAgentTask must not run on the streaming path');
    });
    const streamAgentTaskFn = vi.fn(
      async (_k: string, _i: unknown, _c: unknown, onDelta: (t: string) => void) => {
        onDelta('hi');
        return {
          task_run_id: 'task_x',
          text: 'hi',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);

    await runCopilotChatStreaming(db, { user_message: '嗨', triggered_by: 'chat' }, () => {}, {
      ...baseDeps,
      buildMcpServerFn,
      runAgentTaskFn,
      streamAgentTaskFn,
      writeEventFn,
    });

    expect(runAgentTaskFn).not.toHaveBeenCalled();
    expect(streamAgentTaskFn).toHaveBeenCalledTimes(1);
  });
});

// YUK-267 (C2) — conversation memory + ambient context. The free-form CopilotTask
// run input gains conversation_history (last N session-scoped turns, {role,text}
// only, double-truncated) + ambient_context (current-message-only). 防循环 invariants
// are unit-tested. All deps injected → stays in fastTestInclude.
describe('runCopilotChat — conversation memory + ambient (C2)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_mem', created: false }),
    loadProposalFeedbackFn: async () => [],
    now: () => new Date('2026-06-07T00:00:00.000Z'),
  };

  // A CopilotTurn-shaped fixture (the reader exposes role+text; extra keys here
  // simulate a polluted source row for the 防循环 ⑤ test).
  const mkTurn = (role: 'user' | 'ai', text: string, extra: Record<string, unknown> = {}) =>
    ({
      role,
      text,
      at: '2026-06-06T00:00:00.000Z',
      event_id: `e_${text.slice(0, 4)}`,
      ...extra,
    }) as never;

  function captureRunInput(runAgentTaskFn: ReturnType<typeof vi.fn>) {
    return (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      conversation_history: Array<Record<string, unknown>>;
      ambient_context?: unknown;
      proposal_feedback: unknown[];
    };
  }

  it('history: assembles ≤maxTurns {role,text}-only entries (scoping + 防循环 ①)', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    // 12 turns (> maxTurns=8). The reader returns oldest→newest.
    const turns = Array.from({ length: 12 }, (_, i) =>
      mkTurn(i % 2 === 0 ? 'user' : 'ai', `turn ${i}`),
    );

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => turns,
      },
    );

    const input = captureRunInput(runAgentTaskFn);
    expect(input.conversation_history.length).toBeLessThanOrEqual(8);
    for (const entry of input.conversation_history) {
      // {role, text} ONLY — no leaked turn-row keys.
      expect(Object.keys(entry).sort()).toEqual(['role', 'text']);
    }
    // Newest kept (tail-slice): the last entry is the newest turn.
    expect(input.conversation_history.at(-1)).toEqual({ role: 'ai', text: 'turn 11' });
  });

  it('防循环 ⑤: a polluted source row contributes {role,text} ONLY — no assembly artifact leaks', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    // Simulate a turn whose source row ALSO carried injection artifacts (a prior
    // run's conversation_history echo / proposal_feedback / ambient_context /
    // skill_context). None of these may reach THIS run's conversation_history.
    const polluted = mkTurn('ai', 'a reply body', {
      conversation_history: [{ role: 'user', text: 'NESTED' }],
      proposal_feedback: [{ kind: 'knowledge_edge' }],
      ambient_context: { route: '/secret' },
      skill_context: { skill: 'quiz', ref: { kind: 'knowledge', id: 'x' } },
      skill_turn: { kind: 'ask_check' },
    });

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => [polluted],
      },
    );

    const input = captureRunInput(runAgentTaskFn);
    expect(input.conversation_history).toEqual([{ role: 'ai', text: 'a reply body' }]);
    const serialized = JSON.stringify(input.conversation_history);
    expect(serialized).not.toContain('NESTED');
    expect(serialized).not.toContain('proposal_feedback');
    expect(serialized).not.toContain('ambient_context');
    expect(serialized).not.toContain('skill_context');
    expect(serialized).not.toContain('skill_turn');
  });

  it('防循环 ④: double truncation — per-turn cap + oldest dropped on total overflow', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    // Per-turn: one >800-char turn → truncated to 800. Total: enough big turns that
    // the serialized array exceeds 4000 → oldest dropped until it fits.
    const big = 'x'.repeat(1000);
    const turns = Array.from({ length: 8 }, (_, i) => mkTurn('user', `${i}-${big}`));

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => turns,
      },
    );

    const input = captureRunInput(runAgentTaskFn);
    // Per-turn truncation: no entry text exceeds 800 chars.
    for (const entry of input.conversation_history) {
      expect((entry.text as string).length).toBeLessThanOrEqual(800);
    }
    // Whole-array bound: serialized history fits the total cap.
    expect(JSON.stringify(input.conversation_history).length).toBeLessThanOrEqual(4000);
    // Oldest dropped first: the surviving entries are the NEWEST ones (highest idx).
    const firstSurviving = input.conversation_history[0]?.text as string;
    expect(firstSurviving.startsWith('0-')).toBe(false);
  });

  it('防循环 ②: ambient_context rides the run input but is NEVER written to any turn payload', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);

    await runCopilotChat(
      {} as never,
      {
        user_message: '我在哪',
        triggered_by: 'chat',
        ambient_context: {
          route: '/knowledge/k1',
          focused_entity: { kind: 'knowledge', id: 'k1' },
        },
      },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => [],
      },
    );

    // Run input DOES carry ambient_context.
    const input = captureRunInput(runAgentTaskFn);
    expect(input.ambient_context).toEqual({
      route: '/knowledge/k1',
      focused_entity: { kind: 'knowledge', id: 'k1' },
    });
    // NEITHER the ask event NOR the reply event payload contains ambient_context.
    const askPayload = (writeEventFn.mock.calls[0]?.[1] as { payload?: unknown })?.payload;
    const replyPayload = (writeEventFn.mock.calls[1]?.[1] as { payload?: unknown })?.payload;
    expect(JSON.stringify(askPayload)).not.toContain('ambient_context');
    expect(JSON.stringify(replyPayload)).not.toContain('ambient_context');
    expect(JSON.stringify(askPayload)).not.toContain('/knowledge/k1');
    expect(JSON.stringify(replyPayload)).not.toContain('/knowledge/k1');
  });

  it('防循环 ③: proposal_feedback is read fresh per message and is NOT mixed into history', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const loadProposalFeedbackFn = vi.fn(async () => [
      {
        kind: 'knowledge_edge' as const,
        relation: 'related_to',
        accept_count: 1,
        dismiss_count: 1,
        total: 2,
        acceptance_rate: 0.5,
        top_dismiss_reasons: ['FEEDBACK_MARKER'],
        top_rubric_gates: [],
      },
    ]);

    await runCopilotChat(
      {} as never,
      { user_message: '连边', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        loadProposalFeedbackFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => [mkTurn('user', 'earlier ask')],
      },
    );

    expect(loadProposalFeedbackFn).toHaveBeenCalledTimes(1);
    const input = captureRunInput(runAgentTaskFn);
    // proposal_feedback is its OWN field, not folded into conversation_history.
    expect(JSON.stringify(input.conversation_history)).not.toContain('FEEDBACK_MARKER');
    expect(JSON.stringify(input.proposal_feedback)).toContain('FEEDBACK_MARKER');
  });

  it('degrade: a loadHistory failure yields conversation_history:[] and the chat still replies', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'STILL_OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);

    const result = await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => {
          throw new Error('history read blew up');
        },
      },
    );

    expect(result.reply).toBe('STILL_OK');
    const input = captureRunInput(runAgentTaskFn);
    expect(input.conversation_history).toEqual([]);
  });

  it('history is read BEFORE the ask write (current ask is structurally excluded)', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const loadHistoryFn = vi.fn(async () => [mkTurn('user', 'prior turn')]);
    let historyReadBeforeAnyWrite = false;
    loadHistoryFn.mockImplementation(async () => {
      historyReadBeforeAnyWrite = writeEventFn.mock.calls.length === 0;
      return [mkTurn('user', 'prior turn')];
    });

    await runCopilotChat(
      {} as never,
      { user_message: 'THE_CURRENT_ASK', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn,
      },
    );

    // The history read happened before the ask event was written.
    expect(historyReadBeforeAnyWrite).toBe(true);
    // And the current ask is not in the assembled history (it wasn't in the fixture).
    const input = captureRunInput(runAgentTaskFn);
    expect(JSON.stringify(input.conversation_history)).not.toContain('THE_CURRENT_ASK');
  });

  // ADR-0031 (lane B): quiz turns DO assemble history now (they are free-form);
  // the short-circuit applies to the remaining behavior pack (teaching) only.
  it('teaching skill turns do NOT assemble conversation_history (reader not consulted)', async () => {
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    const loadHistoryFn = vi.fn(async () => [mkTurn('user', 'x')]);
    const runTeachingSkillFn = vi.fn(async () => ({
      text_md: '讲解一下。',
      kind: 'explain' as const,
      suggested_next: 'continue' as const,
      task_run_id: 'task_teaching_hist',
    }));

    await runCopilotChat(
      db,
      {
        user_message: '讲讲',
        triggered_by: 'chat',
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_h' } },
      },
      {
        ...baseDeps,
        writeEventFn,
        runTeachingSkillFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn,
      },
    );

    // The teaching path short-circuits before history assembly.
    expect(loadHistoryFn).not.toHaveBeenCalled();
  });
});

// YUK-307 (C1 — presentation layer §2.3) — primary_view hero nomination. The
// model appends an HTML-comment marker as its reply's LAST output; chat.ts
// parses + strips it at the single JSON/streaming convergence point, persists
// it as an ADDITIVE reply-payload field, and returns it on CopilotChatResult.
// Lenient by contract: a malformed marker degrades to absent and never fails
// the turn. 防循环 红线: the field is reply METADATA and must never re-enter
// prompt assembly (T8a/T8b below).
describe('runCopilotChat — primary_view nomination (YUK-307)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_pv', created: false }),
    loadProposalFeedbackFn: async () => [],
    loadHistoryFn: async () => [],
    now: () => new Date('2026-06-10T00:00:00.000Z'),
  };
  const VALID_MARKER =
    '<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_abc"}}-->';
  const mkBuild = () => vi.fn(() => ({ name: 'fake-loom' }) as never);
  const mkRunFn = (text: string) =>
    vi.fn(async () => ({
      task_run_id: 'task_pv',
      text,
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
  const mkWrite = () => vi.fn(async (_db: unknown, input: { id: string }) => input.id);

  it('T1: a valid artifact marker → result + persisted payload carry primary_view; reply_md is cleaned', async () => {
    const runAgentTaskFn = mkRunFn(`这是你的题。\n${VALID_MARKER}`);
    const writeEventFn = mkWrite();

    const result = await runCopilotChat(
      {} as never,
      { user_message: '出一道题', triggered_by: 'chat' },
      { ...baseDeps, runAgentTaskFn, writeEventFn, buildMcpServerFn: mkBuild() },
    );

    expect(result.primary_view).toEqual({
      source: 'artifact',
      ref: { kind: 'question', id: 'q_abc' },
    });
    // The marker is an instruction, not content — stripped from the API reply…
    expect(result.reply).toBe('这是你的题。');
    expect(result.reply).not.toContain('<!--');
    // …and from the persisted reply_md; the nomination rides as a payload sibling.
    const replyCall = writeEventFn.mock.calls[1]?.[1] as {
      payload?: { reply_md?: string; primary_view?: unknown };
    };
    expect(replyCall?.payload?.reply_md).toBe('这是你的题。');
    expect(replyCall?.payload?.primary_view).toEqual({
      source: 'artifact',
      ref: { kind: 'question', id: 'q_abc' },
    });
  });

  it('T2: malformed marker JSON → absent, marker still stripped, turn succeeds, warn logged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runAgentTaskFn = mkRunFn('回答正文\n<!--primary_view:{not json}-->');
    const writeEventFn = mkWrite();

    const result = await runCopilotChat(
      {} as never,
      { user_message: '随便', triggered_by: 'chat' },
      { ...baseDeps, runAgentTaskFn, writeEventFn, buildMcpServerFn: mkBuild() },
    );

    expect(result.reply).toBe('回答正文');
    expect('primary_view' in result).toBe(false);
    const replyCall = writeEventFn.mock.calls[1]?.[1] as { payload?: Record<string, unknown> };
    expect(replyCall?.payload?.reply_md).toBe('回答正文');
    expect(replyCall?.payload).not.toHaveProperty('primary_view');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed primary_view marker'),
      expect.objectContaining({ task_run_id: 'task_pv' }),
    );
    warnSpy.mockRestore();
  });

  it('T3: lenient validation — bad source / ref shape / over-cap ephemeral_html → absent + stripped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badMarkers = [
      '<!--primary_view:{"source":"bogus","ref":{"kind":"a","id":"b"}}-->',
      '<!--primary_view:{"source":"artifact","ref":"not-an-object"}-->',
      '<!--primary_view:{"source":"tool_result","ref":{"kind":"","id":"x"}}-->',
      `<!--primary_view:{"source":"ephemeral_html","ref":"${'x'.repeat(32_001)}"}-->`,
    ];
    for (const marker of badMarkers) {
      const out = extractPrimaryView(`body\n${marker}`, { taskRunId: 't' });
      expect(out.primaryView).toBeUndefined();
      expect(out.text).toBe('body');
    }
    expect(warnSpy).toHaveBeenCalledTimes(badMarkers.length);
    warnSpy.mockRestore();
  });

  it('parses the tool_result + ephemeral_html sources too (all three ruled variants)', () => {
    const tr = extractPrimaryView(
      'x\n<!--primary_view:{"source":"tool_result","ref":{"kind":"tool_call","id":"tc_1"}}-->',
      { taskRunId: 't' },
    );
    expect(tr.primaryView).toEqual({
      source: 'tool_result',
      ref: { kind: 'tool_call', id: 'tc_1' },
    });
    const eh = extractPrimaryView(
      'x\n<!--primary_view:{"source":"ephemeral_html","ref":"<div>hi</div>"}-->',
      { taskRunId: 't' },
    );
    expect(eh.primaryView).toEqual({ source: 'ephemeral_html', ref: '<div>hi</div>' });
  });

  it('T4: no marker → result and payload have NO primary_view key (byte-compat pin)', async () => {
    const runAgentTaskFn = mkRunFn('普通回答，无提名。');
    const writeEventFn = mkWrite();

    const result = await runCopilotChat(
      {} as never,
      { user_message: '答疑', triggered_by: 'chat' },
      { ...baseDeps, runAgentTaskFn, writeEventFn, buildMcpServerFn: mkBuild() },
    );

    expect(result.reply).toBe('普通回答，无提名。');
    expect('primary_view' in result).toBe(false);
    const replyCall = writeEventFn.mock.calls[1]?.[1] as { payload?: Record<string, unknown> };
    expect(Object.keys(replyCall?.payload ?? {})).not.toContain('primary_view');
  });

  it('T5: multiple markers → the LAST valid one wins; ALL occurrences stripped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first =
      '<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_first"}}-->';
    const bad = '<!--primary_view:{nope}-->';
    const last = '<!--primary_view:{"source":"artifact","ref":{"kind":"quiz","id":"qz_last"}}-->';
    const out = extractPrimaryView(`a ${first} b ${bad} c\n${last}`, { taskRunId: 't' });
    expect(out.primaryView).toEqual({ source: 'artifact', ref: { kind: 'quiz', id: 'qz_last' } });
    expect(out.text).toBe('a  b  c');
    expect(out.text).not.toContain('primary_view');
    warnSpy.mockRestore();
  });

  it('T6: streaming — terminal result carries primary_view + cleaned reply; persisted payload matches non-stream', async () => {
    const fullText = `这是你的题。\n${VALID_MARKER}`;
    const streamAgentTaskFn = vi.fn(
      async (_k: string, _i: unknown, _c: unknown, onDelta: (t: string) => void) => {
        onDelta(fullText);
        return {
          task_run_id: 'task_pv',
          text: fullText,
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const writeEventFnStream = mkWrite();
    const deltas: string[] = [];

    const result = await runCopilotChatStreaming(
      {} as never,
      { user_message: '出一道题', triggered_by: 'chat' },
      (t) => deltas.push(t),
      {
        ...baseDeps,
        streamAgentTaskFn,
        writeEventFn: writeEventFnStream,
        buildMcpServerFn: mkBuild(),
      },
    );

    expect(result.primary_view).toEqual({
      source: 'artifact',
      ref: { kind: 'question', id: 'q_abc' },
    });
    expect(result.reply).toBe('这是你的题。');
    // The live deltas never carried the marker (server-side tail-filter).
    expect(deltas.join('')).toBe('这是你的题。\n');

    // Persisted payload is identical to the non-stream path for the same text
    // (modulo in_reply_to_event_id, which embeds the per-run ask event cuid).
    const writeEventFnJson = mkWrite();
    await runCopilotChat(
      {} as never,
      { user_message: '出一道题', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn: mkRunFn(fullText),
        writeEventFn: writeEventFnJson,
        buildMcpServerFn: mkBuild(),
      },
    );
    const streamPayload = (writeEventFnStream.mock.calls[1]?.[1] as { payload?: unknown })
      ?.payload as Record<string, unknown>;
    const jsonPayload = (writeEventFnJson.mock.calls[1]?.[1] as { payload?: unknown })
      ?.payload as Record<string, unknown>;
    const { in_reply_to_event_id: _s, ...streamRest } = streamPayload;
    const { in_reply_to_event_id: _j, ...jsonRest } = jsonPayload;
    expect(streamRest).toEqual(jsonRest);
  });

  it('tail-filter (a): a marker split across deltas never reaches onDelta', async () => {
    const parts = [
      '回答正文',
      '<!--primary_',
      'view:{"source":"artifact","ref":{"kind":"question","id":"q1"}}-->',
    ];
    const fullText = parts.join('');
    const streamAgentTaskFn = vi.fn(
      async (_k: string, _i: unknown, _c: unknown, onDelta: (t: string) => void) => {
        for (const p of parts) onDelta(p);
        return {
          task_run_id: 'task_split',
          text: fullText,
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const deltas: string[] = [];

    const result = await runCopilotChatStreaming(
      {} as never,
      { user_message: '出题', triggered_by: 'chat' },
      (t) => deltas.push(t),
      { ...baseDeps, streamAgentTaskFn, writeEventFn: mkWrite(), buildMcpServerFn: mkBuild() },
    );

    expect(deltas.join('')).toBe('回答正文');
    expect(deltas.join('')).not.toContain('<!--');
    expect(result.primary_view).toEqual({
      source: 'artifact',
      ref: { kind: 'question', id: 'q1' },
    });
    expect(result.reply).toBe('回答正文');
  });

  it('tail-filter (b): clean text passes through byte-identical', async () => {
    const parts = ['你好', '，这是', '普通回复。'];
    const streamAgentTaskFn = vi.fn(
      async (_k: string, _i: unknown, _c: unknown, onDelta: (t: string) => void) => {
        for (const p of parts) onDelta(p);
        return {
          task_run_id: 'task_clean',
          text: parts.join(''),
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const deltas: string[] = [];

    await runCopilotChatStreaming(
      {} as never,
      { user_message: '聊聊', triggered_by: 'chat' },
      (t) => deltas.push(t),
      { ...baseDeps, streamAgentTaskFn, writeEventFn: mkWrite(), buildMcpServerFn: mkBuild() },
    );

    expect(deltas).toEqual(parts);
  });

  it('tail-filter (c): a prefix lookalike that never completes is reconciled by the terminal reply', async () => {
    const fullText = '结尾是<!--pri';
    const streamAgentTaskFn = vi.fn(
      async (_k: string, _i: unknown, _c: unknown, onDelta: (t: string) => void) => {
        onDelta(fullText);
        return {
          task_run_id: 'task_lookalike',
          text: fullText,
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    );
    const deltas: string[] = [];

    const result = await runCopilotChatStreaming(
      {} as never,
      { user_message: '聊聊', triggered_by: 'chat' },
      (t) => deltas.push(t),
      { ...baseDeps, streamAgentTaskFn, writeEventFn: mkWrite(), buildMcpServerFn: mkBuild() },
    );

    // The ambiguous tail is held back from the live stream (a bounded under-emit)…
    expect(deltas.join('')).toBe('结尾是');
    // …and the authoritative terminal reply restores the FULL text: no complete
    // marker means extractPrimaryView leaves the text untouched (no trim, no field).
    expect(result.reply).toBe('结尾是<!--pri');
    expect('primary_view' in result).toBe(false);
  });

  it('T7: teaching behavior-pack turn never carries primary_view (deterministic service reply)', async () => {
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
    const writeEventFn = mkWrite();
    const runTeachingSkillFn = vi.fn(async () => ({
      text_md: '讲解。',
      kind: 'explain' as const,
      suggested_next: 'continue' as const,
      task_run_id: 'task_teach_pv',
    }));

    const result = await runCopilotChat(
      db,
      {
        user_message: '讲讲',
        triggered_by: 'chat',
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_pv' } },
      },
      { ...baseDeps, writeEventFn, runTeachingSkillFn, buildMcpServerFn: mkBuild() },
    );

    expect('primary_view' in result).toBe(false);
    const replyCall = writeEventFn.mock.calls[1]?.[1] as { payload?: Record<string, unknown> };
    expect(JSON.stringify(replyCall?.payload)).not.toContain('primary_view');
  });

  it('T8a 防循环: a polluted history row carrying primary_view never leaks into the run input', async () => {
    const runAgentTaskFn = mkRunFn('OK');
    const polluted = {
      role: 'ai' as const,
      text: 'a prior reply body',
      at: '2026-06-09T00:00:00.000Z',
      event_id: 'e_pv',
      primary_view: { source: 'artifact', ref: { kind: 'question', id: 'SENTINEL_PV_q' } },
    } as never;

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: mkWrite(),
        buildMcpServerFn: mkBuild(),
        loadHistoryFn: async () => [polluted],
      },
    );

    const input = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      conversation_history: Array<Record<string, unknown>>;
    };
    // {role, text} ONLY — the structural strip keeps primary_view out of the prompt.
    expect(input.conversation_history).toEqual([{ role: 'ai', text: 'a prior reply body' }]);
    const serialized = JSON.stringify(input.conversation_history);
    expect(serialized).not.toContain('SENTINEL_PV_q');
    expect(serialized).not.toContain('primary_view');
  });

  it('T8b 防循环回灌: a marker-bearing reply, persisted then replayed as history, re-enters NO marker syntax', async () => {
    // Turn 1: the model emits a marker; chat.ts strips it from reply_md and
    // persists the nomination as a payload sibling.
    const writeEventFn1 = mkWrite();
    await runCopilotChat(
      {} as never,
      { user_message: '出题', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn: mkRunFn(`这是你的题。\n${VALID_MARKER}`),
        writeEventFn: writeEventFn1,
        buildMcpServerFn: mkBuild(),
      },
    );
    const persisted = (
      writeEventFn1.mock.calls[1]?.[1] as {
        payload?: { reply_md?: string; primary_view?: unknown };
      }
    )?.payload;
    expect(persisted?.primary_view).toBeDefined();

    // Turn 2: feed the persisted turn back exactly as getRecentCopilotTurns
    // surfaces it (text = the CLEANED reply_md; primary_view as a sibling field).
    const replayedTurn = {
      role: 'ai' as const,
      text: persisted?.reply_md ?? '',
      at: '2026-06-10T00:00:01.000Z',
      event_id: 'e_replayed',
      primary_view: persisted?.primary_view,
    } as never;
    const runAgentTaskFn2 = mkRunFn('OK');
    await runCopilotChat(
      {} as never,
      { user_message: '再来一题', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn: runAgentTaskFn2,
        writeEventFn: mkWrite(),
        buildMcpServerFn: mkBuild(),
        loadHistoryFn: async () => [replayedTurn],
      },
    );

    const input2 = (runAgentTaskFn2.mock.calls[0] as unknown as unknown[])[1] as {
      conversation_history: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(input2.conversation_history);
    // Neither the marker syntax nor the field name survives into the prompt path.
    expect(serialized).not.toContain('<!--');
    expect(serialized).not.toContain('primary_view');
    // The reply BODY does flow as ordinary history text (that is the C2 contract).
    expect(serialized).toContain('这是你的题。');
  });
});
