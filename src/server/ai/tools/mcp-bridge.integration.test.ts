// db-level integration: drive the real bridge with a real DB so the
// tool_use mirror event actually flows through Zod parse
// (`parseEvent` inside `writeEvent`) and the resulting row + the
// `tool_call_log.mirrored_event_id` linkage land on disk.

import { randomUUID } from 'node:crypto';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { capabilities } from '@/capabilities';
import { event, memory_brief_note, tool_call_log, tool_operation } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { buildPiDomainAgentTools } from './pi-tools';
import { registerCapabilityTools } from './register-capability-tools';
import { __resetRegistryForTests, registerTool } from './registry';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_mirror_e2e',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function waitForToolOperationId(sessionId: string): Promise<string> {
  let operationId: string | undefined;
  await vi.waitFor(async () => {
    operationId = (
      await testDb()
        .select({ id: tool_operation.id })
        .from(tool_operation)
        .where(eq(tool_operation.session_id, sessionId))
    )[0]?.id;
    expect(operationId).toEqual(expect.any(String));
  });
  return operationId as string;
}

async function seedAttempt() {
  await writeEvent(testDb(), {
    id: 'att_mirror_e2e',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_no_existing',
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: [],
    },
    created_at: new Date(),
  });
}

describe('mcp-bridge end-to-end: mirror lands in event + tool_call_log linkage', () => {
  let agentTools: AgentTool[] = [];

  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    agentTools = [];
    await registerCapabilityTools(capabilities);
  });

  it('agent:copilot caller writes tool_use event for query_mistakes', async () => {
    await seedAttempt();

    agentTools = buildPiDomainAgentTools({
      ctx: ctx(),
      serverName: 'loom_v2',
      toolNames: ['query_mistakes'],
    });
    await agentTools[0].execute('call_test', {});

    const db = testDb();
    const eventRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'tool_use'),
          eq(event.actor_kind, 'agent'),
          eq(event.actor_ref, 'agent:copilot'),
        ),
      );

    expect(eventRows).toHaveLength(1);
    const ev = eventRows[0];
    expect(ev.subject_kind).toBe('query');
    expect(ev.subject_id.startsWith('tool_use_')).toBe(true);
    expect(ev.outcome).toBe('success');
    expect(ev.task_run_id).toBe('tr_mirror_e2e');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.tool_name).toBe('query_mistakes');
    expect(typeof payload.result_summary).toBe('string');

    const tcl = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, 'tr_mirror_e2e'));
    expect(tcl).toHaveLength(1);
    expect(tcl[0].mirrored_event_id).toBe(ev.id);
    expect(tcl[0].effect).toBe('read');
    expect(tcl[0].tool_name).toBe('query_mistakes');
  });

  it('user caller skips mirror but still writes tool_call_log', async () => {
    await seedAttempt();

    agentTools = buildPiDomainAgentTools({
      ctx: { ...ctx(), callerActor: { kind: 'user', ref: 'debug:_/tools' } },
      serverName: 'loom_v2',
      toolNames: ['query_mistakes'],
    });
    await agentTools[0].execute('call_test', {});

    const db = testDb();
    const eventRows = await db.select().from(event).where(eq(event.action, 'tool_use'));
    expect(eventRows).toHaveLength(0);

    const tcl = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, 'tr_mirror_e2e'));
    expect(tcl).toHaveLength(1);
    expect(tcl[0].mirrored_event_id).toBeNull();
  });

  it('blocks until settlement, mirrors, logs, and links the terminal call in one MCP response', async () => {
    const safeTool: DomainTool<{ query: string }, { hits: Array<{ id: string; score: number }> }> =
      {
        name: 'bridge_test_safe_remote',
        description: 'test-only idempotent remote read',
        effect: 'read',
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ hits: z.array(z.object({ id: z.string(), score: z.number() })) }),
        costClass: 'cheap_llm',
        safeHandoff: { transport: 'remote', idempotent: true },
        async execute(_ctx, input) {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          return { hits: [{ id: `${input.query}_result`, score: 0.87 }] };
        },
        summarize(_input, result) {
          return `safe remote · ${result.hits.length} hit`;
        },
        mirrorEvent: 'always',
      };
    registerTool(safeTool);
    agentTools = buildPiDomainAgentTools({
      ctx: { ...ctx(), sessionId: 'session_safe_bridge' },
      serverName: 'loom',
      toolNames: [safeTool.name],
    });

    const response = (await agentTools
      .find((t) => t.name === `mcp__loom__${safeTool.name}`)
      ?.execute('call_test', { query: 'deep_nested' })) as { content: Array<{ text: string }> };
    const responseBody = JSON.parse(response.content[0]?.text ?? '') as {
      output: { hits: Array<{ id: string; score: number }> };
    };
    expect(responseBody.output).toEqual({
      hits: [{ id: 'deep_nested_result', score: 0.87 }],
    });
    expect(JSON.stringify(responseBody)).not.toContain('tool_operation');

    const logs = await testDb()
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.tool_name, safeTool.name));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.output_json).toEqual({
      hits: [{ id: 'deep_nested_result', score: 0.87 }],
    });
    expect(logs[0]?.mirrored_event_id).toEqual(expect.any(String));

    const operationId = (
      await testDb()
        .select()
        .from(tool_operation)
        .where(eq(tool_operation.session_id, 'session_safe_bridge'))
    )[0]?.id;
    expect(operationId).toEqual(expect.any(String));
    const [operation] = await testDb()
      .select()
      .from(tool_operation)
      .where(eq(tool_operation.id, operationId));
    expect(operation).toMatchObject({
      status: 'succeeded',
      input_json: {
        args: { query: 'deep_nested' },
        // pi carries the loop's native toolCall.id as the correlation id (no
        // synthesized `toolu_*` — that minting died with the SDK claim hook).
        tool_use_id: 'call_test',
      },
      terminal_tool_call_log_id: logs[0]?.id,
    });

    const events = await testDb().select().from(event).where(eq(event.subject_id, operationId));
    expect(events.map((row) => row.action)).toEqual(['tool_operation_settled']);
    const [terminalMirror] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, logs[0]?.mirrored_event_id ?? 'missing'));
    expect(terminalMirror).toMatchObject({ action: 'tool_use', outcome: 'success' });
  });

  it('does not expose retired operation controls to the model', () => {
    expect(
      () =>
        (agentTools = buildPiDomainAgentTools({
          ctx: { ...ctx(), sessionId: 'session_model_owner' },
          serverName: 'loom',
          toolNames: ['cancel_tool_operation'],
        })),
    ).toThrow("tool 'cancel_tool_operation' is not registered");
    expect(agentTools).toEqual([]);
  });

  it.each(['system', 'user'] as const)(
    'routes %s parent cancellation through the same owned ToolOperations seam',
    async (requestedBy) => {
      const controller = new AbortController();
      const safeTool: DomainTool<{ query: string }, { hits: string[] }> = {
        name: `bridge_test_${requestedBy}_cancel`,
        description: 'test-only parent-cancellable remote read',
        effect: 'read',
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ hits: z.array(z.string()) }),
        costClass: 'cheap_llm',
        safeHandoff: { transport: 'remote', idempotent: true },
        async execute(toolCtx) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ hits: ['late'] }), 500);
            toolCtx.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('parent cancel observed'));
              },
              { once: true },
            );
          });
        },
        summarize(_input, result) {
          return `parent cancellable · ${result.hits.length}`;
        },
        mirrorEvent: 'never',
      };
      registerTool(safeTool);
      agentTools = buildPiDomainAgentTools({
        ctx: { ...ctx(), sessionId: `session_${requestedBy}_owner` },
        serverName: 'loom',
        toolNames: [safeTool.name],
        cancellationSignals: [{ signal: controller.signal, requestedBy }],
      });
      const __tool = agentTools.find((t) => t.name === `mcp__loom__${safeTool.name}`);
      const handler = __tool ? (a: unknown) => __tool.execute('call_test', a) : undefined;
      const execution = handler?.({ query: 'cancel from parent' });
      const operationId = await waitForToolOperationId(`session_${requestedBy}_owner`);

      controller.abort();
      const response = (await execution) as { content: Array<{ text: string }> };
      expect(JSON.parse(response.content[0]?.text ?? '')).toMatchObject({
        error: expect.stringContaining('cancelled'),
      });
      const [operation] = await testDb()
        .select()
        .from(tool_operation)
        .where(eq(tool_operation.id, operationId));
      expect(operation).toMatchObject({ status: 'cancelled', cancelled_by: requestedBy });
    },
  );

  it('cancels an in-flight safe read when the parent lifecycle aborts after the run returns', async () => {
    const sessionId = `conversation_terminal_parent_${randomUUID()}`;
    const lifecycleAbortController = new AbortController();
    const safeTool: DomainTool<{ query: string }, { hits: string[] }> = {
      name: 'bridge_test_post_parent_user_cancel',
      description: 'test-only post-parent cancellable remote read',
      effect: 'read',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ hits: z.array(z.string()) }),
      costClass: 'cheap_llm',
      safeHandoff: { transport: 'remote', idempotent: true },
      async execute(toolCtx) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ hits: ['late'] }), 2_000);
          toolCtx.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('post-parent lifecycle cancel observed'));
            },
            { once: true },
          );
        });
      },
      summarize(_input, result) {
        return `post-parent cancellable · ${result.hits.length}`;
      },
      mirrorEvent: 'never',
    };
    registerTool(safeTool);
    agentTools = buildPiDomainAgentTools({
      ctx: {
        ...ctx(),
        sessionId,
        taskRunId: `copilot_run_tool_${randomUUID()}`,
      },
      serverName: 'loom',
      toolNames: [safeTool.name],
      cancellationSignals: [{ signal: lifecycleAbortController.signal, requestedBy: 'system' }],
    });
    const __tool = agentTools.find((t) => t.name === `mcp__loom__${safeTool.name}`);
    const handler = __tool ? (a: unknown) => __tool.execute('call_test', a) : undefined;
    const execution = handler?.({ query: 'keep blocking after root return' });
    const operationId = await waitForToolOperationId(sessionId);

    lifecycleAbortController.abort();
    const response = (await execution) as { content: Array<{ text: string }> };
    expect(JSON.parse(response.content[0]?.text ?? '')).toMatchObject({
      error: expect.stringContaining('cancelled'),
    });
    const [operation] = await testDb()
      .select()
      .from(tool_operation)
      .where(eq(tool_operation.id, operationId));
    expect(operation).toMatchObject({ status: 'cancelled', cancelled_by: 'system' });
  });

  // YUK-862 / F3.1 — output schema enforcement DB-level tests
  it('output_schema_invalid lands in tool_call_log with failure mirror when policy fires', async () => {
    const badOutputTool: DomainTool<Record<string, never>, { hits: number }> = {
      name: 'bridge_test_bad_output',
      description: 'produces structurally invalid output',
      effect: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ hits: z.number() }),
      costClass: 'local',
      async execute() {
        return 'invalid string output' as unknown as { hits: number };
      },
      summarize() {
        return '';
      },
      mirrorEvent: 'always',
    };
    registerTool(badOutputTool);

    agentTools = buildPiDomainAgentTools({
      ctx: ctx(),
      serverName: 'loom_v2',
      toolNames: ['bridge_test_bad_output'],
    });
    await agentTools
      .find((t) => t.name === 'mcp__loom_v2__bridge_test_bad_output')
      ?.execute('call_test', {});

    const db = testDb();
    const tcl = await db
      .select()
      .from(tool_call_log)
      .where(
        and(
          eq(tool_call_log.task_run_id, 'tr_mirror_e2e'),
          eq(tool_call_log.tool_name, 'bridge_test_bad_output'),
        ),
      );
    expect(tcl).toHaveLength(1);
    expect(tcl[0].error_reason).toMatch(/output_schema_invalid/);
    expect(tcl[0].output_json).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/output_schema_invalid/) }),
    );

    const eventRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'tool_use'), eq(event.actor_kind, 'agent')));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].outcome).toBe('failure');
    const payload = eventRows[0].payload as Record<string, unknown>;
    expect(payload.error_reason).toMatch(/output_schema_invalid/);
  });

  it('persists stale memory-brief freshness for Dreaming without a user-visible mirror', async () => {
    const staleAt = new Date('2000-01-01T00:00:00.000Z');
    await testDb().insert(memory_brief_note).values({
      id: 'brief_stale_e2e',
      scope_key: 'global',
      recent_week_md: 'Old directional context',
      refreshed_at: staleAt,
      created_at: staleAt,
      updated_at: staleAt,
    });

    agentTools = buildPiDomainAgentTools({
      ctx: { ...ctx(), callerActor: { kind: 'agent', ref: 'dreaming' } },
      serverName: 'loom_v2',
      toolNames: ['query_memory_brief'],
    });
    await agentTools[0].execute('call_test', { scopeKey: 'global' });

    const [log] = await testDb()
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, 'tr_mirror_e2e'));
    expect(log.output_json).toMatchObject({
      freshness: {
        state: 'stale',
        stale_after_ms: 86_400_000,
      },
    });
    expect(await testDb().select().from(event).where(eq(event.action, 'tool_use'))).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// YUK-921 P4 (YUK-1025) — pi is the sole engine; the AgentTool bridge delegates
