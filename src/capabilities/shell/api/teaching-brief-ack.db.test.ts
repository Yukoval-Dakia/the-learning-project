// YUK-708 (P0F/4) — teaching-brief outcome acknowledgement DB contract.
//
// Locks the append-only, idempotent ack: one effective anchor per outcome (sequential
// re-ack + genuinely concurrent double-click), fail-closed target validation
// (400/404/409), the read-model eligibility drop, and ND-5 (zero FSRS writes).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { serveProbeOnce } from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { answerProbe } from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import { newId } from '@/core/ids';
import { BRIEF_ACK_ACTION } from '@/core/schema/conjecture';
import { event, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { writeAiProposal } from '@/server/proposals/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { TEACHING_BRIEF_OUTCOME_TTL_MS, loadTeachingBrief } from '../server/teaching-brief';
import { acknowledgeTeachingBriefOutcome } from '../server/teaching-brief-ack';
import { TeachingBriefAckResponseSchema } from './contracts';
import { POST } from './teaching-brief-ack';

const KC_ID = 'kn_chain_rule';

async function seedOutcome(
  resolution: 'confirmed' | 'retired',
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
  const result = await answerProbe({
    db: testDb(),
    probeQuestionId: served.probe_question_id,
    outcome: resolution === 'confirmed' ? 0 : 1,
    resolution,
    // `resultAt` stamps the outcome event's created_at to exercise the deliverability
    // time window (future / expired); defaults to real now for the happy path.
    ...(opts.resultAt ? { now: opts.resultAt } : {}),
  });
  return result.probe_result_event_id;
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

  it('writes exactly one append-only ack and echoes the brief provenance', async () => {
    const resultId = await seedOutcome('confirmed');

    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(201); // fresh create (REST convention, mirrors proposal-decisions)
    const body = TeachingBriefAckResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ probe_result_event_id: resultId, idempotent: false });
    expect(body.brief_id.length).toBeGreaterThan(0);
    // 201 Created carries a Location to the new event (RFC 7231 §6.3.2).
    expect(res.headers.get('Location')).toBe(
      `/api/events/${encodeURIComponent(body.brief_acknowledgement_event_id)}`,
    );

    const events = await ackEvents(resultId);
    expect(events).toHaveLength(1);
    // Append-only: carries brief provenance + timestamp only, never claim/answer.
    expect(events[0].payload).toMatchObject({ brief_id: body.brief_id });
    expect(events[0].caused_by_event_id).toBe(resultId);
    // ND-5: zero FSRS state rows written by the ack path.
    expect(await testDb().select().from(material_fsrs_state)).toHaveLength(0);
  });

  it('is idempotent — a repeated ack returns the same anchor, 201 then 200, no second event', async () => {
    const resultId = await seedOutcome('retired');

    const firstRes = await post({ probe_result_event_id: resultId });
    expect(firstRes.status).toBe(201);
    const first = TeachingBriefAckResponseSchema.parse(await firstRes.json());
    expect(first.idempotent).toBe(false);

    const secondRes = await post({ probe_result_event_id: resultId });
    expect(secondRes.status).toBe(200); // idempotent re-ack
    // 200 did not create anything → no Location header (RFC 7231 §6.3.2).
    expect(secondRes.headers.get('Location')).toBeNull();
    const second = TeachingBriefAckResponseSchema.parse(await secondRes.json());

    expect(second.idempotent).toBe(true);
    expect(second.brief_acknowledgement_event_id).toBe(first.brief_acknowledgement_event_id);
    expect(await ackEvents(resultId)).toHaveLength(1);
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

  it('concurrent double-click writes only one anchor (advisory-lock serialized)', async () => {
    const resultId = await seedOutcome('confirmed');

    const [a, b] = await Promise.all([
      acknowledgeTeachingBriefOutcome(testDb(), resultId),
      acknowledgeTeachingBriefOutcome(testDb(), resultId),
    ]);

    // Exactly one event id across both racers; the loser is idempotent:true.
    expect(a.brief_acknowledgement_event_id).toBe(b.brief_acknowledgement_event_id);
    expect(a.idempotent !== b.idempotent).toBe(true);
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

  it('drops the acknowledged outcome from brief eligibility end-to-end', async () => {
    const resultId = await seedOutcome('confirmed');
    const before = await loadTeachingBrief(testDb());
    expect(before.brief).toMatchObject({ state: 'outcome_confirmed' });

    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(201);

    // Only the acked outcome existed → quiet null after ack.
    await expect(loadTeachingBrief(testDb())).resolves.toEqual({ brief: null });
  });

  it('400 on a missing / malformed body', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it('404 when the target result event does not exist', async () => {
    const res = await post({ probe_result_event_id: newId() });
    expect(res.status).toBe(404);
  });

  // Round-6 (OCR minor): a real event id that is NOT a probe_result gets a precise 404
  // (the existence check filters on action=probe_result), not a misleading 409.
  it('404 when the target is a real event but not a probe_result', async () => {
    const notResultId = newId();
    await writeEvent(testDb(), {
      id: notResultId,
      actor_kind: 'system',
      actor_ref: 'test',
      action: 'experimental:not_a_probe_result',
      subject_kind: 'event',
      subject_id: 'evt_whatever',
      payload: { note: 'some other event' },
    });
    const res = await post({ probe_result_event_id: notResultId });
    expect(res.status).toBe(404);
    expect(await ackEvents(notResultId)).toHaveLength(0);
  });

  // Round-1 (codex P2): a probe_result that passes the surface "is a probe_result"
  // check but is CORRUPT must still fail-closed — the reader would never display it, so
  // acking it would mark an untraceable outcome as handled. Same canonical gate as the
  // reader (validateCanonicalProbeResult), so writer/reader semantics cannot drift.
  it('409 on a probe_result with an illegal resolution/outcome pair, zero append', async () => {
    const resultId = newId();
    await writeEvent(testDb(), {
      id: resultId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: 'q_probe_illegal',
      // Illegal: 'confirmed' must pair with outcome=0, not 1.
      payload: { conjecture_event_id: 'p_illegal', outcome: 1, resolution: 'confirmed' },
      caused_by_event_id: 'p_illegal',
    });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(409);
    expect(await ackEvents(resultId)).toHaveLength(0);
  });

  it('409 on a probe_result whose caused_by disagrees with conjecture_event_id, zero append', async () => {
    const resultId = newId();
    await writeEvent(testDb(), {
      id: resultId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: 'q_probe_incoherent',
      // Legal pair, but incoherent provenance: payload ref ≠ caused_by.
      payload: { conjecture_event_id: 'p_ref', outcome: 0, resolution: 'confirmed' },
      caused_by_event_id: 'p_different',
    });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(409);
    expect(await ackEvents(resultId)).toHaveLength(0);
  });

  // Round-2 (codex P2): the ack chain must mirror the reader's FULL gate, not just the
  // result body — an orphan-chain result (missing probe, or non-accepted proposal) is
  // never displayed by the brief, so it must not be ackable either.
  it('409 on a canonical result whose probe question is missing, zero append', async () => {
    const resultId = newId();
    await writeEvent(testDb(), {
      id: resultId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      // canonical result body, but subject points at a question that does not exist.
      subject_id: newId(),
      payload: { conjecture_event_id: 'p_orphan', outcome: 0, resolution: 'confirmed' },
      caused_by_event_id: 'p_orphan',
    });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(409);
    expect(await ackEvents(resultId)).toHaveLength(0);
  });

  it('409 on a result whose conjecture proposal is not accepted, zero append', async () => {
    // Full canonical chain (probe exists + canonical) but the proposal was never accepted
    // → the reader skips it as proposal_not_accepted, so the ack must 409.
    const resultId = await seedOutcome('confirmed', { accept: false });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(409);
    expect(await ackEvents(resultId)).toHaveLength(0);
  });

  // Round-4 (codex P2): the ack gate mirrors the reader's created_at deliverability window
  // too. An out-of-window outcome the brief would never deliver must not be ackable — and a
  // future result acked now would be NOT-EXISTS-excluded forever, never delivered later.
  it('409 on a future-dated result (not yet deliverable), zero append', async () => {
    const resultId = await seedOutcome('confirmed', {
      resultAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(409);
    expect(await ackEvents(resultId)).toHaveLength(0);
  });

  it('409 on an expired result (past the outcome TTL), zero append', async () => {
    const resultId = await seedOutcome('confirmed', {
      resultAt: new Date(Date.now() - TEACHING_BRIEF_OUTCOME_TTL_MS - 60 * 1000),
    });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(409);
    expect(await ackEvents(resultId)).toHaveLength(0);
  });

  // Round-5 (codex P2, final dimension): the ack must target the reader's CURRENT primary
  // outcome — an older, fully-valid outcome hidden behind a newer primary is not ackable
  // (would ack something the user never sees), and it resurfaces once the newer is acked.
  it('rejects a non-primary outcome hidden behind a newer one; it resurfaces after the primary is acked', async () => {
    const older = await seedOutcome('confirmed', {
      resultAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const newer = await seedOutcome('retired', {
      resultAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    // The older outcome is hidden behind the newer primary → not the current primary → 409.
    const hidden = await post({ probe_result_event_id: older });
    expect(hidden.status).toBe(409);
    expect(await ackEvents(older)).toHaveLength(0);

    // The newer outcome IS the current primary → ackable (fresh create → 201).
    expect((await post({ probe_result_event_id: newer })).status).toBe(201);

    // With the newer acked (NOT-EXISTS-excluded), the older resurfaces as primary → ackable.
    const resurfaced = await post({ probe_result_event_id: older });
    expect(resurfaced.status).toBe(201);
    expect(await ackEvents(older)).toHaveLength(1);
  });

  // Round-5 (OCR minor): a self-authored ack payload missing brief_id is a data-integrity
  // signal (wire contract requires min(1)), surfaced as 500 rather than papered over with ''.
  it('500 ack_payload_corrupt when an existing ack has no brief_id', async () => {
    const resultId = newId();
    await writeEvent(testDb(), {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: BRIEF_ACK_ACTION,
      subject_kind: 'event',
      subject_id: resultId,
      // Corrupt: an ack event without the required brief_id.
      payload: { acknowledged_at: new Date().toISOString() },
    });
    const res = await post({ probe_result_event_id: resultId });
    expect(res.status).toBe(500);
  });

  // Round-8 (codex P2): the primary verdict is read INSIDE the ack's advisory-locked tx, so it
  // reflects the latest committed state (verdict + append share one snapshot+lock). A newer
  // valid outcome that lands before the ack makes an older target non-primary → 409. This is
  // the deterministic surrogate for the snapshot↔append TOCTOU window (which cannot be
  // constructed deterministically); the in-tx read plus the full regression cover the rest.
  it('409 acking a target once a newer outcome has become the primary (in-tx verdict)', async () => {
    // The target is the sole, ackable primary at this instant.
    const target = await seedOutcome('confirmed', {
      resultAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    // A newer valid outcome lands and takes over as the primary.
    await seedOutcome('retired', { resultAt: new Date(Date.now() - 5 * 60 * 1000) });

    const res = await post({ probe_result_event_id: target });
    expect(res.status).toBe(409);
    expect(await ackEvents(target)).toHaveLength(0);
  });
});
