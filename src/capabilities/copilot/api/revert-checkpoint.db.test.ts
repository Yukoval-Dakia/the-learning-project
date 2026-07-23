import { event, learning_session } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './revert-checkpoint';

async function seedTurn(
  opts: {
    sessionId?: string;
    withReply?: boolean;
    childAction?: string;
  } = {},
): Promise<{ checkpointId: string; sessionId: string }> {
  const db = testDb();
  const now = new Date();
  const sessionId = opts.sessionId ?? 'copilot_current';
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'conversation',
    status: 'active',
    entrypoint: 'copilot',
    updated_at: now,
  });
  const checkpointId = `ask_${sessionId}`;
  await db.insert(event).values({
    id: checkpointId,
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: checkpointId,
    payload: { user_message: '撤回这一轮', session_id: sessionId },
    created_at: new Date(now.getTime() - 2),
  });
  if (opts.withReply !== false) {
    await db.insert(event).values({
      id: `child_${sessionId}`,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: 'experimental:copilot_reply',
      subject_kind: 'query',
      subject_id: `child_${sessionId}`,
      payload: { reply_md: '已完成' },
      caused_by_event_id: checkpointId,
      created_at: new Date(now.getTime() - 1),
    });
  }
  if (opts.childAction) {
    await db.insert(event).values({
      id: `unsupported_${sessionId}`,
      session_id: sessionId,
      actor_kind: 'agent',
      actor_ref: 'agent:copilot',
      action: opts.childAction,
      subject_kind: 'query',
      subject_id: `unsupported_${sessionId}`,
      payload: {},
      caused_by_event_id: checkpointId,
      created_at: now,
    });
  }
  return { checkpointId, sessionId };
}

function request(eventId: string): Request {
  return new Request(`http://test/api/copilot/checkpoints/${eventId}/revert`, { method: 'POST' });
}

describe('POST /api/copilot/checkpoints/:eventId/revert', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('reverts a terminal current-session typed ask and is idempotent', async () => {
    const { checkpointId } = await seedTurn();

    const first = await POST(request(checkpointId), { eventId: checkpointId });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      status: 'reverted',
      checkpoint_event_id: checkpointId,
    });

    const beforeRetry = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.actor_ref, 'cascade_revert')));
    const second = await POST(request(checkpointId), { eventId: checkpointId });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      status: 'already_reverted',
      checkpoint_event_id: checkpointId,
      compensation_event_ids: [],
    });
    const afterRetry = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.actor_ref, 'cascade_revert')));
    expect(afterRetry).toEqual(beforeRetry);
  });

  it('refuses a non-terminal turn without mutation', async () => {
    const { checkpointId } = await seedTurn({ withReply: false });
    const response = await POST(request(checkpointId), { eventId: checkpointId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'turn_not_terminal' });
    expect(await testDb().select().from(event).where(eq(event.action, 'correct'))).toEqual([]);
  });

  it('hides roots outside the current reusable Copilot session', async () => {
    const old = await seedTurn({ sessionId: 'copilot_old' });
    await seedTurn({ sessionId: 'copilot_current' });
    const response = await POST(request(old.checkpointId), { eventId: old.checkpointId });
    expect(response.status).toBe(404);
    expect(await testDb().select().from(event).where(eq(event.action, 'correct'))).toEqual([]);
  });

  it('atomically refuses unsupported descendants', async () => {
    const { checkpointId } = await seedTurn({ childAction: 'tool_use' });
    const response = await POST(request(checkpointId), { eventId: checkpointId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ refusal: 'irreversible' });
    expect(await testDb().select().from(event).where(eq(event.action, 'correct'))).toEqual([]);
  });
});
