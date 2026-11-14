// All event reads/writes funnel through src/kernel/events/events.ts. Tests seed
// the `event` table directly with hand-built KnownEvent-shaped rows.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { deterministicId } from '@/core/ids';
import { event } from '@/db/schema';
import { getProposalInboxRow, proposalLatestRateTerminalSql } from '@/kernel/proposals/inbox';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { eventCorrectionActiveSql, getCorrectionStatuses, writeEvent, writeEvents } from './index';

describe('writeEvent', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('keeps first-write-wins when duplicate ids appear inside one batch', async () => {
    const db = testDb();
    const id = 'evt-batch-duplicate';
    const base = {
      id,
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:test_batch',
      subject_kind: 'query',
      subject_id: 'batch',
      outcome: 'success',
    } as const;
    await writeEvents(db, [
      { ...base, payload: { ordinal: 1 } },
      { ...base, payload: { ordinal: 2 } },
    ]);

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ ordinal: 1 });
  });

  it('is idempotent under duplicate id (returns existing id, no second row)', async () => {
    const db = testDb();
    const id = deterministicId('evt_test', 'fixed1');
    const base = {
      id,
      session_id: null,
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'attempt' as const,
      subject_kind: 'question' as const,
      subject_id: 'q1',
      outcome: 'failure' as const,
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-01T00:00:00Z'),
    };
    const id1 = await writeEvent(db, base);
    const id2 = await writeEvent(db, {
      ...base,
      payload: { ...base.payload, answer_md: 'different' },
    });
    expect(id1).toBe(id);
    expect(id2).toBe(id);
    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    // First write wins (no overwrite on conflict)
    const payload = rows[0].payload as { answer_md: string };
    expect(payload.answer_md).toBe('wrong');
  });

  // @invariant data: SQL-only active-event predicates use the same winner order as canonical correction folding.
  // @fails-if a same-timestamp restore wins by dispatch_seq but the SQL predicate selects a later row by id and exposes the target as active.
  it('uses dispatch_seq before id for same-timestamp correction winners', async () => {
    const db = testDb();
    const sameClock = new Date('2026-05-01T00:00:00Z');
    const base = {
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'correct' as const,
      subject_kind: 'event' as const,
      subject_id: 'evt-correction-tiebreak',
      outcome: 'success' as const,
      caused_by_event_id: 'evt-correction-tiebreak',
      created_at: sameClock,
    };
    await db.insert(event).values({
      id: 'evt-correction-tiebreak',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:test_batch',
      subject_kind: 'event',
      subject_id: 'evt-correction-tiebreak',
      outcome: 'success',
      payload: {},
      created_at: sameClock,
    });
    await db.insert(event).values([
      {
        ...base,
        id: 'z_retract',
        payload: {
          correction_kind: 'retract' as const,
          reason_md: 'withdraw the event',
          affected_refs: [{ kind: 'question' as const, id: 'q1' }],
        },
        dispatch_seq: 1,
      },
      {
        ...base,
        id: 'a_restore',
        payload: {
          correction_kind: 'restore' as const,
          reason_md: 'restore the event',
          affected_refs: [{ kind: 'question' as const, id: 'q1' }],
        },
        dispatch_seq: 2,
      },
    ]);

    const [active] = await db
      .select({ active: eventCorrectionActiveSql(event.id) })
      .from(event)
      .where(eq(event.id, 'evt-correction-tiebreak'));
    expect(active?.active).toBe(true);
    const status = await getCorrectionStatuses(db, ['evt-correction-tiebreak']);
    expect(status.get('evt-correction-tiebreak')?.state).toBe('active');
  });

  // @invariant data: SQL-only proposal filtering agrees with the canonical latest-rate fold on same-clock rows.
  // @fails-if an older terminal rate wins by id despite a higher-dispatch_seq pending rate and the proposal is dropped as decided.
  it('uses dispatch_seq before id for same-timestamp proposal rates', async () => {
    const db = testDb();
    const sameClock = new Date('2026-05-01T00:00:00Z');
    const proposalId = 'evt-proposal-rate-tiebreak';
    await db.insert(event).values({
      id: proposalId,
      actor_kind: 'agent',
      actor_ref: 'test',
      action: 'experimental:proposal',
      subject_kind: 'evaluation',
      subject_id: 'eval-rate-tiebreak',
      outcome: 'partial',
      payload: {
        ai_proposal: {
          kind: 'judge_retraction',
          target: { subject_kind: 'evaluation', subject_id: 'eval-rate-tiebreak' },
          reason_md: 'regrade this judgment',
          evidence_refs: [],
          proposed_change: { evaluation_id: 'eval-rate-tiebreak' },
        },
      },
      created_at: sameClock,
    });
    await db.insert(event).values([
      {
        id: 'z_old_terminal',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: { rating: 'accept' },
        caused_by_event_id: proposalId,
        created_at: sameClock,
        dispatch_seq: 1,
      },
      {
        id: 'a_new_pending',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: proposalId,
        outcome: 'success',
        payload: { rating: 'pending' },
        caused_by_event_id: proposalId,
        created_at: sameClock,
        dispatch_seq: 2,
      },
    ]);

    const [terminal] = await db
      .select({ terminal: proposalLatestRateTerminalSql(event.id) })
      .from(event)
      .where(eq(event.id, proposalId));
    expect(terminal?.terminal).toBe(false);
    expect((await getProposalInboxRow(db, proposalId))?.status).toBe('pending');
  });
});
