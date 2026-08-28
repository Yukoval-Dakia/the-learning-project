import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDomainToolNames, resolveMcpAllowedTools } from '@/kernel/tools/allowlists';
import { COPILOT_HISTORY_BUDGET } from '@/kernel/tools/budgets';
import { TAVILY_MCP_ALLOWED_TOOLS, buildTavilyMcpServer } from '@/server/ai/mcp/tavily';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  CopilotChatRequest,
  extractPrimaryView,
  runCopilotChat,
  runCopilotChatStreaming,
} from './chat';
import { COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY } from './content-validation';

describe('runCopilotChat (two-surface routing)', () => {
  it('replaces a question-bearing direct reply when the validation marker is missing', async () => {
    const result = await runCopilotChat(
      {} as never,
      { user_message: '给我一道题', triggered_by: 'chat' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: vi.fn(async () => ({
          task_run_id: 'task_missing_marker',
          text: '题目\n1. 求 1+1？',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        })),
        writeEventFn: vi.fn(async (_db, input) => input.id),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_missing_marker', created: true }),
      },
    );

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(result.reply).not.toContain('1+1');
  });

  it('blocks assessed ephemeral HTML when the learning-content marker is missing', async () => {
    const html = '<section><p>1. 求 17×19？</p><p>17×20-17=323</p></section>';
    const marker = `<!--primary_view:${JSON.stringify({ source: 'ephemeral_html', ref: html })}-->`;

    const result = await runCopilotChat(
      {} as never,
      { user_message: '给我一道乘法题', triggered_by: 'chat' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: vi.fn(async () => ({
          task_run_id: 'task_ephemeral_assessment_without_manifest',
          text: `请在卡片里作答。\n${marker}`,
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        })),
        writeEventFn: vi.fn(async (_db, input) => input.id),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_ephemeral_assessment_without_manifest',
          created: true,
        }),
      },
    );

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(result).not.toHaveProperty('primary_view');
  });

  it.each([
    {
      label: 'numeric character references',
      html: '<section><h2>&#39064;&#30446;</h2><p>17×19？</p><p>&#31572;&#26696;&#65306;323</p></section>',
    },
    {
      label: 'inline tags splitting assessment labels',
      html: '<section><h2>题<span>目</span></h2><p>17×19？</p><p>答<span>案</span>：323</p></section>',
    },
  ])('blocks assessed ephemeral HTML hidden with $label', async ({ html }) => {
    const marker = `<!--primary_view:${JSON.stringify({ source: 'ephemeral_html', ref: html })}-->`;

    const result = await runCopilotChat(
      {} as never,
      { user_message: '给我一道乘法题', triggered_by: 'chat' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: vi.fn(async () => ({
          task_run_id: 'task_obfuscated_ephemeral_assessment',
          text: `请在卡片里作答。\n${marker}`,
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        })),
        writeEventFn: vi.fn(async (_db, input) => input.id),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_obfuscated_ephemeral_assessment',
          created: true,
        }),
      },
    );

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(result).not.toHaveProperty('primary_view');
  });

  it('uses a bounded generic fallback when a validation provider rejects', async () => {
    const runner = vi.fn(async (kind: string) => {
      if (kind === 'CopilotTask') {
        return {
          task_run_id: 'task_provider_reject',
          text: '题目\n1. 求 1+1？\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1？","reference_md":"2","choices_md":null,"rubric_json":{}}]}-->',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      }
      throw new Error('provider secret diagnostic');
    });

    const result = await runCopilotChat(
      {} as never,
      { user_message: '给我一道题', triggered_by: 'chat' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: runner,
        writeEventFn: vi.fn(async (_db, input) => input.id),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_provider_reject',
          created: true,
        }),
      },
    );

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(result.reply).not.toContain('provider secret diagnostic');
    expect(runner.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('settles to the same bounded fallback when validation is aborted by a timeout', async () => {
    const runner = vi.fn(async (kind: string) => {
      if (kind === 'CopilotTask') {
        return {
          task_run_id: 'task_validation_timeout',
          text: '题目\n1. 求 2+2？\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 2+2？","reference_md":"4","choices_md":null,"rubric_json":{}}]}-->',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      }
      throw new DOMException('validation deadline exceeded', 'AbortError');
    });

    const result = await Promise.race([
      runCopilotChat(
        {} as never,
        { user_message: '给我一道题', triggered_by: 'chat' },
        {
          buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
          runAgentTaskFn: runner,
          writeEventFn: vi.fn(async (_db, input) => input.id),
          resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
          findOrCreateConversationFn: async () => ({
            sessionId: 'ls_validation_timeout',
            created: true,
          }),
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('validation fallback did not settle')), 500),
      ),
    ]);

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(result.reply).not.toContain('validation deadline exceeded');
    expect(runner.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('rejects a marker whose manifest question differs from the visible reply', async () => {
    const runner = vi.fn(async () => ({
      task_run_id: 'task_mismatched_manifest',
      text: '题目\n1. 求 1+1？\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 2+2？","reference_md":"4","choices_md":null,"rubric_json":{}}]}-->',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const result = await runCopilotChat(
      {} as never,
      { user_message: '给我一道题', triggered_by: 'chat' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: runner,
        writeEventFn: vi.fn(async (_db, input) => input.id),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_mismatched_manifest',
          created: true,
        }),
      },
    );

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('requires a marker for a worked solution to the user question', async () => {
    const result = await runCopilotChat(
      {} as never,
      { user_message: '请计算 1+1。', triggered_by: 'chat' },
      {
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        runAgentTaskFn: vi.fn(async () => ({
          task_run_id: 'task_solution_without_marker',
          text: '解：1+1=3。',
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 2 },
        })),
        writeEventFn: vi.fn(async (_db, input) => input.id),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_solution_without_marker',
          created: true,
        }),
      },
    );

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
  });

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
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
        allowedTools: resolveMcpAllowedTools('copilot'),
        taskRunId: expect.stringMatching(/^copilot_task_/),
      }),
    );

    const mcpOptions = (buildMcpServerFn.mock.calls[0] as unknown as [BuildMcpServerOptions])[0];
    const mcpCtx = mcpOptions.ctx;
    const runnerCtx = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
      taskRunId?: string;
      lifecycleAbortController?: AbortController;
      hooks?: Options['hooks'];
    };
    expect(runnerCtx?.taskRunId).toBe(mcpCtx?.taskRunId);
    expect(runnerCtx.lifecycleAbortController).toBeInstanceOf(AbortController);
    expect(mcpCtx.signal).toBe(runnerCtx.lifecycleAbortController?.signal);
    expect(mcpCtx.sessionId).toBe('ls_unit');
    expect(mcpOptions.cancellationSignals).toEqual([
      { signal: runnerCtx.lifecycleAbortController?.signal, requestedBy: 'system' },
    ]);
    const correlationHook = runnerCtx.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    await correlationHook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'sdk_session',
        transcript_path: '/tmp/transcript',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'mcp__loom__search_memory_facts',
        tool_input: { query: 'correlated production call', topK: 7 },
        tool_use_id: 'toolu_inline_real_7',
      },
      'toolu_inline_real_7',
      { signal: new AbortController().signal },
    );
    expect(
      mcpOptions.claimToolUseId?.('search_memory_facts', {
        topK: 7,
        query: 'correlated production call',
      }),
    ).toBe('toolu_inline_real_7');
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
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
  // the captured hooks: warning at 10 with no stop, hard stop after 25, and
  // row warning without cap followed by hard truncation (graceful, not throw).
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
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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

    // Calls 1–25 execute. At 10 the interceptor returns an advisory notice;
    // only call 26 soft-stops.
    for (let i = 0; i < 10; i += 1) {
      expect(opts.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toBeUndefined();
    }
    const warning = opts.interceptInput(
      { name: 'get_subject_graph_overview', effect: 'read' },
      { subjectId: 'yuwen' },
    );
    expect(warning.truncationNote).toMatchObject({
      level: 'warning',
      truncated: false,
      dimensions: { toolCalls: { used: 10, hard_remaining: 15 } },
    });
    for (let i = 10; i < 25; i += 1) {
      expect(opts.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toBeUndefined();
    }
    expect(opts.beforeExecute({ name: 'query_knowledge', effect: 'read' })).toMatch(
      /hard context budget reached/,
    );

    // Run a fresh turn for row budgets (per-message tracker, spec §3.4).
    await runCopilotChat(
      db,
      { user_message: '展开子图', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        // AF S3a / YUK-203 U3 — stub the conversation envelope so the {}-stub db
        // is never touched (these are pure routing/wiring unit tests).
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );
    const opts2 = buildMcpServerFn.mock.calls[1]?.[0];
    if (!opts2?.interceptInput) throw new Error('expected interceptInput on second turn');
    const warned = opts2.interceptInput(
      { name: 'expand_knowledge_subgraph', effect: 'read' },
      { centerNodeId: 'k_1', maxNodes: 300 },
    );
    expect((warned.args as { maxNodes: number }).maxNodes).toBe(300);
    expect(warned.truncationNote).toMatchObject({ level: 'warning', truncated: false });

    const capped = opts2.interceptInput(
      { name: 'expand_knowledge_subgraph', effect: 'read' },
      { centerNodeId: 'k_1', maxNodes: 9999 },
    );
    expect((capped.args as { maxNodes: number }).maxNodes).toBe(700);
    expect(capped.truncationNote).toMatchObject({
      level: 'hard',
      truncated: true,
      applied_limit: 700,
    });
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
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
        allowedTools: resolveMcpAllowedTools('copilot_user_suggested_mistake_action'),
      }),
    );
  });

  // YUK-574 (Facet A migration) — the `proposal_feedback` digest is no longer read
  // per turn; it rides on the session-anchored learner-state block resolved by
  // resolveLearnerStateHeaderFn. chat.ts forwards the resolver's scoped cells
  // verbatim into the CopilotTask run input as `proposal_feedback` (its OWN field,
  // NOT folded into conversation_history). The scope/order/truncation logic itself
  // is unit-tested in learner-state.unit.test.ts (scopeCopilotProposalFeedback).
  it('forwards the resolver-supplied proposal_feedback digest into the CopilotTask input', async () => {
    const db = {} as never;
    const buildMcpServerFn = vi.fn(
      (_opts: BuildMcpServerOptions) => ({ name: 'fake-loom' }) as never,
    );
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_feedback',
      text: 'OK',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const digest = [
      {
        kind: 'knowledge_edge' as const,
        relation: 'related_to',
        acceptance_rate: 0.1,
        top_dismiss_reasons: ['dumping ground'],
        top_rubric_gates: ['related_to_dumping_ground'],
      },
    ];

    await runCopilotChat(
      db,
      { user_message: '能不能连一条边', triggered_by: 'chat' },
      {
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn,
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: digest }),
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_unit', created: true }),
        loadHistoryFn: async () => [],
        now: () => new Date('2026-05-31T00:00:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      proposal_feedback: unknown[];
      conversation_history: unknown[];
    };
    expect(taskInput.proposal_feedback).toEqual(digest);
    // proposal_feedback is its OWN field, not folded into conversation_history.
    expect(JSON.stringify(taskInput.conversation_history)).not.toContain('dumping ground');
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
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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

  it('clarifies instead of passing through a silent rewrite with multiple implicit candidates', async () => {
    const db = {} as never;
    const batteryReplyId = 'copilot_reply_battery_d04';
    const waterTankReplyId = 'copilot_reply_water_tank_d02';
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_d05',
      text: '已把上一轮改正为 h*=4/9，k 不变。',
    }));
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCopilotChat(
      db,
      { user_message: '上一轮的水箱题请改正 h*=4/9，k 不变', triggered_by: 'chat' },
      {
        buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
        runAgentTaskFn,
        writeEventFn,
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_d04_d05', created: false }),
        loadHistoryFn: async () => [
          {
            role: 'ai',
            text: '水箱 D02：h*=4/9，使用同一个 k。',
            at: '2026-08-01T10:00:00.000Z',
            event_id: waterTankReplyId,
          },
          {
            role: 'ai',
            text: '电池 D04：先按当前电量估算。',
            at: '2026-08-01T10:01:00.000Z',
            event_id: batteryReplyId,
          },
        ],
        resolveImplicitCorrectionIntentFn: async () => ({
          intent: 'correction',
          candidate_prior_turn_ids: [waterTankReplyId, batteryReplyId],
        }),
        now: () => new Date('2026-08-01T10:02:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      conversation_history: Array<{ event_id?: string }>;
      correction_contract?: { target_prior_turn_id?: string };
    };
    expect(taskInput.conversation_history.map((turn) => turn.event_id)).toEqual([
      waterTankReplyId,
      batteryReplyId,
    ]);
    expect(taskInput.correction_contract?.target_prior_turn_id).toBeUndefined();
    const taskContext = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
      allowedTools?: string[];
    };
    expect(taskContext.allowedTools).toEqual([]);
    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).toContain(waterTankReplyId);
    expect(result.reply).not.toContain('已把上一轮改正');
  });

  it('binds an unambiguous implicit correction before generating the reply', async () => {
    const db = {} as never;
    const batteryReplyId = 'copilot_reply_battery_d04';
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_implicit_single',
      text: `电池题更正后的解释。\n\n<!-- copilot-correction {"prior_turn_id":"${batteryReplyId}","changed":["改用额定容量"],"retained":["温度假设"],"uncertain":[]} -->`,
    }));

    const result = await runCopilotChat(
      db,
      { user_message: '上一题再按额定容量改一下', triggered_by: 'chat' },
      {
        buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
        runAgentTaskFn,
        writeEventFn: async (_db, input) => input.id,
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_implicit_single',
          created: false,
        }),
        loadHistoryFn: async () => [
          {
            role: 'ai',
            text: '电池 D04：先按当前电量估算。',
            at: '2026-08-01T10:01:00.000Z',
            event_id: batteryReplyId,
          },
        ],
        resolveImplicitCorrectionIntentFn: async () => ({
          intent: 'correction',
          candidate_prior_turn_ids: [batteryReplyId],
        }),
        now: () => new Date('2026-08-01T10:02:00.000Z'),
      },
    );

    const taskInput = (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      correction_contract?: { target_prior_turn_id?: string };
    };
    expect(taskInput.correction_contract?.target_prior_turn_id).toBe(batteryReplyId);
    expect(result.reply).toContain(`更正目标 prior_turn_id：${batteryReplyId}`);
  });

  it('keeps an ordinary follow-up normal when several prior replies exist', async () => {
    const db = {} as never;
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_ordinary_followup',
      text: '可以，我们继续比较两种方法。',
    }));

    const result = await runCopilotChat(
      db,
      { user_message: '这两种方法的差别是什么？', triggered_by: 'chat' },
      {
        buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
        runAgentTaskFn,
        writeEventFn: async (_db, input) => input.id,
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_ordinary', created: false }),
        loadHistoryFn: async () => [
          {
            role: 'ai',
            text: '方法一：先列方程。',
            at: '2026-08-01T10:00:00.000Z',
            event_id: 'copilot_reply_method_one',
          },
          {
            role: 'ai',
            text: '方法二：先画图。',
            at: '2026-08-01T10:01:00.000Z',
            event_id: 'copilot_reply_method_two',
          },
        ],
        resolveImplicitCorrectionIntentFn: async () => ({ intent: 'not_correction' }),
        now: () => new Date('2026-08-01T10:02:00.000Z'),
      },
    );

    expect(result.reply).toBe('可以，我们继续比较两种方法。');
  });

  it('fails closed when a targeted correction omits its envelope', async () => {
    const db = {} as never;
    const batteryReplyId = 'copilot_reply_battery_d04';
    const waterTankReplyId = 'copilot_reply_water_tank_d02';
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 'task_copilot_target_without_envelope',
      text: '已把水箱题改正为 h*=4/9，k 不变。',
    }));

    const result = await runCopilotChat(
      db,
      {
        user_message: '请改正水箱题',
        triggered_by: 'chat',
        correction_target_turn_id: waterTankReplyId,
      },
      {
        buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
        runAgentTaskFn,
        writeEventFn: async (_db, input) => input.id,
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        findOrCreateConversationFn: async () => ({ sessionId: 'ls_targeted', created: false }),
        loadHistoryFn: async () => [
          {
            role: 'ai',
            text: '水箱 D02：h*=4/9，使用同一个 k。',
            at: '2026-08-01T10:00:00.000Z',
            event_id: waterTankReplyId,
          },
          {
            role: 'ai',
            text: '电池 D04：先按当前电量估算。',
            at: '2026-08-01T10:01:00.000Z',
            event_id: batteryReplyId,
          },
        ],
        now: () => new Date('2026-08-01T10:02:00.000Z'),
      },
    );

    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).not.toContain('已把水箱题改正');
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
          resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
          resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
      expect(ctx.allowedTools).toEqual(resolveMcpAllowedTools('copilot'));
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
          resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
          resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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

