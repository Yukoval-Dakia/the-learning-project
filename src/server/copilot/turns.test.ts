// AF S3a / YUK-203 U3 — db test for getRecentCopilotTurns + the conversation
// session envelope wired into runCopilotChat.
//
// Runs in the db vitest config (real Postgres testcontainer) because it goes
// through writeEvent + the learning_session table.

import { createId } from '@paralleldrive/cuid2';
import { inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { runCopilotChat } from '@/server/copilot/chat';
import { getRecentCopilotTurns } from '@/server/copilot/turns';
import { writeEvent } from '@/server/events/queries';

const writtenEventIds: string[] = [];
const touchedSessionIds: string[] = [];

afterEach(async () => {
  if (writtenEventIds.length > 0) {
    await db.delete(event).where(inArray(event.id, writtenEventIds));
    writtenEventIds.length = 0;
  }
  if (touchedSessionIds.length > 0) {
    await db.delete(learning_session).where(inArray(learning_session.id, touchedSessionIds));
    touchedSessionIds.length = 0;
  }
});

async function writeAsk(text: string, sessionId: string, at: Date): Promise<string> {
  const id = `copilot_user_ask_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
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
      task_run_id: 'task_x',
      in_reply_to_event_id: inReplyTo,
    },
    caused_by_event_id: inReplyTo,
    task_run_id: 'task_x',
    created_at: at,
  });
  return id;
}

describe('getRecentCopilotTurns', () => {
  it('returns ask+reply pairs oldest→newest with role/text/at/event_id', async () => {
    const sessionId = `ls_${createId()}`;
    const t0 = new Date('2026-06-04T10:00:00.000Z');
    const askId = await writeAsk('今天该复习哪些？', sessionId, t0);
    const replyId = await writeReply(
      '有 3 道题到期。',
      sessionId,
      askId,
      new Date('2026-06-04T10:00:05.000Z'),
    );

    const turns = await getRecentCopilotTurns(db, { limit: 20 });
    // Only this session's two events exist among our written ids; assert they
    // are present, ordered, and shaped.
    const ours = turns.filter((t) => t.event_id === askId || t.event_id === replyId);
    expect(ours).toEqual([
      { role: 'user', text: '今天该复习哪些？', at: t0.toISOString(), event_id: askId },
      {
        role: 'ai',
        text: '有 3 道题到期。',
        at: new Date('2026-06-04T10:00:05.000Z').toISOString(),
        event_id: replyId,
      },
    ]);
  });

  it('caps to limit turns (newest kept), returned chronologically', async () => {
    const sessionId = `ls_${createId()}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(`2026-06-04T1${i}:00:00.000Z`);
      ids.push(await writeAsk(`q${i}`, sessionId, at));
    }
    const turns = await getRecentCopilotTurns(db, { limit: 2 });
    const ours = turns.filter((t) => ids.includes(t.event_id));
    // Newest two asks (q3, q4) kept; chronological order q3 then q4.
    expect(ours.map((t) => t.text)).toEqual(['q3', 'q4']);
  });
});

describe('runCopilotChat — conversation session envelope (S3a)', () => {
  const runAgentTaskFn = async () => ({
    task_run_id: 'task_copilot_db',
    text: '已读到你的错题。',
    finishReason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  const buildMcpServerFn = () => ({ name: 'fake-loom' }) as never;

  it('find-or-creates a conversation session, persists ask + reply, and reuses within 24h', async () => {
    // Explicit, increasing `now` per turn so the replay ordering is deterministic
    // (the whole turn shares one `now`; the reply is stamped now+1ms in chat.ts).
    const t1 = new Date('2026-06-04T12:00:00.000Z');
    const t2 = new Date('2026-06-04T12:00:10.000Z');
    const first = await runCopilotChat(
      db,
      { user_message: '第一条消息', triggered_by: 'chat' },
      {
        runAgentTaskFn,
        buildMcpServerFn,
        loadProposalFeedbackFn: async () => [],
        now: () => t1,
      },
    );
    touchedSessionIds.push(first.session_id);
    writtenEventIds.push(first.reply_event_id);
    if (first.user_ask_event_id) writtenEventIds.push(first.user_ask_event_id);

    expect(first.session_id).toBeTruthy();
    expect(first.reply_event_id).toMatch(/^copilot_reply_/);

    // Session row exists, type=conversation, status=active, goal_id null (no item).
    const rows = await db
      .select()
      .from(learning_session)
      .where(inArray(learning_session.id, [first.session_id]));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('conversation');
    expect(rows[0].status).toBe('active');
    expect(rows[0].goal_id).toBeNull();

    // A second turn reuses the same session (within the 24h reuse window).
    const second = await runCopilotChat(
      db,
      { user_message: '第二条消息', triggered_by: 'chat' },
      {
        runAgentTaskFn,
        buildMcpServerFn,
        loadProposalFeedbackFn: async () => [],
        now: () => t2,
      },
    );
    writtenEventIds.push(second.reply_event_id);
    if (second.user_ask_event_id) writtenEventIds.push(second.user_ask_event_id);
    expect(second.session_id).toBe(first.session_id);

    // Replay returns both turns of this session in chronological order.
    const turns = await getRecentCopilotTurns(db, { limit: 20 });
    const texts = turns
      .filter(
        (t) =>
          t.event_id === first.reply_event_id ||
          t.event_id === second.reply_event_id ||
          t.event_id === first.user_ask_event_id ||
          t.event_id === second.user_ask_event_id,
      )
      .map((t) => t.text);
    expect(texts).toEqual(['第一条消息', '已读到你的错题。', '第二条消息', '已读到你的错题。']);
  });
});
