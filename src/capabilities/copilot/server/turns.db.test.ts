// AF S3a / YUK-203 U3 — db test for getRecentCopilotTurns + the conversation
// session envelope wired into runCopilotChat.
//
// Runs in the db vitest config (real Postgres testcontainer) because it goes
// through writeEvent + the learning_session table.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCopilotChat } from '@/capabilities/copilot/server/chat';
import { getRecentCopilotTurns } from '@/capabilities/copilot/server/turns';
import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { Conversation } from '@/server/session';

const writtenEventIds: string[] = [];
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

// PR #305 review comment #2 — seed a copilot_reply that carries a skill_turn in
// the payload (simulates what runCopilotChat writes for a teaching ask_check turn).
// PR round-2 — optionally also carries skill_context.
async function writeReplyWithSkillTurn(
  text: string,
  sessionId: string,
  inReplyTo: string,
  at: Date,
  skillTurn: object,
  skillContext?: object,
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
      task_run_id: 'task_y',
      in_reply_to_event_id: inReplyTo,
      skill_turn: skillTurn,
      ...(skillContext ? { skill_context: skillContext } : {}),
    },
    caused_by_event_id: inReplyTo,
    task_run_id: 'task_y',
    created_at: at,
  });
  return id;
}

// YUK-307 — seed a copilot_reply that carries a primary_view in the payload
// (simulates what chat.ts persists for a hero-nominating free-form reply).
// `primaryView` is deliberately unknown-typed so malformed shapes can be seeded.
async function writeReplyWithPrimaryView(
  text: string,
  sessionId: string,
  inReplyTo: string,
  at: Date,
  primaryView: unknown,
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
      task_run_id: 'task_pv',
      in_reply_to_event_id: inReplyTo,
      primary_view: primaryView,
    },
    caused_by_event_id: inReplyTo,
    task_run_id: 'task_pv',
    created_at: at,
  });
  return id;
}

