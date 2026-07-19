// YUK-710 (P0F/6) — teaching-brief interaction ledger DB contract.
//
// Locks the append-only, deterministically-idempotent seen / action-start writes: one row per
// brief × local day (seen) and per brief × action_kind × local day (action), so a re-render /
// refetch / reload / double-click never inflates the ledger; a genuinely concurrent double-write
// still lands a single row (PK conflict); a new learner-local day opens a fresh row; and every
// row opts out of mem0 (ingest_at set + empty affected_scopes) and writes NO learner state.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { BRIEF_SEEN_ACTION, PRIMARY_ACTION_STARTED_ACTION } from '@/core/schema/conjecture';
import { event, material_fsrs_state } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { recordBriefSeen, recordPrimaryActionStarted } from '../server/teaching-brief-interactions';
import { TeachingBriefInteractionResponseSchema } from './contracts';
import { POST } from './teaching-brief-interaction';

// 2026-07-10 09:00 BJT — well inside a single Shanghai day.
const DAY1 = new Date('2026-07-10T01:00:00.000Z');
// 2026-07-11 04:00 BJT — a DIFFERENT Shanghai day than DAY1 (20:00Z + 8h rolls the date).
const DAY2 = new Date('2026-07-10T20:00:00.000Z');

async function rows(action: string, briefId: string) {
  return testDb()
    .select()
    .from(event)
    .where(
      and(eq(event.action, action), eq(event.subject_kind, 'event'), eq(event.subject_id, briefId)),
    );
}

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/prep-desk/brief/interaction', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('teaching-brief interaction ledger (YUK-710)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('brief_seen writes one opt-out row carrying only state + timestamps', async () => {
    const res = await recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1);
    expect(res.idempotent).toBe(false);
    expect(res.local_day).toBe('2026-07-10');

    const seen = await rows(BRIEF_SEEN_ACTION, 'b1');
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({
      brief_state: 'finding',
      local_day: '2026-07-10',
      seen_at: DAY1.toISOString(),
    });
    // Never carries learner content (claim / basis / answer).
    expect(seen[0].payload).not.toHaveProperty('claim_md');
    // mem0 opt-out: ingest_at stamped + affected_scopes empty (so brief scans ignore it).
    expect(seen[0].ingest_at).not.toBeNull();
    expect(seen[0].affected_scopes).toEqual([]);
    expect(seen[0].caused_by_event_id).toBe('b1');
    // ND: zero FSRS state rows written.
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
  });

  it('brief_seen is idempotent per brief × local day (re-render / refetch never inflates)', async () => {
    const first = await recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1);
    expect(first.idempotent).toBe(false);

    // Same brief, same day, even a later instant + a different observed state → no second row.
    const again = await recordBriefSeen(
      testDb(),
      { briefId: 'b1', briefState: 'probe_ready' },
      new Date('2026-07-10T09:00:00.000Z'),
    );
    expect(again.idempotent).toBe(true);
    expect(again.interaction_event_id).toBe(first.interaction_event_id);
    expect(await rows(BRIEF_SEEN_ACTION, 'b1')).toHaveLength(1);
  });

  it('brief_seen opens a fresh row on a new learner-local day', async () => {
    await recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1);
    const nextDay = await recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY2);
    expect(nextDay.idempotent).toBe(false);
    expect(nextDay.local_day).toBe('2026-07-11');
    expect(await rows(BRIEF_SEEN_ACTION, 'b1')).toHaveLength(2);
  });

  it('concurrent brief_seen double-write lands exactly one row', async () => {
    const [a, b] = await Promise.all([
      recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1),
      recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1),
    ]);
    expect(a.interaction_event_id).toBe(b.interaction_event_id);
    expect(await rows(BRIEF_SEEN_ACTION, 'b1')).toHaveLength(1);
  });

  it('primary_action_started is idempotent per brief × kind × day, but distinct kinds coexist', async () => {
    const accept = await recordPrimaryActionStarted(
      testDb(),
      { briefId: 'b1', actionKind: 'accept_probe' },
      DAY1,
    );
    expect(accept.idempotent).toBe(false);

    // Same kind + day → double-click no-op.
    const acceptAgain = await recordPrimaryActionStarted(
      testDb(),
      { briefId: 'b1', actionKind: 'accept_probe' },
      DAY1,
    );
    expect(acceptAgain.idempotent).toBe(true);

    // A different kind on the SAME brief + day is a distinct funnel step → its own row.
    const answer = await recordPrimaryActionStarted(
      testDb(),
      { briefId: 'b1', actionKind: 'answer_probe' },
      DAY1,
    );
    expect(answer.idempotent).toBe(false);

    expect(await rows(PRIMARY_ACTION_STARTED_ACTION, 'b1')).toHaveLength(2);
  });

  it('primary_action_started records scoped_practice with its result_event_id join key', async () => {
    await recordPrimaryActionStarted(
      testDb(),
      { briefId: 'b1', actionKind: 'scoped_practice', resultEventId: 'res_1' },
      DAY1,
    );
    const [row] = await rows(PRIMARY_ACTION_STARTED_ACTION, 'b1');
    expect(row.payload).toMatchObject({
      action_kind: 'scoped_practice',
      result_event_id: 'res_1',
      local_day: '2026-07-10',
    });
    // No answer text ever recorded.
    expect(row.payload).not.toHaveProperty('answer_md');
    expect(row.ingest_at).not.toBeNull();
    expect(row.affected_scopes).toEqual([]);
  });

  it('route POST returns 201 on a fresh seen then 200 on the idempotent repeat', async () => {
    const first = await post({ type: 'brief_seen', brief_id: 'b1', brief_state: 'finding' });
    expect(first.status).toBe(201);
    const firstBody = TeachingBriefInteractionResponseSchema.parse(await first.json());
    expect(firstBody.idempotent).toBe(false);
    expect(first.headers.get('Location')).toBe(
      `/api/events/${encodeURIComponent(firstBody.interaction_event_id)}`,
    );

    const second = await post({ type: 'brief_seen', brief_id: 'b1', brief_state: 'finding' });
    expect(second.status).toBe(200);
    expect(second.headers.get('Location')).toBeNull();
    const secondBody = TeachingBriefInteractionResponseSchema.parse(await second.json());
    expect(secondBody.idempotent).toBe(true);
    expect(secondBody.interaction_event_id).toBe(firstBody.interaction_event_id);
  });

  it('route POST 400 on a malformed / unknown-type body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ type: 'brief_seen', brief_id: '' })).status).toBe(400);
    expect((await post({ type: 'unknown', brief_id: 'b1' })).status).toBe(400);
    expect(
      (await post({ type: 'primary_action_started', brief_id: 'b1', action_kind: 'nope' })).status,
    ).toBe(400);
    // result_event_id is scoped_practice-only — a non-scoped action carrying it is rejected.
    expect(
      (
        await post({
          type: 'primary_action_started',
          brief_id: 'b1',
          action_kind: 'accept_probe',
          result_event_id: 'evt_x',
        })
      ).status,
    ).toBe(400);
  });
});
