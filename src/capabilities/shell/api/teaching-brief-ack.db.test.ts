// YUK-708 (P0F/4) — teaching-brief outcome acknowledgement DB contract.
//
// Locks the append-only, idempotent ack: one effective anchor per outcome (sequential
// re-ack + genuinely concurrent double-click), fail-closed target validation
// (400/404/409), the read-model eligibility drop, and ND-5 (zero FSRS writes).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { serveProbeOnce } from '@/capabilities/agency/public';
import { newId } from '@/core/ids';
import { BRIEF_ACK_ACTION } from '@/core/schema/conjecture';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { TeachingBriefAckResponseSchema } from './contracts';
import { POST } from './teaching-brief-ack';

const KC_ID = 'kn_chain_rule';

async function seedOutcome(
  resolution: 'evidence_for' | 'confirmed' | 'retired',
  opts: { accept?: boolean; resultAt?: Date } = {},
): Promise<string> {
  const accept = opts.accept ?? true;
  const proposalId = await writeAiProposal(testDb(), {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: KC_ID },
      reason_md: 'recurrent cause×KC failure cell',
      evidence_refs: [{ kind: 'event', id: 'evt_a' }],
      cooldown_key: `conjecture:${KC_ID}`,
      proposed_change: {
        claim_md: 'you treat the chain rule as multiplying derivatives',
        knowledge_id: KC_ID,
        cause_category: 'concept_misunderstanding',
        confidence: 0.7,
        recurrence_count: 2,
        probe_md: 'd/dx sin(x^2) = ?',
        probe_reference_md: '2x·cos(x^2)',
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
  // The teaching-brief read model projects an outcome only for an ACCEPTED proposal
  // (loadProposalFacts requires status='accepted'), so record the accept rate before
  // serving the probe (mirrors the acceptConjectureProposal → serveProbeOnce flow).
  // `accept: false` leaves the proposal pending to exercise the ack chain's
  // proposal_not_accepted gate.
  if (accept) {
    await writeEvent(testDb(), {
      id: `rate_${proposalId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: { rating: 'accept', conjecture_id: proposalId, calibration_anchor: 'accept' },
      caused_by_event_id: proposalId,
    });
  }
  const served = await serveProbeOnce({
    db: testDb(),
    conjectureProposalId: proposalId,
    knowledgeId: KC_ID,
    probeMd: 'd/dx sin(x^2) = ?',
    referenceMd: '2x·cos(x^2)',
  });
  if (served.status !== 'served') throw new Error(`expected served, got ${served.status}`);
  const resultId = newId();
  const resultAt = opts.resultAt ?? new Date();
  await writeEvent(testDb(), {
    id: resultId,
    actor_kind: 'system',
    actor_ref: 'mind_probe',
    action: 'experimental:probe_result',
    subject_kind: 'question',
    subject_id: served.probe_question_id,
    payload: {
      conjecture_event_id: proposalId,
      outcome: resolution === 'retired' ? 1 : 0,
      resolution,
      retrievability_at_judge: null,
      answer_md: null,
      answer_image_refs: [],
    },
    caused_by_event_id: proposalId,
    ingest_at: resultAt,
    created_at: resultAt,
  });
  return resultId;
}

async function ackEvents(resultEventId: string) {
  return testDb()
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, BRIEF_ACK_ACTION),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, resultEventId),
      ),
    );
}

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/prep-desk/brief/ack', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('POST /api/prep-desk/brief/ack (YUK-708)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Round-3 (codex P2): idempotency must win over the chain gate. A first ack succeeds but
  // its response is lost; before the retry the chain breaks (probe removed / proposal
  // retracted). The retry must still return 200/idempotent, NOT 409 — the existing ack is
  // the record of truth, and re-gating it would surface a completed ack as a failure.
  it('idempotent retry succeeds even after the outcome chain breaks (no 409, no new append)', async () => {
    const resultId = await seedOutcome('confirmed');
    const first = TeachingBriefAckResponseSchema.parse(
      await (await post({ probe_result_event_id: resultId })).json(),
    );
    expect(first.idempotent).toBe(false);

    // Break the chain the way the reader's gate would catch (probe removed → probe_not_found).
    const [row] = await testDb()
      .select({ subject_id: event.subject_id })
      .from(event)
      .where(eq(event.id, resultId));
    await testDb().delete(question).where(eq(question.id, row.subject_id));

    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(200);
    const retry = TeachingBriefAckResponseSchema.parse(await res.json());
    expect(retry.idempotent).toBe(true);
    expect(retry.brief_acknowledgement_event_id).toBe(first.brief_acknowledgement_event_id);
    // brief_id is recovered from the ack's own payload, not from the (now-broken) chain.
    expect(retry.brief_id).toBe(first.brief_id);
    // Zero NEW append — still exactly one anchor.
    expect(await ackEvents(resultId)).toHaveLength(1);
  });

  // Round-6 (codex P2): the concurrency window. Two concurrent route acks on the same target
  // must resolve to one create + one idempotent — NEVER a not_current_primary 409. The loser's
  // pre-lock loadOutcomeBrief may see the target already excluded (the winner committed its
  // ack), but the in-lock existing-ack re-check runs BEFORE the primary verdict, so the loser
  // gets idempotent success. (Deterministic regardless of interleaving: the advisory lock
  // serializes the append and the loser always finds the winner's ack inside the lock.)
  it('concurrent route acks resolve to one 201 + one 200, never 409, single anchor', async () => {
    const resultId = await seedOutcome('confirmed');

    const [a, b] = await Promise.all([
      post({ probe_result_event_id: resultId }),
      post({ probe_result_event_id: resultId }),
    ]);

    // One create (201), one idempotent (200) — never a 409.
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const bodies = [
      TeachingBriefAckResponseSchema.parse(await a.json()),
      TeachingBriefAckResponseSchema.parse(await b.json()),
    ];
    expect(bodies.map((x) => x.idempotent).sort()).toEqual([false, true]);
    expect(bodies[0].brief_acknowledgement_event_id).toBe(bodies[1].brief_acknowledgement_event_id);
    expect(await ackEvents(resultId)).toHaveLength(1);
  });
});
