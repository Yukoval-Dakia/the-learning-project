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
