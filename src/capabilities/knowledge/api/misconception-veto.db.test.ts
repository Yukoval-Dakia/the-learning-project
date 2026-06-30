// YUK-531 (A5 S4 / PR-5) — candidate misconception veto endpoint DB test. Hits @/db/client
// (via dismissAiProposal + the inbox read model), so it lives in the db partition (*.db.test.ts).
// Mirrors proposal-decide.db.test.ts. Covers: a pending conjecture candidate is dismissed (writes
// a single rate(dismiss) event + leaves the per-KC funnel); the dismiss is idempotent (a second
// veto returns idempotent with no duplicate rate event); an unknown id → 404.

import { event } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadMisconceptionsForKc } from '../server/misconception-read';
import { POST } from './misconception-veto';

/** Seed ONE pending conjecture for `kcId`; returns its proposal event id (= the candidate id). */
async function seedConjecture(kcId: string, claim: string): Promise<string> {
  return writeAiProposal(testDb(), {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture' as const,
      target: { subject_kind: 'mind_model' as const, subject_id: kcId },
      reason_md: 'recurrent cause×KC failure cell + low θ precision',
      evidence_refs: [{ kind: 'event' as const, id: 'evt_seed' }],
      cooldown_key: `conjecture:${claim}`,
      proposed_change: {
        claim_md: claim,
        knowledge_id: kcId,
        cause_category: 'concept_misunderstanding',
        confidence: 0.5,
        recurrence_count: 3,
        probe_md: `probe for ${claim}`,
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
}

async function veto(id: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/knowledge/misconceptions/${id}/veto`, { method: 'POST' }),
    { id },
  );
}

async function rateEvents(proposalId: string) {
  return testDb()
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
}

describe('POST /api/knowledge/misconceptions/[id]/veto', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('dismisses a pending candidate conjecture and drops it from the per-KC funnel', async () => {
    const id = await seedConjecture('kc_veto', '把导数相乘当链式法则');

    // precondition: the conjecture surfaces as a candidate
    const before = await loadMisconceptionsForKc(testDb(), 'kc_veto');
    expect(before.map((r) => r.id)).toContain(id);

    const res = await veto(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('dismissed');

    // a single rate(dismiss) event is written, caused_by the proposal
    const rows = await rateEvents(id);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).rating).toBe('dismiss');

    // post: the dismissed conjecture leaves the pending funnel (status filtered out)
    const after = await loadMisconceptionsForKc(testDb(), 'kc_veto');
    expect(after.map((r) => r.id)).not.toContain(id);
  });

  it('is idempotent on a second veto (still 200, idempotent, no duplicate rate event)', async () => {
    const id = await seedConjecture('kc_veto2', '混淆顺承与转折');

    await veto(id);
    const res2 = await veto(id);
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { kind: string; idempotent?: boolean };
    expect(body.kind).toBe('dismissed');
    expect(body.idempotent).toBe(true);

    const rows = await rateEvents(id);
    expect(rows).toHaveLength(1); // no duplicate rate event
  });

  it('returns 404 for an unknown proposal id', async () => {
    const res = await veto('nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });
});
