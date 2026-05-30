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
});
