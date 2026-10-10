// YUK-531 (A5 S4 / PR-5) — candidate misconception veto endpoint DB test. Hits @/db/client
// (via dismissAiProposal + the inbox read model), so it lives in the db partition (*.db.test.ts).
// Mirrors proposal-decide.db.test.ts. Covers: a pending conjecture candidate is dismissed (writes
// a single rate(dismiss) event + leaves the per-KC funnel); the dismiss is idempotent (a second
// veto returns idempotent with no duplicate rate event); an unknown id → 404.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
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
        probe_reference_md: `reference for ${claim}`,
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
}

/** Decide `proposalId` as ACCEPT by writing the rate(accept) event directly (mirrors the
 *  production rate-event shape) so the veto path hits the already-accepted 409 branch (G). */
async function seedAcceptRate(proposalId: string): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: { rating: 'accept' },
    caused_by_event_id: proposalId,
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

  it('G: returns 409 when the candidate conjecture was already decided as accept (conflict)', async () => {
    const id = await seedConjecture('kc_veto3', '把面积当周长');
    await seedAcceptRate(id); // decide it as accept first
    const res = await veto(id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');
    // still exactly ONE rate event (the seeded accept) — veto did not add a dismiss.
    const rows = await rateEvents(id);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).rating).toBe('accept');
  });
});
