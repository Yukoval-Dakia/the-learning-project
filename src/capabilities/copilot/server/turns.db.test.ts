// AF S3a / YUK-203 U3 — db test for getRecentCopilotTurns + the conversation
// session envelope wired into runCopilotChat.
//
// Runs in the db vitest config (real Postgres testcontainer) because it goes
// through writeEvent + the learning_session table.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRecentCopilotTurns } from '@/capabilities/copilot/server/turns';
import { db } from '@/db/client';
import { event, learning_session, tool_operation } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { Conversation } from '@/server/session';

const writtenEventIds: string[] = [];
const writtenToolOperationIds: string[] = [];
const touchedSessionIds: string[] = [];

// codex #3356884484 — replay is now scoped to the live reusable Copilot session
// (findReusableCopilotConversation), so tests must seed a real
// learning_session(entrypoint='copilot') row rather than a synthetic id.
async function createLiveCopilotSession(now: Date): Promise<string> {
  const { sessionId } = await Conversation.findOrCreateCopilotConversation(db, { now });
  touchedSessionIds.push(sessionId);
  return sessionId;
}

// The reader resolves the single most-recent reusable Copilot session across the
// WHOLE table, so leftover live sessions from other suites would pollute it.
// Terminate any pre-existing live conversation rows before each test.
beforeEach(async () => {
  const rows = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        inArray(learning_session.status, ['active', 'idle']),
      ),
    );
  for (const r of rows) {
    await db.delete(event).where(eq(event.session_id, r.id));
    await db.delete(learning_session).where(eq(learning_session.id, r.id));
  }
});

afterEach(async () => {
  if (writtenToolOperationIds.length > 0) {
    await db.delete(tool_operation).where(inArray(tool_operation.id, writtenToolOperationIds));
    writtenToolOperationIds.length = 0;
  }
  if (writtenEventIds.length > 0) {
    await db.delete(event).where(inArray(event.id, writtenEventIds));
    writtenEventIds.length = 0;
  }
  if (touchedSessionIds.length > 0) {
    for (const id of touchedSessionIds) {
      await db.delete(event).where(eq(event.session_id, id));
    }
    await db.delete(learning_session).where(inArray(learning_session.id, touchedSessionIds));
    touchedSessionIds.length = 0;
  }
});

async function writeAsk(text: string, sessionId: string, at: Date): Promise<string> {
  const id = `copilot_user_ask_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    // codex #3356884490 — the ask carries the session_id column (mirrors
    // production chat.ts), so the reader's event.session_id = session.id filter
    // matches user turns, not just replies.
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: { surface: 'copilot', user_message: text, session_id: sessionId },
    created_at: at,
  });
  return id;
}

async function writeReply(
  text: string,
  sessionId: string,
  inReplyTo: string,
  at: Date,
  taskRunId = 'task_x',
): Promise<string> {
  const id = `copilot_reply_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'experimental:copilot_reply',
    subject_kind: 'query',
    subject_id: id,
    outcome: null,
    payload: {
      surface: 'copilot',
      session_id: sessionId,
      reply_md: text,
      task_run_id: taskRunId,
      in_reply_to_event_id: inReplyTo,
    },
    caused_by_event_id: inReplyTo,
    task_run_id: taskRunId,
    created_at: at,
  });
  return id;
}

