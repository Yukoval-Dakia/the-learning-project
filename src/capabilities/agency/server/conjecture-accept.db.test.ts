// Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept applier lifecycle.
// Enters through the public dispatch shell (acceptAiProposal / dismissAiProposal)
// to cover the whole 「壳路由 → agency applier」 chain. Asserts the three
// semantics (accept = calibration anchor / edit → mem0 CORE / reject → digest),
// idempotency, and the ND-5 red line: NO FSRS / review row is ever written.

import {
  type ConjectureCoreWriter,
  PROBE_SLOTS_FULL_CODE,
  setConjectureCoreWriter,
} from '@/capabilities/agency/server/conjecture-accept';
import {
  MAX_CONCURRENT_ACTIVE_PROBES,
  PROBE_QUESTION_SOURCE,
  answerProbe,
  countActiveProbes,
  serveProbeOnce,
} from '@/capabilities/agency/server/conjecture/probe-lifecycle';
import {
  DEFAULT_MISCONCEPTION_WEIGHT,
  promoteConjectureToMisconception,
} from '@/capabilities/agency/server/misconception-promote';
import { loadPrepDeskConjectures } from '@/capabilities/shell/server/prep-desk';
import {
  event,
  material_fsrs_state,
  misconception,
  misconception_edge,
  question,
} from '@/db/schema';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

function baseConjecture() {
  return {
    kind: 'conjecture' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: 'kn_chain_rule' },
    reason_md: 'recurrent cause×KC failure cell + low θ precision',
    evidence_refs: [
      { kind: 'event' as const, id: 'evt_a' },
      { kind: 'event' as const, id: 'evt_b' },
    ],
    cooldown_key: 'conjecture:kn_chain_rule',
    proposed_change: {
      claim_md: 'you treat the chain rule as multiplying derivatives',
      knowledge_id: 'kn_chain_rule',
      cause_category: 'concept_misunderstanding',
      confidence: 0.7,
      recurrence_count: 2,
      probe_md: 'd/dx sin(x^2) = ?',
      probe_reference_md:
        '2x·cos(x^2) — outer cos × inner 2x (chain rule: outer-deriv × inner-deriv).',
      discriminating: true,
      predicted_p: 0.3,
      baseline_p_at_induction: 0.6,
    },
  };
}

async function rateEvents(proposalId: string) {
  const db = testDb();
  return db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
}

async function fsrsRowCount(): Promise<number> {
  const db = testDb();
  const rows = await db.select().from(material_fsrs_state);
  return rows.length;
}

async function misconceptionRows() {
  return testDb().select().from(misconception);
}

async function misconceptionEdgeRows() {
  return testDb().select().from(misconception_edge);
}

/** Probe questions served for a specific conjecture (source_ref = the proposal id). */
async function probeQuestionsFor(proposalId: string) {
  const db = testDb();
  return db
    .select()
    .from(question)
    .where(and(eq(question.source, PROBE_QUESTION_SOURCE), eq(question.source_ref, proposalId)));
}

async function allProbeQuestions() {
  return testDb().select().from(question).where(eq(question.source, PROBE_QUESTION_SOURCE));
}

/**
 * Fill N active mind_probe slots via direct serves (synthetic conjecture ids — the cap
 * only counts unanswered mind_probe question rows, so how they got there is irrelevant).
 * Returns the served probe question ids so a test can answer one to free a slot.
 */
async function fillProbeSlots(n: number): Promise<string[]> {
  const db = testDb();
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = await serveProbeOnce({
      db,
      conjectureProposalId: `cj_fill_${i}`,
      knowledgeId: 'kn_chain_rule',
      probeMd: `filler probe ${i}`,
      referenceMd: 'ref',
    });
    if (r.status !== 'served') throw new Error(`expected served filler, got ${r.status}`);
    ids.push(r.probe_question_id);
  }
  return ids;
}

