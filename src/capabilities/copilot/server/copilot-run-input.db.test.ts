// YUK-575 (A1/MF-B, PR1) — shared Copilot run-input assembler DB test.
//
// Runs in the db vitest config (real Postgres testcontainer): it exercises the
// REAL getRecentCopilotTurns exclude cursor (MF-B) against seeded events, which is
// the correctness core the panel flagged — a durable pickup must NOT double-count
// its own just-written user_ask and must NOT shove out the oldest real turn.
//
// The learner-state resolver is injected (a fixture) so the test isolates the
// history-exclusion + assembly logic; a separate unit test covers the degrade
// paths without a DB.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assembleCopilotRunInput } from '@/capabilities/copilot/server/copilot-run-input';
import type { LearnerStateHeader } from '@/capabilities/copilot/server/learner-state';
import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { Conversation } from '@/server/session';

const writtenEventIds: string[] = [];
const touchedSessionIds: string[] = [];

async function createLiveCopilotSession(now: Date): Promise<string> {
  const { sessionId } = await Conversation.findOrCreateCopilotConversation(db, { now });
  touchedSessionIds.push(sessionId);
  return sessionId;
}

// The reader resolves the single most-recent reusable Copilot session across the
// whole table, so terminate any pre-existing live conversation rows before each test.
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

async function writeAsk(
  text: string,
  sessionId: string,
  at: Date,
  idArg?: string,
): Promise<string> {
  const id = idArg ?? `copilot_user_ask_${createId()}`;
  writtenEventIds.push(id);
  await writeEvent(db, {
    id,
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

// Injected learner-state fixture: an empty header keeps the assembled history equal
// to the real turns (no pinned context entry), so the exclusion assertions are clean.
const emptyLearnerState = async (): Promise<LearnerStateHeader> => ({
  header_md: '',
  proposal_feedback: [],
});

function userTexts(history: { role: string; text: string }[]): string[] {
  return history.filter((h) => h.role === 'user').map((h) => h.text);
}

describe('assembleCopilotRunInput — MF-B durable exclude cursor', () => {
  it('durable: excludeUserAskEventId drops the current ask AND keeps the oldest real turn', async () => {
    const t0 = new Date('2026-07-07T10:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);

    // One prior complete turn (oldest real user turn + its reply), then the durable
    // dispatch has ALREADY written the current ask (durable time-model: write-then-pickup).
    const oldestAsk = await writeAsk('第一轮问题', sessionId, new Date('2026-07-07T10:01:00Z'));
    await writeReply('第一轮回答', sessionId, oldestAsk, new Date('2026-07-07T10:01:30Z'));
    const currentAskId = `copilot_user_ask_${createId()}`;
    await writeAsk('当前这轮问题', sessionId, new Date('2026-07-07T10:02:00Z'), currentAskId);

    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '当前这轮问题',
        triggeredBy: 'chat',
        now: new Date('2026-07-07T10:02:01Z'),
        excludeUserAskEventId: currentAskId,
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    const users = userTexts(runInput.conversation_history);
    // The current ask is EXCLUDED (not double-counted as the newest user turn)...
    expect(users).not.toContain('当前这轮问题');
    // ...and the oldest real turn is NOT shoved out.
    expect(users).toContain('第一轮问题');
    // Shape byte-parity: run input carries the assembled fields.
    expect(runInput.surface).toBe('copilot');
    expect(runInput.triggered_by).toBe('chat');
    expect(runInput.user_message).toBe('当前这轮问题');
    expect(runInput.proposal_feedback).toEqual([]);
  });

  it('inline (no excludeUserAskEventId): read-before-write — history has no current ask because it is not yet written', async () => {
    const t0 = new Date('2026-07-07T11:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const priorAsk = await writeAsk('历史问题', sessionId, new Date('2026-07-07T11:01:00Z'));
    await writeReply('历史回答', sessionId, priorAsk, new Date('2026-07-07T11:01:30Z'));

    // Inline calls the assembler BEFORE writing the current ask, so the current ask
    // simply is not in the table yet. Omit excludeUserAskEventId.
    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: '当前内联问题',
        triggeredBy: 'chat',
        now: new Date('2026-07-07T11:02:00Z'),
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );

    const users = userTexts(runInput.conversation_history);
    expect(users).toContain('历史问题');
    expect(users).not.toContain('当前内联问题');
  });

  it('ambient + chip_kind ride the run input when present (S4)', async () => {
    const t0 = new Date('2026-07-07T12:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const runInput = await assembleCopilotRunInput(
      db,
      {
        sessionId,
        userMessage: 'q',
        triggeredBy: 'chip',
        chipKind: 'out_3_variants',
        ambient: { route: '/learn/x', focused_entity: { kind: 'knowledge', id: 'k_1' } },
        now: new Date('2026-07-07T12:00:01Z'),
      },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );
    expect(runInput.ambient_context).toEqual({
      route: '/learn/x',
      focused_entity: { kind: 'knowledge', id: 'k_1' },
    });
    expect(runInput.chip_kind).toBe('out_3_variants');
    expect(runInput.surface).toBe('copilot_user_suggested_mistake_action');
    expect(runInput.triggered_by).toBe('chip');
  });

  it('omits ambient_context / chip_kind keys when absent (byte-parity spread-when-present)', async () => {
    const t0 = new Date('2026-07-07T13:00:00Z');
    const sessionId = await createLiveCopilotSession(t0);
    const runInput = await assembleCopilotRunInput(
      db,
      { sessionId, userMessage: 'q', triggeredBy: 'chat', now: new Date('2026-07-07T13:00:01Z') },
      { resolveLearnerStateHeaderFn: emptyLearnerState },
    );
    expect('ambient_context' in runInput).toBe(false);
    expect('chip_kind' in runInput).toBe(false);
  });
});