describe('YUK-832 inline final evidence review', () => {
  const request = {
    user_message:
      '核完 diagnostic_subject_A03 的 proposal→probe/review/judge 链，并判断 C04 due queue 是否清空。',
    triggered_by: 'chat' as const,
    ambient_context: {
      route: '/admin/runs',
      focused_entity: { kind: 'subject', id: 'diagnostic_subject_A03' },
    },
  };

  function baseEvidenceDeps() {
    return {
      findOrCreateConversationFn: async () => ({ sessionId: 'ls_yuk832', created: true }),
      resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
      loadHistoryFn: async () => [],
      resolveCopilotSkillsFn: async () => undefined,
      buildTavilyMcpServerFn: () => null,
      copilotSubagentEnabled: false,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    };
  }

  it('keeps raw chunks invisible, persists the repair, then emits only reviewed prose', async () => {
    const visibleDeltas: string[] = [];
    const order: string[] = [];
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-yuk832' } as never;
    });
    const unsafeCandidate = '六个事件形成完整充分因果链；C04 返回 0 行，所以整个队列已清空。';
    const rawUnsafeCandidate = `${unsafeCandidate}\n<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_unsafe"}}-->`;
    const safeReply =
      'probe 与 rate 只能证明是 proposal 的直接子节点，不是彼此因果链。C04 的 queue_assertion=null，无法裁决队列是否清空。';
    const streamAgentTaskFn = vi.fn(async (_kind, _input, _ctx, onDelta) => {
      await mcpOptions?.onResult?.({
        name: 'query_events',
        effect: 'read',
        input: { subject_id: 'diagnostic_subject_A03', limit: 50 },
        output: {
          query_contract: {
            scope_coverage: 'blocked_cross_subject_relation_followup_required',
          },
          events: [
            {
              id: 'evt_probe_a03',
              caused_by_event_id: 'evt_proposal_a03',
              evidence: {
                activation_policy: 'not_observed',
                necessary_conditions: 'not_supported',
                sufficient_conditions: 'not_supported',
              },
            },
          ],
          has_more: false,
        },
        error_reason: null,
        executed: true,
      });
      onDelta('六个事件形成完整充分因果链；');
      onDelta('C04 返回 0 行，所以整个队列已清空。');
      expect(visibleDeltas).toEqual([]);
      return {
        text: rawUnsafeCandidate,
        task_run_id: 'copilot_task_yuk832_inline',
        finishReason: 'stop',
        usage: { inputTokens: 18_000, outputTokens: 1_200 },
      };
    });
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      order.push('review');
      expect(visibleDeltas).toEqual([]);
      expect(input).toMatchObject({
        candidateReply: unsafeCandidate,
        candidateComplete: true,
        toolTrace: [expect.objectContaining({ name: 'query_events', effect: 'read' })],
        requestContext: {
          user_message: request.user_message,
          surface: 'copilot',
          triggered_by: 'chat',
          ambient_context: request.ambient_context,
        },
      });
      expect(input.requestContext).not.toHaveProperty('conversation_history');
      return {
        status: 'repair' as const,
        replyText: safeReply,
        reviewTaskRunId: 'copilot_evidence_review_inline',
        referenceTaskRunIds: ['copilot_evidence_reference_inline'],
        comparisonTaskRunIds: [
          'copilot_evidence_original_rejected_inline',
          'copilot_evidence_fallback_pass_1_inline',
          'copilot_evidence_fallback_pass_2_inline',
        ],
        violations: ['noncausal_relation', 'queue_or_count_unknown_promoted'],
      };
    });
    const writeEventFn = vi.fn(async (_db, input) => {
      if (input.action === 'experimental:copilot_reply') order.push('persist');
      return input.id;
    });

    const result = await runCopilotChatStreaming(
      {} as never,
      request,
      (text) => {
        order.push('delta');
        visibleDeltas.push(text);
      },
      {
        ...baseEvidenceDeps(),
        writeEventFn,
        buildMcpServerFn,
        streamAgentTaskFn,
        reviewEvidenceReplyFn,
      },
    );

    expect(order).toEqual(['review', 'persist', 'delta']);
    expect(visibleDeltas).toEqual([safeReply]);
    expect(result.reply).toBe(safeReply);
    const persistedReply = writeEventFn.mock.calls.find(
      (call) => call[1].action === 'experimental:copilot_reply',
    )?.[1];
    expect(persistedReply.payload.reply_md).toBe(safeReply);
    expect(persistedReply.payload.evidence_validation).toEqual({
      status: 'repair',
      reference_task_run_ids: ['copilot_evidence_reference_inline'],
      comparison_task_run_ids: [
        'copilot_evidence_original_rejected_inline',
        'copilot_evidence_fallback_pass_1_inline',
        'copilot_evidence_fallback_pass_2_inline',
      ],
    });
    expect(JSON.stringify(persistedReply)).not.toContain(unsafeCandidate);
    expect(result).not.toHaveProperty('primary_view');
    expect(persistedReply.payload).not.toHaveProperty('primary_view');
  });

  it('blocks unverified learning content introduced by a degraded blind reply', async () => {
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-degraded-learning' } as never;
    });
    const runAgentTaskFn = vi.fn(async () => {
      await mcpOptions?.onResult?.({
        name: 'query_events',
        effect: 'read',
        input: { subject_id: 'degraded_learning_subject' },
        output: { events: [], has_more: false },
        error_reason: null,
        executed: true,
      });
      return {
        task_run_id: 'task_degraded_learning_inline',
        text: '现有证据不足以判断队列是否清空。',
      };
    });
    const unverifiedLearningReply = '题目：\n1. 请计算 17×19？';

    const result = await runCopilotChat({} as never, request, {
      ...baseEvidenceDeps(),
      buildMcpServerFn,
      runAgentTaskFn,
      writeEventFn: async (_db, input) => input.id,
      reviewEvidenceReplyFn: async () => ({
        status: 'degraded',
        replyText: unverifiedLearningReply,
      }),
    });

    expect(result.reply).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(result.reply).not.toContain(unverifiedLearningReply);
  });

  it('rejects an evidence repair that drops the targeted correction binding', async () => {
    const targetId = 'copilot_reply_water_tank_repair';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-correction-repair' } as never;
    });
    const runAgentTaskFn = vi.fn(async () => {
      await mcpOptions?.onResult?.({
        name: 'query_events',
        effect: 'read',
        input: { subject_id: 'water_tank_d02' },
        output: { events: [], has_more: false },
        error_reason: null,
        executed: true,
      });
      return {
        task_run_id: 'task_copilot_correction_repair',
        text: `水箱更正后的推导。\n\n<!-- copilot-correction {"prior_turn_id":"${targetId}","changed":["h*=4/9"],"retained":["同一个 k"],"uncertain":[]} -->`,
      };
    });
    const unsafeRepair = '证据修复后的正文，但没有 correction envelope。';

    const result = await runCopilotChat(
      {} as never,
      {
        user_message: '请核验并改正水箱题',
        triggered_by: 'chat',
        correction_target_turn_id: targetId,
      },
      {
        ...baseEvidenceDeps(),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_correction_repair',
          created: false,
        }),
        loadHistoryFn: async () => [
          {
            role: 'ai',
            text: '水箱 D02：原推导用了错误高度。',
            at: '2026-08-01T10:00:00.000Z',
            event_id: targetId,
          },
        ],
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn: async (_db, input) => input.id,
        reviewEvidenceReplyFn: async () => ({
          status: 'repair',
          replyText: unsafeRepair,
        }),
      },
    );

    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).not.toContain(unsafeRepair);
  });

  it('rejects a degraded blind reply that drops the targeted correction binding', async () => {
    const targetId = 'copilot_reply_water_tank_degraded';
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-correction-degraded' } as never;
    });
    const runAgentTaskFn = vi.fn(async () => {
      await mcpOptions?.onResult?.({
        name: 'query_events',
        effect: 'read',
        input: { subject_id: 'water_tank_d02' },
        output: { events: [], has_more: false },
        error_reason: null,
        executed: true,
      });
      return {
        task_run_id: 'task_copilot_correction_degraded',
        text: `水箱更正后的推导。\n\n<!-- copilot-correction {"prior_turn_id":"${targetId}","changed":["h*=4/9"],"retained":["同一个 k"],"uncertain":[]} -->`,
      };
    });
    const unboundDegradedReply = '盲审替换正文，但没有 correction envelope。';

    const result = await runCopilotChat(
      {} as never,
      {
        user_message: '请核验并改正水箱题',
        triggered_by: 'chat',
        correction_target_turn_id: targetId,
      },
      {
        ...baseEvidenceDeps(),
        findOrCreateConversationFn: async () => ({
          sessionId: 'ls_correction_degraded',
          created: false,
        }),
        loadHistoryFn: async () => [
          {
            role: 'ai',
            text: '水箱 D02：原推导用了错误高度。',
            at: '2026-08-01T10:00:00.000Z',
            event_id: targetId,
          },
        ],
        buildMcpServerFn,
        runAgentTaskFn,
        writeEventFn: async (_db, input) => input.id,
        reviewEvidenceReplyFn: async () => ({
          status: 'degraded',
          replyText: unboundDegradedReply,
        }),
      },
    );

    expect(result.reply).toContain('prior_turn_id');
    expect(result.reply).not.toContain(unboundDegradedReply);
  });

  it('reviews, persists, and publishes exact bytes while dropping an unreviewed primary-view side channel', async () => {
    const marker = '<!--primary_view:{"source":"ephemeral_html","ref":"<div>队列已清空</div>"}-->';
    const cleanedCandidate =
      'A03 中 probe 与 rate 都直接由 proposal 触发；现有记录没有证明 probe 导致 rate。';
    const rawCandidate = `${cleanedCandidate}\n${marker}`;
    const visibleDeltas: string[] = [];
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-yuk832-exact-bytes' } as never;
    });
    const streamAgentTaskFn = vi.fn(async (_kind, _input, _ctx, onDelta) => {
      await mcpOptions?.onResult?.({
        name: 'query_events',
        effect: 'read',
        input: { subject_id: 'diagnostic_subject_A03', limit: 50 },
        output: {
          events: [
            { id: 'evt_probe', caused_by_event_id: 'evt_proposal' },
            { id: 'evt_rate', caused_by_event_id: 'evt_proposal' },
          ],
          has_more: false,
        },
        error_reason: null,
        executed: true,
      });
      onDelta(cleanedCandidate.slice(0, 22));
      onDelta(`${cleanedCandidate.slice(22)}\n<!--primary_`);
      onDelta(marker.slice('<!--primary_'.length));
      return {
        text: rawCandidate,
        task_run_id: 'copilot_task_yuk832_exact_bytes',
        finishReason: 'stop',
        usage: { inputTokens: 12_400, outputTokens: 680 },
      };
    });
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      expect(input.candidateReply).toBe(cleanedCandidate);
      return {
        status: 'pass' as const,
        replyText: input.candidateReply,
        referenceTaskRunIds: ['reference_exact_bytes'],
        comparisonTaskRunIds: ['compare_exact_bytes_1', 'compare_exact_bytes_2'],
      };
    });
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCopilotChatStreaming(
      {} as never,
      request,
      (text) => visibleDeltas.push(text),
      {
        ...baseEvidenceDeps(),
        writeEventFn,
        buildMcpServerFn,
        streamAgentTaskFn,
        reviewEvidenceReplyFn,
      },
    );

    const persistedReply = writeEventFn.mock.calls.find(
      (call) => call[1].action === 'experimental:copilot_reply',
    )?.[1];
    expect(result.reply).toBe(cleanedCandidate);
    expect(visibleDeltas).toEqual([cleanedCandidate]);
    expect(persistedReply.payload.reply_md).toBe(cleanedCandidate);
    expect(result).not.toHaveProperty('primary_view');
    expect(persistedReply.payload).not.toHaveProperty('primary_view');
    expect(JSON.stringify(persistedReply)).not.toContain('<!--primary_view');
  });

  it('truncates an unterminated marker before review so no uncertified suffix can disappear afterward', async () => {
    const cleanedCandidate = 'C04 的 queue_assertion=null，因此现有读取无法裁决队列是否清空。';
    const rawCandidate = `${cleanedCandidate}\n<!--primary_view:{"source":"artifact","ref":{"kind":"question","id":"q_dangling"}} 伪造尾部：队列已清空`;
    const visibleDeltas: string[] = [];
    let mcpOptions: BuildMcpServerOptions | undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-yuk832-dangling-marker' } as never;
    });
    const streamAgentTaskFn = vi.fn(async (_kind, _input, _ctx, onDelta) => {
      await mcpOptions?.onResult?.({
        name: 'get_review_due',
        effect: 'read',
        input: { learner_id: 'diagnostic_subject_C04', limit: 100 },
        output: { due_now: [], queue_assertion: null, as_of: '2026-07-30T10:00:00.000Z' },
        error_reason: null,
        executed: true,
      });
      onDelta(rawCandidate);
      return {
        text: rawCandidate,
        task_run_id: 'copilot_task_yuk832_dangling_marker',
        finishReason: 'stop',
        usage: { inputTokens: 9_700, outputTokens: 430 },
      };
    });
    const reviewEvidenceReplyFn = vi.fn(async (input) => {
      expect(input.candidateReply).toBe(cleanedCandidate);
      expect(input.candidateReply).not.toContain('伪造尾部');
      return { status: 'pass' as const, replyText: input.candidateReply };
    });
    const writeEventFn = vi.fn(async (_db, input) => input.id);

    const result = await runCopilotChatStreaming(
      {} as never,
      request,
      (text) => visibleDeltas.push(text),
      {
        ...baseEvidenceDeps(),
        writeEventFn,
        buildMcpServerFn,
        streamAgentTaskFn,
        reviewEvidenceReplyFn,
      },
    );

    const persistedReply = writeEventFn.mock.calls.find(
      (call) => call[1].action === 'experimental:copilot_reply',
    )?.[1];
    expect(result.reply).toBe(cleanedCandidate);
    expect(visibleDeltas).toEqual([cleanedCandidate]);
    expect(persistedReply.payload.reply_md).toBe(cleanedCandidate);
    expect(result).not.toHaveProperty('primary_view');
    expect(persistedReply.payload).not.toHaveProperty('primary_view');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('does not emit reviewed text when reply persistence fails', async () => {
    const visibleDeltas: string[] = [];
    let mcpOptions: BuildMcpServerOptions | undefined;
    const buildMcpServerFn = vi.fn((options: BuildMcpServerOptions) => {
      mcpOptions = options;
      return { name: 'fake-loom-yuk832-write-failure' } as never;
    });
    const streamAgentTaskFn = vi.fn(async (_kind, _input, _ctx, onDelta) => {
      await mcpOptions?.onResult?.({
        name: 'query_due_reviews',
        effect: 'read',
        input: { limit: 100 },
        output: { due_now: [], queue_assertion: null },
        error_reason: null,
        executed: true,
      });
      onDelta('队列已清空');
      return {
        text: '队列已清空',
        task_run_id: 'copilot_task_yuk832_write_failure',
        finishReason: 'stop',
        usage: { inputTokens: 9_000, outputTokens: 300 },
      };
    });
    const writeEventFn = vi.fn(async (_db, input) => {
      if (input.action === 'experimental:copilot_reply') throw new Error('reply write lost');
      return input.id;
    });

    await expect(
      runCopilotChatStreaming({} as never, request, (text) => visibleDeltas.push(text), {
        ...baseEvidenceDeps(),
        writeEventFn,
        buildMcpServerFn,
        streamAgentTaskFn,
        reviewEvidenceReplyFn: async () => ({
          status: 'repair',
          replyText: 'queue_assertion=null，无法裁决队列是否清空。',
          violations: ['queue_or_count_unknown_promoted'],
        }),
      }),
    ).rejects.toThrow('reply write lost');
    expect(visibleDeltas).toEqual([]);
  });

  it('does not persist or emit a certified reply when the client aborts before persistence', async () => {
    const controller = new AbortController();
    const visibleDeltas: string[] = [];
    const writeEventFn = vi.fn(async (_db, input) => input.id);
    const candidate = '本轮只返回本次 exact filter 的证据。';
    const streamAgentTaskFn = vi.fn(async (_kind, _input, _ctx, onDelta) => {
      onDelta(candidate);
      return {
        text: candidate,
        task_run_id: 'copilot_task_yuk832_abort_before_persist',
        finishReason: 'stop',
        usage: { inputTokens: 8_000, outputTokens: 160 },
      };
    });

    await expect(
      runCopilotChatStreaming(
        {} as never,
        request,
        (text) => visibleDeltas.push(text),
        {
          ...baseEvidenceDeps(),
          writeEventFn,
          buildMcpServerFn: () => ({ name: 'fake-yuk832-abort-before-persist' }) as never,
          streamAgentTaskFn,
          reviewEvidenceReplyFn: async () => {
            controller.abort(new DOMException('client disconnected', 'AbortError'));
            return { status: 'pass', replyText: candidate };
          },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(visibleDeltas).toEqual([]);
    expect(
      writeEventFn.mock.calls.some((call) => call[1].action === 'experimental:copilot_reply'),
    ).toBe(false);
  });

  it('keeps parent mailbox cancellation bound while post-model evidence review is pending', async () => {
    const controller = new AbortController();
    const cancellationTx = {
      select: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
    };
    const db = {
      transaction: vi.fn(async (callback: (tx: typeof cancellationTx) => Promise<unknown>) =>
        callback(cancellationTx),
      ),
    } as never;
    let markReviewStarted: (() => void) | undefined;
    const reviewStarted = new Promise<void>((resolve) => {
      markReviewStarted = resolve;
    });
    let releaseReview: ((value: { status: 'skipped'; replyText: string }) => void) | undefined;
    const reviewEvidenceReplyFn = vi.fn(
      () =>
        new Promise<{ status: 'skipped'; replyText: string }>((resolve) => {
          releaseReview = resolve;
          markReviewStarted?.();
        }),
    );
    const run = runCopilotChatStreaming(
      db,
      request,
      () => undefined,
      {
        ...baseEvidenceDeps(),
        writeEventFn: vi.fn(async (_db, input) => input.id),
        buildMcpServerFn: () => ({ name: 'fake-mailbox-lifetime' }) as never,
        streamAgentTaskFn: vi.fn(async () => ({
          text: '主模型已返回，等待证据审阅。',
          task_run_id: 'copilot_task_mailbox_lifetime',
          finishReason: 'stop' as const,
          usage: { inputTokens: 300, outputTokens: 40 },
        })),
        reviewEvidenceReplyFn,
      },
      controller.signal,
    );
    await reviewStarted;
    controller.abort(new DOMException('client disconnected', 'AbortError'));
    await vi.waitFor(() => expect(db.transaction).toHaveBeenCalledTimes(1));
    expect(releaseReview).toBeTypeOf('function');
    releaseReview?.({ status: 'skipped', replyText: '主模型已返回，等待证据审阅。' });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('YUK-932 Copilot durable researchers', () => {
  function baseSubagentDeps() {
    return {
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      buildTavilyMcpServerFn: () => null,
      writeEventFn: vi.fn(async (_db, input) => input.id),
      resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
      loadHistoryFn: async () => [],
      findOrCreateConversationFn: async () => ({ sessionId: 'ls_subagent_unit', created: true }),
      resolveCopilotSkillsFn: async () => ['copilot'],
      now: () => new Date('2026-08-01T09:00:00.000Z'),
    };
  }

  it('exposes the four mailbox DomainTools without mounting native SDK Task', async () => {
    let capturedCtx: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async (_kind, _input, ctx) => {
      capturedCtx = ctx as Record<string, unknown>;
      return {
        task_run_id: 'task_copilot_subagent_surface',
        text: '综合三份材料后，关键误区是把驻点当成极值点。',
        finishReason: 'stop',
        usage: { inputTokens: 5210, outputTokens: 844 },
      };
    });

    await runCopilotChat(
      {} as never,
      {
        user_message:
          '把我最近三份函数单调性错题、知识图谱和讲义交叉核对，解释为什么我总把驻点当极值点。',
        triggered_by: 'chat',
      },
      { ...baseSubagentDeps(), runAgentTaskFn },
    );

    expect(capturedCtx?.allowedTools).toEqual(
      expect.arrayContaining([
        'mcp__loom__launch_researcher',
        'mcp__loom__get_subagent',
        'mcp__loom__wait_subagent',
        'mcp__loom__cancel_subagent',
      ]),
    );
    expect(capturedCtx?.allowedTools).not.toContain('Task');
    expect(capturedCtx?.hooks).toHaveProperty('PreToolUse');
    expect(capturedCtx).not.toHaveProperty('agents');
    expect(capturedCtx).not.toHaveProperty('canUseTool');
    expect(capturedCtx).not.toHaveProperty('onTaskEvent');
  });

  it('does not let the legacy kill-switch input re-enable native Task', async () => {
    let capturedCtx: Record<string, unknown> | undefined;
    const runAgentTaskFn = vi.fn(async (_kind, _input, ctx) => {
      capturedCtx = ctx as Record<string, unknown>;
      return {
        task_run_id: 'task_copilot_killed_spawn',
        text: '我会在当前循环内完成。',
        finishReason: 'stop',
        usage: { inputTokens: 900, outputTokens: 120 },
      };
    });

    await runCopilotChat(
      {} as never,
      { user_message: '深入检查这份学习记录', triggered_by: 'chat' },
      { ...baseSubagentDeps(), runAgentTaskFn, copilotSubagentEnabled: true },
    );

    expect(capturedCtx?.allowedTools).not.toContain('Task');
    expect(capturedCtx).not.toHaveProperty('agents');
    expect(capturedCtx?.hooks).toMatchObject({ PreToolUse: expect.any(Array) });
    expect(capturedCtx).not.toHaveProperty('canUseTool');
    expect(capturedCtx).not.toHaveProperty('onTaskEvent');
  });

  it('does not project native SDK task lifecycle as public subtask UI', async () => {
    const onSubtaskEvent = vi.fn();
    const deltas: string[] = [];
    const streamAgentTaskFn = vi.fn(
      async (
        _kind: string,
        _input: unknown,
        ctx: Record<string, unknown>,
        onDelta: (text: string) => void,
      ) => {
        expect(ctx).not.toHaveProperty('onTaskEvent');
        expect(ctx).not.toHaveProperty('agents');
        expect(ctx).not.toHaveProperty('canUseTool');
        onDelta('我正在把证据收拢成一个解释。');
        onDelta('结论：你漏掉的是导数为零后仍需检查变号。');
        return {
          task_run_id: 'task_copilot_stream_subtasks',
          text: '我正在把证据收拢成一个解释。结论：你漏掉的是导数为零后仍需检查变号。',
          finishReason: 'stop',
          usage: { inputTokens: 7440, outputTokens: 960 },
        };
      },
    );

    await runCopilotChatStreaming(
      {} as never,
      {
        user_message: '深挖我在导数判号上的重复误区，再预览一道能区分这个误区的题。',
        triggered_by: 'chat',
      },
      (text) => deltas.push(text),
      { ...baseSubagentDeps(), streamAgentTaskFn, onSubtaskEvent },
    );

    expect(deltas).toEqual([
      '我正在把证据收拢成一个解释。结论：你漏掉的是导数为零后仍需检查变号。',
    ]);
    expect(onSubtaskEvent).not.toHaveBeenCalled();
  });
});

// AF S4 / YUK-203 U6 — skill routing. A skill_context turn runs a teaching/solve
// behavior pack at the service layer instead of the free-form CopilotTask loop.
// The surface stays 'copilot' (R5), the turn lives on the single Copilot session,
// and a teaching ask_check reply carries turn_kind for the corrective-chip anchor.
describe('runCopilotChat — skill routing (U6)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_copilot', created: false }),
    resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
        providerSessionDeadlineAt: 234_567,
      },
    );

    // Surface stays 'copilot' (R5: skill ≠ surface).
    expect(result.surface).toBe('copilot');
    // The skill ran against the resolved Copilot session id (no replyEventId param).
    expect(runTeachingSkillFn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ls_copilot',
        learningItemId: 'li_unit',
        providerSessionDeadlineAt: 234_567,
      }),
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
    // YUK-497 wave-2 (codex P2) — an ask_check that materialized a source='teaching_check' draft
    // question MUST NOT expose a revert checkpoint anchor: cascade revert only compensates the
    // ask/reply event chain, not that question row, so a Dock revert button would orphan the draft.
    // user_ask_event_id stays (provenance); checkpoint_event_id is suppressed.
    expect(result.user_ask_event_id).toBeDefined();
    expect(result.checkpoint_event_id).toBeUndefined();
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
    resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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

    // Token-loop generation still runs, but publication waits for persistence
    // and emits the exact selected bytes once.
    expect(streamAgentTaskFn).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['已为你组好一套练习']);
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
    resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
    resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
    const controller = new AbortController();

    const result = await runCopilotChatStreaming(
      db,
      { user_message: '解释一下「之」', triggered_by: 'chat' },
      (t) => deltas.push(t),
      {
        ...baseDeps,
        buildMcpServerFn,
        runAgentTaskFn,
        streamAgentTaskFn,
        writeEventFn,
        providerSessionDeadlineAt: 345_678,
      },
      controller.signal,
    );

    // onDelta fired with the chunk; the free-form token loop ran via the stream seam.
    expect(deltas).toEqual(['OK']);
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    expect(streamAgentTaskFn).toHaveBeenCalledTimes(1);
    const mcpCtx = (buildMcpServerFn.mock.calls[0] as unknown as [BuildMcpServerOptions])[0].ctx;
    const runnerCtx = (streamAgentTaskFn.mock.calls[0] as unknown as unknown[])[2] as {
      taskRunId?: string;
      signal?: AbortSignal;
      lifecycleAbortController?: AbortController;
      providerSessionDeadlineAt?: number;
    };
    expect(runnerCtx?.taskRunId).toBe(mcpCtx?.taskRunId);
    expect(runnerCtx?.signal).toBe(controller.signal);
    expect(runnerCtx.lifecycleAbortController).toBeInstanceOf(AbortController);
    expect(runnerCtx.providerSessionDeadlineAt).toBe(345_678);
    expect(mcpCtx?.signal).toBe(runnerCtx.lifecycleAbortController?.signal);
    expect(mcpCtx?.providerSessionDeadlineAt).toBe(345_678);

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
    resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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
      expect(Object.keys(entry).sort()).toEqual(
        entry.role === 'ai' ? ['event_id', 'role', 'text'] : ['role', 'text'],
      );
    }
    // Newest kept (tail-slice): the last entry is the newest turn.
    expect(input.conversation_history.at(-1)).toEqual({
      role: 'ai',
      text: 'turn 11',
      event_id: 'e_turn',
    });
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
    expect(input.conversation_history).toEqual([
      { role: 'ai', text: 'a reply body', event_id: 'e_a re' },
    ]);
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

  it('防循环 ③: proposal_feedback rides its OWN field (from the resolver), NOT mixed into history', async () => {
    const runAgentTaskFn = vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const writeEventFn = vi.fn(async (_db: unknown, input: { id: string }) => input.id);
    // YUK-574 — the digest now comes from the session-anchored learner-state
    // resolver (assemble-once), not a per-turn read. It must still land in the
    // dedicated proposal_feedback field and NEVER leak into conversation_history.
    const resolveLearnerStateHeaderFn = vi.fn(async () => ({
      header_md: '',
      proposal_feedback: [
        {
          kind: 'knowledge_edge' as const,
          relation: 'related_to',
          acceptance_rate: 0.5,
          top_dismiss_reasons: ['FEEDBACK_MARKER'],
          top_rubric_gates: [],
        },
      ],
    }));

    await runCopilotChat(
      {} as never,
      { user_message: '连边', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn,
        resolveLearnerStateHeaderFn,
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        loadHistoryFn: async () => [mkTurn('user', 'earlier ask')],
      },
    );

    // Resolved ONCE for this turn.
    expect(resolveLearnerStateHeaderFn).toHaveBeenCalledTimes(1);
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

// YUK-574 — the session-anchored learner-state header rides as the PINNED first
// entry of conversation_history (role:'context'), assembled ONCE per validity
// window (the resolver caches it; here it is injected). The pinned header is never
// dropped by the COPILOT_HISTORY_BUDGET oldest-first truncation, and the migrated
// Facet A proposal_feedback digest comes from the SAME resolver (its own field).
describe('runCopilotChat — learner-state header (YUK-574)', () => {
  const baseDeps = {
    findOrCreateConversationFn: async () => ({ sessionId: 'ls_state', created: false }),
    now: () => new Date('2026-07-06T09:00:00.000Z'),
  };
  const mkRun = () =>
    vi.fn(async () => ({
      task_run_id: 't',
      text: 'OK',
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
  const mkTurn = (role: 'user' | 'ai', text: string) =>
    ({ role, text, at: '2026-07-06T00:00:00.000Z', event_id: `e_${text.slice(0, 4)}` }) as never;
  const captureInput = (runAgentTaskFn: ReturnType<typeof vi.fn>) =>
    (runAgentTaskFn.mock.calls[0] as unknown as unknown[])[1] as {
      conversation_history: Array<{ role: string; text: string }>;
      proposal_feedback: unknown[];
    };

  it('first turn pins the header at conversation_history[0] (role:context) + forwards the digest', async () => {
    const runAgentTaskFn = mkRun();
    const digest = [
      {
        kind: 'knowledge_edge' as const,
        relation: 'prerequisite',
        acceptance_rate: 0.6,
        top_dismiss_reasons: [],
        top_rubric_gates: [],
      },
    ];
    const resolveLearnerStateHeaderFn = vi.fn(async (_db: unknown, _sessionId: string) => ({
      header_md: '今日待复习 7 项\n当前目标：掌握「之」的用法',
      proposal_feedback: digest,
    }));

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn,
        loadHistoryFn: async () => [mkTurn('user', '上一轮的问题')],
      },
    );

    // Resolver called once, scoped to the resolved conversation session id.
    expect(resolveLearnerStateHeaderFn).toHaveBeenCalledTimes(1);
    expect(resolveLearnerStateHeaderFn.mock.calls[0]?.[1]).toBe('ls_state');

    const input = captureInput(runAgentTaskFn);
    // Pinned header is the FIRST entry; the real turn follows it.
    expect(input.conversation_history[0]).toEqual({
      role: 'context',
      text: '今日待复习 7 项\n当前目标：掌握「之」的用法',
    });
    expect(input.conversation_history[1]).toEqual({ role: 'user', text: '上一轮的问题' });
    // The migrated digest rides its own field.
    expect(input.proposal_feedback).toEqual(digest);
  });

  it('empty header → no context entry prepended (byte-for-byte the pre-YUK-574 history)', async () => {
    const runAgentTaskFn = mkRun();
    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
        loadHistoryFn: async () => [mkTurn('user', 'only turn')],
      },
    );
    const input = captureInput(runAgentTaskFn);
    expect(input.conversation_history).toEqual([{ role: 'user', text: 'only turn' }]);
  });

  it('history truncation PINS the header: it survives the oldest-first drop', async () => {
    const runAgentTaskFn = mkRun();
    // Enough big turns that the serialized array blows past totalChars → oldest
    // real turns are dropped, but the pinned header must remain at index 0.
    const big = 'x'.repeat(700);
    const turns = Array.from({ length: 8 }, (_, i) => mkTurn('user', `${i}-${big}`));
    const header = '学习者状态：今日待复习 3 项';

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn: async () => ({ header_md: header, proposal_feedback: [] }),
        loadHistoryFn: async () => turns,
      },
    );

    const input = captureInput(runAgentTaskFn);
    // The header is pinned at index 0 (never dropped)…
    expect(input.conversation_history[0]).toEqual({ role: 'context', text: header });
    // …truncation actually happened (fewer than the 8 injected real turns survive)…
    const realTurns = input.conversation_history.filter((e) => e.role !== 'context');
    expect(realTurns.length).toBeLessThan(8);
    // …and the whole array (header included) still fits the budget.
    expect(JSON.stringify(input.conversation_history).length).toBeLessThanOrEqual(
      COPILOT_HISTORY_BUDGET.totalChars,
    );
  });

  // PR #717 round-2 OCR fix #1 (minor 0.60) — there was no PROGRAMMATIC invariant
  // between LEARNER_STATE_HEADER_BUDGET.maxChars and COPILOT_HISTORY_BUDGET.
  // totalChars: the oldest-first drop loop only shifts real turns, so if the
  // header ALONE (with zero real turns left) still exceeds totalChars, the old
  // code would return an orphaned over-budget header instead of respecting the
  // total-chars ceiling. Uses a genuinely oversized header_md (well past the
  // REAL totalChars) rather than an artificial budget, so this exercises the
  // actual constants chat.ts wires — the guard must drop the header too rather
  // than ship a lone entry that blows the whole-array budget.
  it('an oversized header (alone, over totalChars) is dropped too — never ships an orphaned over-budget header', async () => {
    const runAgentTaskFn = mkRun();
    // Deliberately larger than COPILOT_HISTORY_BUDGET.totalChars on its own.
    const oversizedHeader = 'x'.repeat(COPILOT_HISTORY_BUDGET.totalChars + 500);

    await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn: async () => ({
          header_md: oversizedHeader,
          proposal_feedback: [],
        }),
        loadHistoryFn: async () => [],
      },
    );

    const input = captureInput(runAgentTaskFn);
    // No orphaned over-budget header — the whole-array invariant wins.
    expect(input.conversation_history).toEqual([]);
  });

  // Review-verdict fix #3(a) (MINOR) — a throwing resolver degrades to an empty
  // header (chat.ts's own try/catch around resolveLearnerState), which then makes
  // assembleConversationHistory skip the pin entirely (empty header_md → no
  // context entry). The chat must still reply, not crash.
  it('degrade (a): a throwing resolveLearnerStateHeaderFn → chat still replies, conversation_history is empty', async () => {
    const runAgentTaskFn = mkRun();
    const resolveLearnerStateHeaderFn = vi.fn(async () => {
      throw new Error('resolver blew up');
    });

    const result = await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn,
        loadHistoryFn: async () => [],
      },
    );

    expect(result.reply).toBe('OK');
    const input = captureInput(runAgentTaskFn);
    expect(input.conversation_history).toEqual([]);
    expect(input.proposal_feedback).toEqual([]);
  });

  // Review-verdict fix #3(b) (MINOR) — a throwing history reader must NOT lose a
  // successfully-resolved (non-empty) header: chat.ts's loadHistory catch branch
  // rebuilds conversation_history from an EMPTY turn list but the SAME
  // learnerState.header_md, so the pin survives header-only.
  it('degrade (b): a throwing loadHistoryFn + non-empty header → conversation_history is header-only', async () => {
    const runAgentTaskFn = mkRun();
    const header = '今日待复习 4 项';

    const result = await runCopilotChat(
      {} as never,
      { user_message: '继续', triggered_by: 'chat' },
      {
        ...baseDeps,
        runAgentTaskFn,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn: async () => ({ header_md: header, proposal_feedback: [] }),
        loadHistoryFn: async () => {
          throw new Error('history read blew up');
        },
      },
    );

    expect(result.reply).toBe('OK');
    const input = captureInput(runAgentTaskFn);
    expect(input.conversation_history).toEqual([{ role: 'context', text: header }]);
  });

  it('teaching turns do NOT resolve the learner-state header (short-circuit)', async () => {
    const db = {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    } as never;
    const resolveLearnerStateHeaderFn = vi.fn(async () => ({
      header_md: 'should not appear',
      proposal_feedback: [],
    }));
    const runTeachingSkillFn = vi.fn(async () => ({
      text_md: '讲讲。',
      kind: 'explain' as const,
      suggested_next: 'continue' as const,
      task_run_id: 'task_teaching_ls',
    }));

    await runCopilotChat(
      db,
      {
        user_message: '讲讲',
        triggered_by: 'chat',
        skill_context: { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_ls' } },
      },
      {
        ...baseDeps,
        writeEventFn: vi.fn(async (_db: unknown, input: { id: string }) => input.id),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        resolveLearnerStateHeaderFn,
        runTeachingSkillFn,
      },
    );
    expect(resolveLearnerStateHeaderFn).not.toHaveBeenCalled();
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
    resolveLearnerStateHeaderFn: async () => ({ header_md: '', proposal_feedback: [] }),
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

  it('T5b: ephemeral_html payload containing `-->` parses via the greedy tail pass; zero residue (PR #375 MEDIUM-1)', () => {
    const html = '<div><!-- inner comment --><b>周期表</b></div>';
    // JSON.stringify builds the payload — correct escaping by construction
    // (a hand-rolled quote-replace trips CodeQL js/incomplete-sanitization).
    const payload = JSON.stringify({ source: 'ephemeral_html', ref: html });
    const out = extractPrimaryView(`正文。\n<!--primary_view:${payload}-->`, { taskRunId: 't' });
    // The greedy tail match swallows the inner `-->` — nomination SUCCEEDS
    // (was: lenient-absent under the lazy-only parser)…
    expect(out.primaryView).toEqual({ source: 'ephemeral_html', ref: html });
    // …and the whole marker region is removed: no payload residue in reply_md.
    expect(out.text).toBe('正文。');
    expect(out.text).not.toContain('primary_view');
    expect(out.text).not.toContain('ephemeral_html');
  });

  it('T5c: unterminated marker (stream aborted mid-marker) → truncated + warn, nothing leaks (PR #375 MEDIUM-2)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = extractPrimaryView('正文先到。\n<!--primary_view:{"source":"artifa', {
      taskRunId: 't',
    });
    expect(out.primaryView).toBeUndefined();
    expect(out.text).toBe('正文先到。');
    expect(out.text).not.toContain('<!--');
    expect(warnSpy).toHaveBeenCalledTimes(1);
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
    // Delayed publication is byte-identical to the normalized terminal reply.
    expect(deltas).toEqual(['这是你的题。']);

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

    expect(deltas).toEqual([parts.join('')]);
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

    // Publication and terminal reply carry exactly the same selected bytes.
    expect(deltas.join('')).toBe(fullText);
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
    expect(input.conversation_history).toEqual([
      { role: 'ai', text: 'a prior reply body', event_id: 'e_pv' },
    ]);
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