describe('acceptConjectureProposal lifecycle', () => {
  let coreWriter: ReturnType<typeof vi.fn<ConjectureCoreWriter>>;

  beforeEach(async () => {
    await resetDb();
    // YUK-531 PR-3 — every test starts with the promotion flag OFF (dark default).
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
    coreWriter = vi.fn<ConjectureCoreWriter>(async () => {});
    setConjectureCoreWriter(coreWriter);
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.MISCONCEPTION_PROMOTE_ENABLED;
  });

  it('plain accept writes corrected_by_owner=false, no CORE write, no FSRS row', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    const result = await acceptAiProposal(db, proposalId);

    expect(result).toMatchObject({
      kind: 'conjecture',
      conjecture_id: proposalId,
      corrected_by_owner: false,
      weakness_confirmed: false,
    });

    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({
      rating: 'accept',
      conjecture_id: proposalId,
      corrected_by_owner: false,
      calibration_anchor: 'accept',
    });

    // accept = calibration anchor, NOT confirmed: no CORE write.
    expect(coreWriter).not.toHaveBeenCalled();
    // ND-5 red line — accept never enrolls / writes FSRS.
    expect(await fsrsRowCount()).toBe(0);
  });

  it('edit sets corrected_by_owner=true, writes the owner version to CORE, not confirmed, no FSRS', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    const result = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'you apply the chain rule but drop the inner factor' },
    });

    expect(result).toMatchObject({
      kind: 'conjecture',
      corrected_by_owner: true,
      weakness_confirmed: false,
    });

    expect(coreWriter).toHaveBeenCalledTimes(1);
    expect(coreWriter).toHaveBeenCalledWith({
      conjecture_id: proposalId,
      claim_md: 'you apply the chain rule but drop the inner factor',
      corrected_by_owner: true,
    });

    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({
      rating: 'accept',
      corrected_by_owner: true,
      calibration_anchor: 'edit',
      corrected_claim_md: 'you apply the chain rule but drop the inner factor',
    });

    // edit is still NOT a confirmed weakness — ND-5: no FSRS row.
    expect(await fsrsRowCount()).toBe(0);
  });

  it('reject dismisses with reason and never mints a weakness or CORE write', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    const result = await dismissAiProposal(db, proposalId, {
      user_note: 'wrong, I never confuse those',
    });

    expect(result.kind).toBe('dismissed');

    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload).toMatchObject({
      rating: 'dismiss',
      user_note: 'wrong, I never confuse those',
    });

    expect(coreWriter).not.toHaveBeenCalled();
    expect(await fsrsRowCount()).toBe(0);
  });

  it('re-accept is idempotent — single rate event, no second CORE write, no FSRS', async () => {
    const db = testDb();
    const proposalId = await writeAiProposal(db, {
      actor_ref: 'research_meeting',
      payload: baseConjecture(),
    });

    await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });
    coreWriter.mockClear();

    const again = await acceptAiProposal(db, proposalId, {
      corrected_payload: { claim_md: 'edited claim' },
    });

    expect(again).toMatchObject({ idempotent: true, corrected_by_owner: true });
    expect(coreWriter).not.toHaveBeenCalled();

    // Exactly one rate event survives — no double-anchor.
    const rates = await rateEvents(proposalId);
    expect(rates).toHaveLength(1);
    expect(await fsrsRowCount()).toBe(0);
  });

  // YUK-531 PR-3 — the dark, flag-gated misconception promotion hop.
  describe('misconception promotion (YUK-531 PR-3)', () => {
    it('flag OFF (default) — accept mints NO misconception and NO edge (dark regression)', async () => {
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);

      // Flag OFF ⇒ byte-identical to pre-PR-3: rate event written, zero promotion side-effects.
      const rates = await rateEvents(proposalId);
      expect(rates).toHaveLength(1);
      expect(await misconceptionRows()).toHaveLength(0);
      expect(await misconceptionEdgeRows()).toHaveLength(0);
      expect(await fsrsRowCount()).toBe(0);
    });

    it('flag ON — plain accept mints a soft/active misconception + caused_by edge, still no FSRS', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);

      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      const m = miscs[0];
      expect(m.title).toBe('you treat the chain rule as multiplying derivatives');
      // SOFT track, owner-accepted live node, recurrence salience, conjecture evidence ptrs.
      expect(m.source).toBe('soft');
      expect(m.status).toBe('active');
      expect(m.seen).toBe(2);
      expect(m.evidence).toEqual(['evt_a', 'evt_b']);
      expect(m.proposed_by_ai).toBe(true);

      const edges = await misconceptionEdgeRows();
      expect(edges).toHaveLength(1);
      const e = edges[0];
      expect(e.from_kind).toBe('misconception');
      expect(e.from_id).toBe(m.id);
      expect(e.to_kind).toBe('knowledge');
      expect(e.to_id).toBe('kn_chain_rule');
      expect(e.relation_type).toBe('caused_by');
      expect(e.archived_at).toBeNull();

      // ND-5 red line holds even on the promotion path — no FSRS/review row.
      expect(await fsrsRowCount()).toBe(0);
    });

    it('flag ON — re-accept is idempotent: one misconception, one edge, one rate', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId);
      await acceptAiProposal(db, proposalId);

      // The rate-event idempotency guard short-circuits the 2nd accept BEFORE the
      // promotion hop, so nothing double-writes.
      expect(await rateEvents(proposalId)).toHaveLength(1);
      expect(await misconceptionRows()).toHaveLength(1);
      expect(await misconceptionEdgeRows()).toHaveLength(1);
    });

    it('flag ON — edit accept uses the owner-corrected claim as the misconception title', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });

      await acceptAiProposal(db, proposalId, {
        corrected_payload: { claim_md: 'you apply the chain rule but drop the inner factor' },
      });

      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      expect(miscs[0].title).toBe('you apply the chain rule but drop the inner factor');
      // Edit still does NOT confirm a weakness — soft track, no FSRS.
      expect(miscs[0].source).toBe('soft');
      expect(await fsrsRowCount()).toBe(0);
    });

    it('flag ON — two DISTINCT proposals sharing cause×KC collapse to ONE misconception (cross-proposal UPSERT refreshes seen/evidence)', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();

      // Proposal A: the baseConjecture default — recurrence 2, evidence evt_a/evt_b.
      const proposalA = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await acceptAiProposal(db, proposalA);

      // Proposal B: a DIFFERENT proposal (fresh id) for the SAME cause×KC, with a higher
      // recurrence_count + fresh evidence — the cross-proposal re-induction case (NOT a
      // re-accept of the same proposal, which short-circuits at the rate guard BEFORE the
      // promote hop, so the onConflictDoUpdate SET branch only fires on this path).
      const second = baseConjecture();
      second.evidence_refs = [
        { kind: 'event' as const, id: 'evt_c' },
        { kind: 'event' as const, id: 'evt_d' },
        { kind: 'event' as const, id: 'evt_e' },
      ];
      second.proposed_change.recurrence_count = 3;
      const proposalB = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: second,
      });
      expect(proposalB).not.toBe(proposalA);
      await acceptAiProposal(db, proposalB);

      // Deterministic id keyed on cause×KC ⇒ both accepts UPSERT the SAME row: exactly
      // ONE misconception survives, refreshed to the SECOND accept's salience snapshot.
      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      const m = miscs[0];
      expect(m.seen).toBe(3);
      expect(m.evidence).toEqual(['evt_c', 'evt_d', 'evt_e']);
      expect(m.status).toBe('active');
      expect(m.source).toBe('soft');
      expect(m.archived_at).toBeNull();

      // And exactly ONE caused_by edge to the shared KC (idempotent / un-archived).
      const edges = await misconceptionEdgeRows();
      expect(edges).toHaveLength(1);
      expect(edges[0].relation_type).toBe('caused_by');
      expect(edges[0].to_id).toBe('kn_chain_rule');
      expect(edges[0].archived_at).toBeNull();
    });

    it('flag ON — promoting a conjecture with NaN/missing confidence does NOT throw; mints at the default weight', async () => {
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();

      // A legacy / hand-crafted conjecture missing `confidence` reaches the promote hop as
      // NaN (Number(undefined)). Pre-guard this threw a ZodError (the weight Zod rejects
      // NaN) that rolled back the owner's WHOLE accept — a 500. Drive the writer directly
      // with NaN (writeAiProposal's Zod would reject a missing-confidence payload, so a raw
      // legacy row is the only way it occurs) to prove the clamp-with-default guard: no
      // throw, a sane weight on BOTH the node and its caused_by edge.
      const result = await db.transaction((tx) =>
        promoteConjectureToMisconception(tx, {
          conjectureId: 'cj_legacy',
          knowledgeId: 'kn_chain_rule',
          claimMd: 'legacy conjecture lacking a confidence field',
          causeCategory: 'concept_misunderstanding',
          confidence: Number.NaN,
          recurrenceCount: 2,
          evidenceEventIds: ['evt_a'],
          now: new Date(),
        }),
      );

      const miscs = await misconceptionRows();
      expect(miscs).toHaveLength(1);
      expect(miscs[0].id).toBe(result.misconceptionId);
      expect(miscs[0].weight).toBe(DEFAULT_MISCONCEPTION_WEIGHT);

      const edges = await misconceptionEdgeRows();
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(DEFAULT_MISCONCEPTION_WEIGHT);
    });
  });

  // YUK-711 — the probe-slot-cap rollback. When all MAX_CONCURRENT_ACTIVE_PROBES
  // slots are taken, the accept must NOT commit a rate anchor / dark promotion with
  // no probe (the accepted-without-probe dangling chain the idempotency guard then
  // permanently blocks). Instead it throws a typed `probe_slots_full` ApiError inside
  // the accept tx so everything rolls back and the proposal stays pending for retry.
  describe('probe slot cap rollback (YUK-711)', () => {
    it('cap reached — accept throws typed probe_slots_full and rolls back rate + promotion + probe; proposal stays pending', async () => {
      // Flag ON so the dark misconception promotion is in-play and we prove it ALSO
      // rolls back — criterion 2 (zero half-written rate / promotion / probe rows).
      process.env.MISCONCEPTION_PROMOTE_ENABLED = '1';
      const db = testDb();

      // (1) Seed 3 active mind_probe questions — the cap is at MAX.
      await fillProbeSlots(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);

      // Accept a 4th conjecture → clear retryable typed error (409 probe_slots_full).
      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
        code: PROBE_SLOTS_FULL_CODE,
        status: 409,
      });

      // (2) Zero half-written rows for this proposal: no rate anchor, no dark
      // promotion (node + edge), no new probe question. The 3 seeds are untouched.
      expect(await rateEvents(proposalId)).toHaveLength(0);
      expect(await misconceptionRows()).toHaveLength(0);
      expect(await misconceptionEdgeRows()).toHaveLength(0);
      expect(await probeQuestionsFor(proposalId)).toHaveLength(0);
      expect(await allProbeQuestions()).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);

      // (6) ND-5: zero FSRS / mastery state written.
      expect(await fsrsRowCount()).toBe(0);

      // (5) The proposal is STILL pending — it re-appears in the prep-desk feed so the
      // owner can retry in place. No reader sees an accepted-without-probe row because
      // the accept never committed: rate anchor and probe are atomic (both or neither).
      const feed = await loadPrepDeskConjectures(db);
      expect(feed.conjectures.some((c) => c.id === proposalId)).toBe(true);
    });

    it('after a probe is answered a slot frees — retrying the SAME proposal accepts with exactly 1 rate anchor + 1 probe', async () => {
      const db = testDb();
      const seededProbeIds = await fillProbeSlots(MAX_CONCURRENT_ACTIVE_PROBES);

      const proposalId = await writeAiProposal(db, {
        actor_ref: 'research_meeting',
        payload: baseConjecture(),
      });
      // First accept is capped (and left nothing behind).
      await expect(acceptAiProposal(db, proposalId)).rejects.toMatchObject({
        code: PROBE_SLOTS_FULL_CODE,
      });
      expect(await rateEvents(proposalId)).toHaveLength(0);

      // (3) Complete one active probe → a slot frees.
      await answerProbe({
        db,
        probeQuestionId: seededProbeIds[0],
        outcome: 0,
        resolution: 'confirmed',
      });
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES - 1);

      // Retry the SAME proposal → accept succeeds.
      const result = await acceptAiProposal(db, proposalId);
      expect(result).toMatchObject({
        kind: 'conjecture',
        conjecture_id: proposalId,
        corrected_by_owner: false,
        weakness_confirmed: false,
      });

      // Exactly 1 rate anchor + exactly 1 served probe for this proposal.
      expect(await rateEvents(proposalId)).toHaveLength(1);
      const probes = await probeQuestionsFor(proposalId);
      expect(probes).toHaveLength(1);
      expect(probes[0].draft_status).toBe('draft');
      expect(probes[0].source).toBe(PROBE_QUESTION_SOURCE);

      // (6) ND-5 still holds on the successful retry.
      expect(await fsrsRowCount()).toBe(0);
    });

    it('(4) concurrent accepts are bounded by the advisory lock — exactly MAX succeed, the rest roll back with no orphan rate anchor', async () => {
      const db = testDb();
      // Start from an empty slate and fire MAX+2 accepts of distinct fresh conjectures
      // concurrently. The transaction-scoped advisory lock serializes each serve's
      // count-read + insert, so the cap can never be raced past.
      const overflow = 2;
      const proposalIds = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_ACTIVE_PROBES + overflow }, () =>
          writeAiProposal(db, { actor_ref: 'research_meeting', payload: baseConjecture() }),
        ),
      );

      const settled = await Promise.allSettled(proposalIds.map((id) => acceptAiProposal(db, id)));
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];

      // Exactly MAX accepts win a slot; the overflow ones fail with probe_slots_full.
      expect(fulfilled).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(rejected).toHaveLength(overflow);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({ code: PROBE_SLOTS_FULL_CODE, status: 409 });
      }

      // Active probes never exceeded the cap, and the failed accepts left NO orphan
      // rate anchor — exactly MAX rate(accept) events and MAX probe questions survive.
      expect(await countActiveProbes(db)).toBe(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await allProbeQuestions()).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      const acceptRates = await testDb()
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.subject_kind, 'event')));
      const anchors = acceptRates.filter(
        (e) => (e.payload as { rating?: string }).rating === 'accept',
      );
      expect(anchors).toHaveLength(MAX_CONCURRENT_ACTIVE_PROBES);
      expect(await fsrsRowCount()).toBe(0);
    });
  });
});