// YUK-497 wave-4 — mirror an mcp-bridge tool_use event chained to the ask (caused_by), carrying the
// tool_name (the persisted key the anchor-suppression reads; tool_use has session_id null in prod and
// is queried by caused_by, not session).
async function writeToolUse(
  causedBy: string,
  toolName: string,
  at: Date,
  extra?: { summary?: string; errorReason?: string; outcome?: 'success' | 'failure' },
) {
  const id = `tool_use_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'agent:copilot',
    action: 'tool_use',
    subject_kind: 'query',
    subject_id: id,
    outcome: extra?.outcome ?? 'success',
    payload: {
      tool_name: toolName,
      args: { limit: 8 },
      ...(extra?.summary ? { result_summary: extra.summary } : {}),
      ...(extra?.errorReason ? { error_reason: extra.errorReason } : {}),
    },
    caused_by_event_id: causedBy,
    created_at: at,
  });
  return id;
}

describe('getRecentCopilotTurns', () => {
  it('replays session-owned operations and causal subagent runs on the single root reply', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const startedAt = new Date(now.getTime() - 4_000);
    const askId = await writeAsk('核对这组错题并给我结论。', sessionId, startedAt);
    const operationId = `tool_operation_${createId()}`;
    const subagentId = `subagent_run_${createId()}`;
    const subagentStartedId = `subagent_started_${createId()}`;
    const operationYieldedId = `tool_operation_yielded_${createId()}`;
    const operationSettledId = `tool_operation_settled_${createId()}`;
    const subagentSettledId = `subagent_settled_${createId()}`;
    writtenEventIds.push(
      operationYieldedId,
      operationSettledId,
      subagentStartedId,
      subagentSettledId,
    );
    await writeEvent(db, {
      id: operationYieldedId,
      session_id: sessionId,
      actor_kind: 'system',
      actor_ref: 'tool_operations',
      action: 'tool_operation_yielded',
      subject_kind: 'tool_operation',
      subject_id: operationId,
      outcome: null,
      payload: {
        tool_name: 'query_mistakes',
        effect: 'read',
        process_id: 'private-process-id',
      },
      task_run_id: 'task_x',
      created_at: new Date(now.getTime() - 3_500),
    });
    await writeEvent(db, {
      id: operationSettledId,
      session_id: sessionId,
      actor_kind: 'system',
      actor_ref: 'tool_operations',
      action: 'tool_operation_settled',
      subject_kind: 'tool_operation',
      subject_id: operationId,
      outcome: 'success',
      payload: { state: 'succeeded' },
      task_run_id: 'task_x',
      created_at: new Date(now.getTime() - 3_000),
    });
    await writeEvent(db, {
      id: subagentStartedId,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:subagent_run_started',
      subject_kind: 'subagent_run',
      subject_id: subagentId,
      outcome: null,
      payload: {
        run_id: subagentId,
        launch_key: 'mistake-check',
        objective: 'private objective must never enter the replay card',
      },
      caused_by_event_id: askId,
      task_run_id: 'task_x',
      created_at: new Date(now.getTime() - 2_500),
    });
    await writeEvent(db, {
      id: subagentSettledId,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot-researcher',
      action: 'experimental:subagent_run_settled',
      subject_kind: 'subagent_run',
      subject_id: subagentId,
      outcome: 'success',
      payload: {
        run_id: subagentId,
        status: 'succeeded',
        result_md: 'private child result must be delivered only through the root reply',
      },
      caused_by_event_id: subagentStartedId,
      task_run_id: 'task_x',
      created_at: new Date(now.getTime() - 2_000),
    });
    const replyId = await writeReply(
      '我已核对完这组错题，结论如下。',
      sessionId,
      askId,
      new Date(now.getTime() - 1_000),
    );

    const aiTurn = (await getRecentCopilotTurns(db, { now })).find(
      (turn) => turn.event_id === replyId,
    );

    expect(aiTurn).toMatchObject({
      tool_operations: [{ id: operationId, tool_name: 'query_mistakes', status: 'succeeded' }],
      subagent_runs: [{ id: subagentId, status: 'succeeded' }],
    });
    expect(JSON.stringify(aiTurn)).not.toContain('private-process-id');
    expect(JSON.stringify(aiTurn)).not.toContain('private objective');
    expect(JSON.stringify(aiTurn)).not.toContain('private child result');
  });

  it('replays a settled-only operation from its durable row', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const askId = await writeAsk('查看复习安排。', sessionId, new Date(now.getTime() - 3_000));
    const operationId = `tool_operation_${createId()}`;
    const settledEventId = `tool_operation_settled_${createId()}`;
    writtenToolOperationIds.push(operationId);
    writtenEventIds.push(settledEventId);
    const startedAt = new Date(now.getTime() - 2_500);
    await db.insert(tool_operation).values({
      id: operationId,
      session_id: sessionId,
      task_run_id: 'task_x',
      tool_name: 'get_review_due',
      effect: 'read',
      status: 'succeeded',
      process_id: 'private-recovery-process',
      input_hash: 'a'.repeat(64),
      input_json: {},
      result_json: { count: 4 },
      started_at: startedAt,
      owner_heartbeat_at: startedAt,
      lease_expires_at: new Date(now.getTime() - 1_500),
      settled_at: new Date(now.getTime() - 2_000),
      updated_at: new Date(now.getTime() - 2_000),
    });
    await writeEvent(db, {
      id: settledEventId,
      session_id: sessionId,
      actor_kind: 'system',
      actor_ref: 'tool_operations',
      action: 'tool_operation_settled',
      subject_kind: 'tool_operation',
      subject_id: operationId,
      outcome: 'success',
      payload: { state: 'succeeded' },
      task_run_id: 'task_x',
      created_at: new Date(now.getTime() - 1_500),
    });
    const replyId = await writeReply(
      '今天有 4 项复习安排。',
      sessionId,
      askId,
      new Date(now.getTime() - 1_000),
    );

    const aiTurn = (await getRecentCopilotTurns(db, { now })).find(
      (turn) => turn.event_id === replyId,
    );

    expect(aiTurn?.tool_operations).toEqual([
      { id: operationId, tool_name: 'get_review_due', status: 'succeeded' },
    ]);
    expect(JSON.stringify(aiTurn)).not.toContain('private-recovery-process');
    expect(JSON.stringify(aiTurn)).not.toContain('count');
  });

  // YUK-457 — defensive replay-seam mirror of the SSE Task filter: a native
  // Task tool_use row (which the bridge never writes) must not surface its
  // subagent prompts in tool_calls.
  it('replay drops Task tool_use mirrors defensively', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-08T12:40:00.000Z');
    const askId = await writeAsk('帮我分析这道题。', sessionId, t0);
    await writeToolUse(askId, 'Task', new Date(t0.getTime() + 250), {
      summary: 'spawned hidden subagent',
    });
    await writeToolUse(askId, 'query_mistakes', new Date(t0.getTime() + 500), {
      summary: 'mistakes · 2 行',
    });
    const replyId = await writeReply('分析完成。', sessionId, askId, new Date(t0.getTime() + 1000));

    const turns = await getRecentCopilotTurns(db, { now });
    const aiTurn = turns.find((t) => t.event_id === replyId);
    expect(aiTurn?.tool_calls).toEqual([
      {
        toolName: 'query_mistakes',
        input: { limit: 8 },
        summary: 'mistakes · 2 行',
        status: 'done',
      },
    ]);
  });
});
