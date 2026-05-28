import { describe, expect, it, vi } from 'vitest';

import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import type { BuildMcpServerOptions } from '@/server/ai/tools/mcp-bridge';
import {
  DREAMING_MAX_PROPOSALS,
  runDreamingNightly,
} from '@/server/boss/handlers/dreaming_nightly';

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
});
