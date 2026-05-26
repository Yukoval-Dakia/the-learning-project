// db-level integration: drive the real bridge with a real DB so the
// experimental:tool_use mirror event actually flows through Zod parse
// (`parseEvent` inside `writeEvent`) and the resulting row + the
// `tool_call_log.mirrored_event_id` linkage land on disk.

import { event, tool_call_log } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import { __resetRegistryForTests } from './registry';
import type { ToolContext } from './types';

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
    __resetBootstrapForTests();
    mockSdk.toolDefs = [];
    registerCoreTools();
  });

  it('agent:copilot caller writes experimental:tool_use event for query_mistakes', async () => {
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
          eq(event.action, 'experimental:tool_use'),
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
    const eventRows = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:tool_use'));
    expect(eventRows).toHaveLength(0);

    const tcl = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, 'tr_mirror_e2e'));
    expect(tcl).toHaveLength(1);
    expect(tcl[0].mirrored_event_id).toBeNull();
  });
});