describe('getRecentCopilotTurns', () => {
  it('returns ask+reply pairs oldest→newest with role/text/at/event_id', async () => {
    // Seed a real live Copilot session so the reader can resolve it; events are
    // scoped to it via the session_id column.
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-04T10:00:00.000Z');
    const askId = await writeAsk('今天该复习哪些？', sessionId, t0);
    const replyId = await writeReply(
      '有 3 道题到期。',
      sessionId,
      askId,
      new Date('2026-06-04T10:00:05.000Z'),
    );

    const turns = await getRecentCopilotTurns(db, { now });
    // Only this session's two events exist among our written ids; assert they
    // are present, ordered, and shaped.
    const ours = turns.filter((t) => t.event_id === askId || t.event_id === replyId);
    // User turns have no session_id/reply_event_id/skill_turn/skill_context.
    expect(ours[0]).toEqual({
      role: 'user',
      text: '今天该复习哪些？',
      at: t0.toISOString(),
      event_id: askId,
    });
    // AI turns carry session_id + reply_event_id (PR round-2 CR 3360614432).
    expect(ours[1]).toEqual({
      role: 'ai',
      text: '有 3 道题到期。',
      at: new Date('2026-06-04T10:00:05.000Z').toISOString(),
      event_id: replyId,
      session_id: sessionId,
      reply_event_id: replyId,
    });
  });

  it('caps to limit turns (newest kept), returned chronologically', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(`2026-06-04T1${i}:00:00.000Z`);
      ids.push(await writeAsk(`q${i}`, sessionId, at));
    }
    const turns = await getRecentCopilotTurns(db, { limit: 2, now });
    const ours = turns.filter((t) => ids.includes(t.event_id));
    // Newest two asks (q3, q4) kept; chronological order q3 then q4.
    expect(ours.map((t) => t.text)).toEqual(['q3', 'q4']);
  });

  // codex #3356884484 — replay must be scoped to the CURRENT reusable session.
  // A stale prior conversation (last active >24h ago, so find-or-create would
  // start a fresh session) must NOT have its turns preloaded into what the
  // server treats as a new conversation.
  it('does NOT replay a stale (>24h) session — returns nothing when no live session exists', async () => {
    const now = new Date('2026-06-04T12:00:00.000Z');
    // A session whose updated_at is 48h before `now` → outside the 24h reuse
    // window, so findReusableCopilotConversation(now) returns null.
    const staleNow = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const staleSession = await createLiveCopilotSession(staleNow);
    const askId = await writeAsk('过期会话的问题', staleSession, staleNow);
    await writeReply('过期会话的回复', staleSession, askId, new Date(staleNow.getTime() + 1000));

    // No live reusable session at `now` → reader returns empty (fresh start).
    const turns = await getRecentCopilotTurns(db, { now });
    expect(turns).toEqual([]);
  });

  // codex #3356884484 — with BOTH a stale session and a fresh live session
  // present, only the live session's turns are replayed; the stale session's
  // turns are never mixed in.
  it('replays only the live session, not an older stale one', async () => {
    const now = new Date('2026-06-04T12:00:00.000Z');
    const staleNow = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const staleSession = await createLiveCopilotSession(staleNow);
    const staleAsk = await writeAsk('旧会话问题', staleSession, staleNow);

    // A fresh live session (updated_at = now) is the one find-or-create reuses.
    const liveSession = await createLiveCopilotSession(now);
    const liveAsk = await writeAsk('新会话问题', liveSession, now);
    const liveReply = await writeReply(
      '新会话回复',
      liveSession,
      liveAsk,
      new Date(now.getTime() + 1000),
    );

    const turns = await getRecentCopilotTurns(db, { now });
    const texts = turns.map((t) => t.text);
    expect(texts).toEqual(['新会话问题', '新会话回复']);
    // The stale session's turn is absent.
    expect(turns.some((t) => t.event_id === staleAsk)).toBe(false);
    expect(turns.some((t) => t.event_id === liveAsk)).toBe(true);
    expect(turns.some((t) => t.event_id === liveReply)).toBe(true);
  });

  // PR #305 review comment #2 — ask_check skill_turn is persisted in the reply
  // payload so replay can surface the question card without re-running the LLM.
  it('replay surfaces skill_turn on AI turns that carried a teaching ask_check', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-05T10:00:00.000Z');
    const t1 = new Date('2026-06-05T10:00:05.000Z');
    const askId = await writeAsk('帮我讲讲这个', sessionId, t0);
    const skillTurnPayload = {
      kind: 'ask_check',
      suggested_next: 'continue',
      structured_question: {
        id: 'q_replay_test',
        kind: 'short_answer',
        prompt_md: '请解释「之」的用法。',
        choices_md: null,
      },
    };
    const replyId = await writeReplyWithSkillTurn(
      '这里的「之」是代词。请作答。',
      sessionId,
      askId,
      t1,
      skillTurnPayload,
    );

    const turns = await getRecentCopilotTurns(db, { now });
    const ours = turns.filter((t) => t.event_id === askId || t.event_id === replyId);
    expect(ours).toHaveLength(2);
    const aiTurn = ours.find((t) => t.role === 'ai');
    expect(aiTurn?.skill_turn).toEqual({
      kind: 'ask_check',
      suggested_next: 'continue',
      structured_question: {
        id: 'q_replay_test',
        kind: 'short_answer',
        prompt_md: '请解释「之」的用法。',
        choices_md: null,
      },
    });
    // PR round-2 (CR 3360614432): AI turns carry session_id + reply_event_id.
    expect(aiTurn?.session_id).toBe(sessionId);
    expect(aiTurn?.reply_event_id).toBe(replyId);
    // User turns never carry skill_turn / session_id / reply_event_id.
    const userTurn = ours.find((t) => t.role === 'user');
    expect(userTurn?.skill_turn).toBeUndefined();
    expect(userTurn?.session_id).toBeUndefined();
  });

  // Replies without skill_turn in payload have undefined skill_turn in the turn.
  it('replay omits skill_turn for plain (non-skill) AI replies', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-05T11:00:00.000Z');
    const askId = await writeAsk('随便问问', sessionId, t0);
    const replyId = await writeReply(
      '好的，随便聊。',
      sessionId,
      askId,
      new Date(t0.getTime() + 1000),
    );

    const turns = await getRecentCopilotTurns(db, { now });
    const aiTurn = turns.find((t) => t.event_id === replyId);
    expect(aiTurn?.skill_turn).toBeUndefined();
    // Plain AI replies still carry session_id + reply_event_id.
    expect(aiTurn?.session_id).toBe(sessionId);
    expect(aiTurn?.reply_event_id).toBe(replyId);
  });

  // PR round-2 (CR 3360614441): skill_context persisted in payload so replay can
  // restore the skill card after page refresh.
  it('replay surfaces skill_context on AI turns that carried a skill', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-05T12:00:00.000Z');
    const t1 = new Date('2026-06-05T12:00:05.000Z');
    const askId = await writeAsk('讲讲这道题', sessionId, t0);
    const skillContext = { skill: 'teaching', ref: { kind: 'learning_item', id: 'li_ctx_test' } };
    const replyId = await writeReplyWithSkillTurn(
      '好，我们来分析。',
      sessionId,
      askId,
      t1,
      { kind: 'explain', suggested_next: 'continue' },
      skillContext,
    );

    const turns = await getRecentCopilotTurns(db, { now });
    const aiTurn = turns.find((t) => t.event_id === replyId);
    expect(aiTurn?.skill_context).toEqual(skillContext);
    // User turns never carry skill_context.
    const userTurn = turns.find((t) => t.event_id === askId);
    expect(userTurn?.skill_context).toBeUndefined();
  });

  // YUK-307 (S3a additive) — primary_view persisted on the reply payload
  // round-trips through the reader for all three RULED source shapes
  // (presentation layer §2.3), so Dock replay can restore the hero nomination.
  it('replay surfaces primary_view for all three ruled source shapes', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-08T10:00:00.000Z');
    const askId = await writeAsk('出一道题', sessionId, t0);
    const shapes = [
      { source: 'tool_result', ref: { kind: 'tool_call', id: 'tc_1' } },
      { source: 'artifact', ref: { kind: 'question', id: 'q_1' } },
      { source: 'ephemeral_html', ref: '<div>互动元素周期表</div>' },
    ];
    const replyIds: string[] = [];
    for (const [i, pv] of shapes.entries()) {
      replyIds.push(
        await writeReplyWithPrimaryView(
          `回复 ${i}`,
          sessionId,
          askId,
          new Date(t0.getTime() + 1000 * (i + 1)),
          pv,
        ),
      );
    }

    const turns = await getRecentCopilotTurns(db, { now });
    for (const [i, pv] of shapes.entries()) {
      const aiTurn = turns.find((t) => t.event_id === replyIds[i]);
      expect(aiTurn?.primary_view).toEqual(pv);
      expect(aiTurn?.text).toBe(`回复 ${i}`);
    }
    // User turns never carry primary_view; plain replies (writeReply) don't either.
    const userTurn = turns.find((t) => t.event_id === askId);
    expect(userTurn?.primary_view).toBeUndefined();
  });

  // YUK-307 — a malformed persisted primary_view is dropped (field omitted, the
  // hand-rolled narrower mirrors replySkillContext) while the turn itself still
  // returns with its text: replay is best-effort prefill, never the SoT.
  it('replay omits a malformed primary_view but still returns the turn', async () => {
    const now = new Date();
    const sessionId = await createLiveCopilotSession(now);
    const t0 = new Date('2026-06-08T11:00:00.000Z');
    const askId = await writeAsk('坏形状', sessionId, t0);
    const badShapes: unknown[] = [
      { source: 'bogus', ref: { kind: 'x', id: 'y' } },
      { source: 'artifact', ref: 42 },
      { source: 'ephemeral_html', ref: { kind: 'not-a-string', id: 'z' } },
      'not-an-object',
    ];
    const replyIds: string[] = [];
    for (const [i, pv] of badShapes.entries()) {
      replyIds.push(
        await writeReplyWithPrimaryView(
          `坏形状回复 ${i}`,
          sessionId,
          askId,
          new Date(t0.getTime() + 1000 * (i + 1)),
          pv,
        ),
      );
    }

    const turns = await getRecentCopilotTurns(db, { now });
    for (const [i] of badShapes.entries()) {
      const aiTurn = turns.find((t) => t.event_id === replyIds[i]);
      expect(aiTurn?.text).toBe(`坏形状回复 ${i}`);
      expect(aiTurn?.primary_view).toBeUndefined();
    }
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

    // Replay returns both turns of this session in chronological order. Anchor
    // the reader at t2 so the reuse window is evaluated deterministically against
    // the session's updated_at (codex #3356884484 scoping).
    const turns = await getRecentCopilotTurns(db, { limit: 20, now: t2 });
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
