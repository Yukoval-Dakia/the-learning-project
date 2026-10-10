import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { __resetRegistryForTests, registerTool } from './registry';

const policyRead = vi.hoisted(() => vi.fn<() => Promise<DerivationPolicyT>>());
// Offline pipeline tests replace only the DB reader; execution still enforces
// the accepted source policy. The real reader/guard is covered by DB tests.
vi.mock('@/kernel/events/derivation-policy', () => ({
  readEventDerivationPolicy: policyRead,
}));

const captured = vi.hoisted(() => ({
  toolCallLogs: [] as Array<Record<string, unknown>>,
  mirroredLinks: [] as Array<{ tcl_id: string; event_id: string }>,
  events: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/server/ai/log', () => ({
  writeToolCallLog: vi.fn(async (_db: unknown, entry: Record<string, unknown>) => {
    captured.toolCallLogs.push(entry);
    return 'mock_tcl_id';
  }),
  setToolCallLogMirroredEventId: vi.fn(async (_db: unknown, tcl_id: string, event_id: string) => {
    captured.mirroredLinks.push({ tcl_id, event_id });
  }),
}));
vi.mock('@/kernel/events', () => ({
  writeEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    captured.events.push(input);
    return (input as { id: string }).id;
  }),
}));

function makeTool(name: string, runFn: (input: { q: string }) => unknown): DomainTool {
  return {
    name,
    description: `Desc for ${name}`,
    effect: 'read',
    inputSchema: z.object({ q: z.string().min(1) }),
    outputSchema: z.object({ hits: z.array(z.string()) }),
    costClass: 'local',
    async execute(_ctx, input) {
      return runFn(input as { q: string }) as never;
    },
    summarize: (input, output) =>
      `summary:${(input as { q: string }).q}:${(output as { hits: string[] }).hits.length}`,
    mirrorEvent: 'always',
  } as DomainTool;
}

const ctx: ToolContext = {
  db: {} as never,
  taskRunId: 'tr_pi_test',
  callerActor: { kind: 'agent', ref: 'agent:test:pi' },
  causedByEventId: 'evt_cause_1',
};

beforeEach(() => {
  policyRead.mockReset();
  policyRead.mockResolvedValue('allow');
  __resetRegistryForTests();
  captured.toolCallLogs.length = 0;
  captured.mirroredLinks.length = 0;
  captured.events.length = 0;
});

import { buildPiDomainAgentTools } from './pi-tools';

describe('buildPiDomainAgentTools', () => {
  it('uses the accepted causal policy even when the caller declares allow', async () => {
    policyRead.mockResolvedValue('answer_only');
    const execute = vi.fn(() => ({ hits: ['must not run'] }));
    registerTool(makeTool('read_mistakes', execute));
    const [agentTool] = buildPiDomainAgentTools({
      ctx: { ...ctx, derivationPolicy: 'allow' },
      serverName: 'loom',
      toolNames: ['read_mistakes'],
    });
    const result = await agentTool.execute(
      'tc_restricted',
      { q: 'private hypothesis, not learning evidence' },
      undefined,
    );
    expect(policyRead).toHaveBeenCalledWith(ctx.db, ctx.causedByEventId);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('仅用于本次回答') },
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(captured.toolCallLogs[0]).toMatchObject({
      error_reason: expect.stringContaining('仅用于本次回答'),
    });
    expect(captured.events[0]).toMatchObject({
      action: 'tool_use',
      outcome: 'failure',
      payload: { derivation_policy: 'answer_only' },
    });
  });
});