// to executeDomainToolCall. This pins the persisted tool_call_log columns and
// the tool_use mirror shape as absolute expectations (previously a two-lane
// diff against the retired SDK bridge — which degenerated into self-parity
// once both legs ran the same pi pipeline).
// ────────────────────────────────────────────────────────────────────────────
describe('pi AgentTool path — tool_call_log + tool_use mirror persistence', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    await registerCapabilityTools(capabilities);
  });

  it('writes the tool_call_log row and mirror linkage for a copilot-agent call', async () => {
    await seedAttempt();
    const db = testDb();
    const runId = 'tr_pi_persist';

    const [agentTool] = buildPiDomainAgentTools({
      ctx: {
        db,
        taskRunId: runId,
        callerActor: { kind: 'agent', ref: 'agent:copilot' },
      },
      serverName: 'loom',
      toolNames: ['query_mistakes'],
      taskKind: 'CopilotTask',
    });
    expect(agentTool.name).toBe('mcp__loom__query_mistakes');
    await agentTool.execute('toolCall_pi_1', { filter: { limit: 5 } }, undefined);

    const [log] = await db.select().from(tool_call_log).where(eq(tool_call_log.task_run_id, runId));
    expect(log).toMatchObject({
      task_run_id: runId,
      task_kind: 'CopilotTask',
      tool_name: 'query_mistakes',
      effect: 'read',
      input_json: { filter: { limit: 5 } },
      error_reason: null,
      cost: 0,
      mirrored_event_id: expect.any(String),
    });
    expect(log.output_json).toBeTruthy();

    // Mirror event: action/shape pinned; it links back to its own log row.
    const [mirror] = await db
      .select()
      .from(event)
      .where(eq(event.id, log.mirrored_event_id ?? 'none'));
    expect(mirror).toMatchObject({
      action: 'tool_use',
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      outcome: 'success',
      task_run_id: runId,
      subject_kind: 'query',
    });
    expect((mirror.payload as Record<string, unknown>).tool_name).toBe('query_mistakes');
  });

  it('pi execute surfaces pi toolCall.id as the correlated tool_use_id in the result text', async () => {
    await seedAttempt();
    const db = testDb();
    const [agentTool] = buildPiDomainAgentTools({
      ctx: { db, taskRunId: 'tr_pi_corr', callerActor: { kind: 'agent', ref: 'agent:copilot' } },
      serverName: 'loom',
      toolNames: ['query_mistakes'],
    });
    const result = await agentTool.execute('toolCall_pi_corr_1', { limit: 3 }, undefined);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect(parsed.tool_use_id).toBe('toolCall_pi_corr_1');
  });
});
