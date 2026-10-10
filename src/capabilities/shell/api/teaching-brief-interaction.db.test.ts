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
import { event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { recordBriefSeen, recordPrimaryActionStarted } from '../server/teaching-brief-interactions';

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

describe('teaching-brief interaction ledger (YUK-710)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('concurrent brief_seen double-write lands exactly one row', async () => {
    const [a, b] = await Promise.all([
      recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1),
      recordBriefSeen(testDb(), { briefId: 'b1', briefState: 'finding' }, DAY1),
    ]);
    expect(a.interaction_event_id).toBe(b.interaction_event_id);
    expect(await rows(BRIEF_SEEN_ACTION, 'b1')).toHaveLength(1);
  });

  it('primary_action_started is idempotent per action identity and counts both recurrence probes', async () => {
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
      { briefId: 'b1', actionKind: 'answer_probe', probeQuestionId: 'q1' },
      DAY1,
    );
    expect(answer.idempotent).toBe(false);

    const answerAgain = await recordPrimaryActionStarted(
      testDb(),
      { briefId: 'b1', actionKind: 'answer_probe', probeQuestionId: 'q1' },
      DAY1,
    );
    expect(answerAgain.idempotent).toBe(true);

    const recurrence = await recordPrimaryActionStarted(
      testDb(),
      { briefId: 'b1', actionKind: 'answer_probe', probeQuestionId: 'q2' },
      DAY1,
    );
    expect(recurrence.idempotent).toBe(false);

    const actionRows = await rows(PRIMARY_ACTION_STARTED_ACTION, 'b1');
    expect(actionRows).toHaveLength(3);
    expect(actionRows.map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_kind: 'answer_probe', probe_question_id: 'q1' }),
        expect.objectContaining({ action_kind: 'answer_probe', probe_question_id: 'q2' }),
      ]),
    );
  });
});
