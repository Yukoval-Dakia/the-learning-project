// db-level integration: drive the real bridge with a real DB so the
// tool_use mirror event actually flows through Zod parse
// (`parseEvent` inside `writeEvent`) and the resulting row + the
// `tool_call_log.mirrored_event_id` linkage land on disk.

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { capabilities } from '@/capabilities';
import { event, memory_brief_note, tool_call_log, tool_operation } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { registerCapabilityTools } from './register-capability-tools';
import { __resetRegistryForTests, registerTool } from './registry';

// Mock the Agent SDK so the bridge wraps tools without spawning Claude.
const mockSdk = vi.hoisted(() => ({
  toolDefs: [] as Array<{
    name: string;
    handler: (args: unknown) => Promise<unknown>;
  }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: unknown) => ({ type: 'sdk', instance: opts })),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    const def = { name, handler } as (typeof mockSdk.toolDefs)[number];
    mockSdk.toolDefs.push(def);
    return def;
  }),
}));

import { buildMcpServerFromRegistry } from './mcp-bridge';

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
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    mockSdk.toolDefs = [];
    await registerCapabilityTools(capabilities);
  });

  it('agent:copilot caller writes tool_use event for query_mistakes', async () => {
    await seedAttempt();

    buildMcpServerFromRegistry({
      ctx: ctx(),
      serverName: 'loom_v2',
      toolNames: ['query_mistakes'],
    });
    const def = mockSdk.toolDefs[0];
    await def.handler({});

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

    buildMcpServerFromRegistry({
      ctx: { ...ctx(), callerActor: { kind: 'user', ref: 'debug:_/tools' } },
      serverName: 'loom_v2',
      toolNames: ['query_mistakes'],
    });
    const def = mockSdk.toolDefs[0];
    await def.handler({});

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
    buildMcpServerFromRegistry({
      ctx: { ...ctx(), sessionId: 'session_safe_bridge' },
      serverName: 'loom',
      toolNames: [safeTool.name],
      claimToolUseId: () => 'toolu_safe_bridge_e2e',
    });

    const response = (await mockSdk.toolDefs
      .find((definition) => definition.name === safeTool.name)
      ?.handler({ query: 'deep_nested' })) as { content: Array<{ text: string }> };
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
        tool_use_id: 'toolu_safe_bridge_e2e',
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

  it('lets the model cancel through the shared control tool but rejects another session', async () => {
    const safeTool: DomainTool<{ query: string }, { hits: string[] }> = {
      name: 'bridge_test_model_cancel',
      description: 'test-only cancellable remote read',
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
              reject(new Error('cancel observed'));
            },
            { once: true },
          );
        });
      },
      summarize(_input, result) {
        return `cancellable remote · ${result.hits.length}`;
      },
      mirrorEvent: 'never',
    };
    registerTool(safeTool);
    buildMcpServerFromRegistry({
      ctx: { ...ctx(), sessionId: 'session_model_owner' },
      serverName: 'loom',
      toolNames: [safeTool.name, 'cancel_tool_operation'],
      claimToolUseId: () => 'toolu_model_cancel',
    });
    const handler = mockSdk.toolDefs.find(
      (definition) => definition.name === safeTool.name,
    )?.handler;
    const execution = handler?.({ query: 'cancel me' });
    const operationId = await waitForToolOperationId('session_model_owner');

    buildMcpServerFromRegistry({
      ctx: { ...ctx(), sessionId: 'session_intruder' },
      serverName: 'loom_intruder',
      toolNames: ['cancel_tool_operation'],
    });
    const intruderCancel = mockSdk.toolDefs
      .filter((definition) => definition.name === 'cancel_tool_operation')
      .at(-1);
    const denied = (await intruderCancel?.handler({ operation_id: operationId })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(denied.content[0]?.text ?? '')).toMatchObject({
      error: 'tool operation not found',
    });

    const ownerCancel = mockSdk.toolDefs.find(
      (definition) => definition.name === 'cancel_tool_operation',
    );
    await ownerCancel?.handler({ operation_id: operationId });
    const cancelResponse = (await execution) as { content: Array<{ text: string }> };
    expect(JSON.parse(cancelResponse.content[0]?.text ?? '')).toMatchObject({
      error: expect.stringContaining('cancelled'),
    });
    const [operation] = await testDb()
      .select()
      .from(tool_operation)
      .where(eq(tool_operation.id, operationId));
    expect(operation).toMatchObject({ status: 'cancelled', cancelled_by: 'model' });
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
      buildMcpServerFromRegistry({
        ctx: { ...ctx(), sessionId: `session_${requestedBy}_owner` },
        serverName: 'loom',
        toolNames: [safeTool.name],
        cancellationSignals: [{ signal: controller.signal, requestedBy }],
      });
      const handler = mockSdk.toolDefs.find(
        (definition) => definition.name === safeTool.name,
      )?.handler;
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
    buildMcpServerFromRegistry({
      ctx: {
        ...ctx(),
        sessionId,
        taskRunId: `copilot_run_tool_${randomUUID()}`,
      },
      serverName: 'loom',
      toolNames: [safeTool.name],
      cancellationSignals: [{ signal: lifecycleAbortController.signal, requestedBy: 'system' }],
    });
    const handler = mockSdk.toolDefs.find(
      (definition) => definition.name === safeTool.name,
    )?.handler;
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

    buildMcpServerFromRegistry({
      ctx: ctx(),
      serverName: 'loom_v2',
      toolNames: ['bridge_test_bad_output'],
    });
    await mockSdk.toolDefs.find((d) => d.name === 'bridge_test_bad_output')?.handler({});

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

    buildMcpServerFromRegistry({
      ctx: { ...ctx(), callerActor: { kind: 'agent', ref: 'dreaming' } },
      serverName: 'loom_v2',
      toolNames: ['query_memory_brief'],
    });
    await mockSdk.toolDefs[0].handler({ scopeKey: 'global' });

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
