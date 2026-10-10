import type { AgentTool } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { __resetRegistryForTests, registerTool } from './registry';

// Mock writeToolCallLog / setToolCallLogMirroredEventId — bridge calls them
// but unit tests just need to capture invocations.
const captured = vi.hoisted(() => ({
  toolCallLogs: [] as unknown[],
  mirroredLinks: [] as Array<{ tcl_id: string; event_id: string }>,
  events: [] as unknown[],
}));
vi.mock('@/server/ai/log', () => ({
  writeToolCallLog: vi.fn(async (_db: unknown, entry: unknown) => {
    captured.toolCallLogs.push(entry);
    return 'mock_tcl_id';
  }),
  setToolCallLogMirroredEventId: vi.fn(async (_db: unknown, tcl_id: string, event_id: string) => {
    captured.mirroredLinks.push({ tcl_id, event_id });
  }),
}));

// Mock writeEvent — Lane D's mirror writer. Unit test asserts the input
// shape; full Zod validation is exercised by the db-level integration test.
vi.mock('@/kernel/events', () => ({
  writeEvent: vi.fn(async (_db: unknown, input: unknown) => {
    captured.events.push(input);
    return (input as { id: string }).id;
  }),
}));

vi.mock('@/kernel/events/derivation-policy', () => ({
  readEventDerivationPolicy: vi.fn(async () => 'allow'),
}));

import { buildPiDomainAgentTools } from './pi-tools';

function makeReadTool<I, O>(
  name: string,
  inputShape: Record<string, z.ZodTypeAny>,
  runFn: (input: I) => O,
  summarizeFn: (input: I, output: O) => string,
): DomainTool<I, O> {
  return {
    name,
    description: `Tool ${name}`,
    effect: 'read',
    inputSchema: z.object(inputShape) as unknown as z.ZodType<I>,
    outputSchema: z.unknown() as z.ZodType<O>,
    costClass: 'local',
    async execute(_ctx, input) {
      return runFn(input);
    },
    summarize: summarizeFn,
    mirrorEvent: 'when_user_visible',
  };
}

const ctx: ToolContext = {
  db: {} as never,
  taskRunId: 'tr_test',
  callerActor: { kind: 'agent', ref: 'agent:test:bridge' },
};

describe('buildPiDomainAgentTools', () => {
  let agentTools: AgentTool[] = [];

  beforeEach(() => {
    __resetRegistryForTests();
    agentTools = [];
    captured.toolCallLogs = [];
    captured.mirroredLinks = [];
    captured.events = [];
  });

  it('lets callers block execution before a DomainTool runs', async () => {
    const runFn = vi.fn((i: { q: string }) => ({ len: i.q.length }));
    const beforeExecute = vi.fn(() => 'quota exceeded');
    registerTool(
      makeReadTool<{ q: string }, { len: number }>(
        'demo_gate',
        { q: z.string() },
        runFn,
        () => 'should not be summarized',
      ),
    );

    agentTools = buildPiDomainAgentTools({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_gate'],
      beforeExecute,
    });
    const result = (await agentTools[0].execute('call_test', { q: 'hello' })) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(beforeExecute).toHaveBeenCalledWith({ name: 'demo_gate', effect: 'read' });
    expect(runFn).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('quota exceeded');

    const log = captured.toolCallLogs[0] as Record<string, unknown>;
    expect(log.error_reason).toBe('quota exceeded');
    expect(log.output_json).toEqual({ error: 'quota exceeded' });
  });

  it('captures an async cancellation-gate rejection without executing the tool', async () => {
    const runFn = vi.fn(() => ({ created: true }));
    registerTool(
      makeReadTool<{ prompt: string }, { created: boolean }>(
        'demo_async_cancel_rejection',
        { prompt: z.string() },
        runFn,
        () => 'should not execute',
      ),
    );
    agentTools = buildPiDomainAgentTools({
      ctx,
      serverName: 'loom_v2',
      toolNames: ['demo_async_cancel_rejection'],
      beforeExecute: async () => {
        throw new Error('cancel-state query lost');
      },
    });

    const result = (await agentTools[0].execute('call_test', {
      prompt: 'author three linked artifacts from nine transfer variants',
    })) as { content: Array<{ text: string }> };

    expect(runFn).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).error).toBe('cancel-state query lost');
    expect(captured.toolCallLogs[0]).toMatchObject({ error_reason: 'cancel-state query lost' });
  });

  // YUK-862 / F3.1 — output schema enforcement tests
  describe('output schema enforcement', () => {
    it('redacts actual values — error message contains only paths, not field values', async () => {
      registerTool({
        name: 'redact_check',
        description: 'verify values are not leaked in error',
        effect: 'read',
        inputSchema: z.object({ q: z.string() }),
        outputSchema: z.object({ hits: z.number() }),
        costClass: 'local',
        async execute() {
          return { hits: 'SECRET_VALUE_MUST_NOT_APPEAR' } as unknown as { hits: number };
        },
        summarize() {
          return '';
        },
        mirrorEvent: 'never',
      });

      agentTools = buildPiDomainAgentTools({
        ctx,
        serverName: 'loom_v2',
        toolNames: ['redact_check'],
      });
      const result = (await agentTools[0].execute('call_test', { q: 'x' })) as {
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).not.toContain('SECRET_VALUE_MUST_NOT_APPEAR');
      expect(parsed.error).toMatch(/hits/);
    });
  });
});
