import { event } from '@/db/schema';
// YUK-531 (A5 S4 / RT1) — gatherDissociationEvidence DB reader (Tier-1, dark).
// Proves the thin reader: it reads a KC's `experimental:prediction_score` LOG events, maps
// each to a DissociationRecord (fail-closed), distils the count summary, and — from today's
// UN-TAGGED live data (no m_diagnostic) — yields evidence that decideDissociation reduces to
// INSUFFICIENT (the hard track structurally cannot fire off current data).
import { decideDissociation, gatherDissociationEvidence } from '@/server/conjectures/hard-confirm';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

const PREDICTION_SCORE_ACTION = 'experimental:prediction_score';

interface ScorePayload {
  knowledge_id: string;
  predicted_p: number;
  baseline_p: number;
  outcome: 0 | 1;
  resolution: 'confirmed' | 'retired';
  probe_result_event_id: string;
  discriminating?: boolean;
  m_diagnostic?: boolean;
  context?: string;
  session_window?: string;
  judge_run_id?: string;
}

let seq = 0;
async function writeScore(payload: ScorePayload, createdAt: Date): Promise<void> {
  const db = testDb();
  seq += 1;
  await db.insert(event).values({
    id: `ps_${seq}`,
    actor_kind: 'system',
    actor_ref: 'research_meeting',
    action: PREDICTION_SCORE_ACTION,
    subject_kind: 'event',
    subject_id: payload.probe_result_event_id,
    payload,
    created_at: createdAt,
  });
}

describe('gatherDissociationEvidence', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
  });

  it('reads a KC prediction_score events, dedups tuples, and counts discriminating contexts', async () => {
    const db = testDb();
    // Two DISTINCT discriminating observations (fully-tagged synthetic data) …
    await writeScore(
      {
        knowledge_id: 'kn_chain_rule',
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_1',
        discriminating: true,
        m_diagnostic: true,
        context: 'symbolic',
        session_window: '2026-07-01',
        judge_run_id: 'r1',
      },
      new Date('2026-07-01T00:00:00Z'),
    );
    await writeScore(
      {
        knowledge_id: 'kn_chain_rule',
        predicted_p: 0.25,
        baseline_p: 0.75,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_2',
        discriminating: true,
        m_diagnostic: true,
        context: 'real_world',
        session_window: '2026-07-02',
        judge_run_id: 'r2',
      },
      new Date('2026-07-02T00:00:00Z'),
    );
    // … plus a self-consistency RERUN of pr_1 (same dedup tuple) — must collapse to one unit.
    await writeScore(
      {
        knowledge_id: 'kn_chain_rule',
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_1',
        discriminating: true,
        m_diagnostic: true,
        context: 'symbolic',
        session_window: '2026-07-01',
        judge_run_id: 'r1',
      },
      new Date('2026-07-01T00:05:00Z'),
    );
    // A DIFFERENT KC's event must be excluded by the reader's knowledge_id filter.
    await writeScore(
      {
        knowledge_id: 'kn_product_rule',
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_x',
        discriminating: true,
        m_diagnostic: true,
        context: 'symbolic',
        session_window: '2026-07-01',
        judge_run_id: 'rx',
      },
      new Date('2026-07-01T00:00:00Z'),
    );

    const ev = await gatherDissociationEvidence(db, { knowledgeId: 'kn_chain_rule' });

    expect(ev.nDedup).toBe(2); // pr_1 rerun collapsed, pr_2 distinct — other KC excluded
    expect(ev.contextSpread).toBe(2); // symbolic + real_world
    expect(ev.crucialConfirmedCount).toBe(3); // all three chain_rule rows are crucial+confirmed
    expect(ev.hasDiscriminatingContext).toBe(true);
    expect(ev.lastDiscriminatingActivation).toEqual(new Date('2026-07-02T00:00:00Z'));
  });

  it("with today's UN-TAGGED live data (no m_diagnostic) the hard track is DARK — INSUFFICIENT", async () => {
    const db = testDb();
    // Mirrors what the LIVE reconcile loop writes: scoring facts only, NO discrimination tags.
    for (let i = 1; i <= 3; i++) {
      await writeScore(
        {
          knowledge_id: 'kn_chain_rule',
          predicted_p: 0.2,
          baseline_p: 0.8,
          outcome: 0,
          resolution: 'confirmed',
          probe_result_event_id: `pr_${i}`,
        },
        new Date(`2026-07-0${i}T00:00:00Z`),
      );
    }

    const ev = await gatherDissociationEvidence(db, { knowledgeId: 'kn_chain_rule' });
    expect(ev.hasDiscriminatingContext).toBe(false);
    expect(ev.crucialConfirmedCount).toBe(0);

    // Even with the flag ON + a rival probe + fresh confirm, un-tagged data ⇒ INSUFFICIENT.
    expect(
      decideDissociation(ev, {
        hardConfirmEnabled: true,
        hasRivalProbe: true,
        ownerFreshlyConfirmed: true,
      }),
    ).toBe('INSUFFICIENT');
  });

  it('skips malformed prediction_score rows (fail-closed) without throwing', async () => {
    const db = testDb();
    // A row missing predicted_p / with a bad outcome must be dropped, not poison the summary.
    await db.insert(event).values({
      id: 'ps_bad',
      actor_kind: 'system',
      actor_ref: 'research_meeting',
      action: PREDICTION_SCORE_ACTION,
      subject_kind: 'event',
      subject_id: 'pr_bad',
      payload: { knowledge_id: 'kn_chain_rule', outcome: 7, resolution: 'confirmed' },
      created_at: new Date('2026-07-01T00:00:00Z'),
    });

    const ev = await gatherDissociationEvidence(db, { knowledgeId: 'kn_chain_rule' });
    expect(ev.nDedup).toBe(0);
    expect(ev.crucialConfirmedCount).toBe(0);

    // Sanity: the malformed row really was persisted (so the reader, not an empty table, dropped it).
    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, PREDICTION_SCORE_ACTION), eq(event.id, 'ps_bad')));
    expect(rows).toHaveLength(1);
  });
});
