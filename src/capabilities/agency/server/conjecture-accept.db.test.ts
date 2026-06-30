// Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept applier lifecycle.
// Enters through the public dispatch shell (acceptAiProposal / dismissAiProposal)
// to cover the whole 「壳路由 → agency applier」 chain. Asserts the three
// semantics (accept = calibration anchor / edit → mem0 CORE / reject → digest),
// idempotency, and the ND-5 red line: NO FSRS / review row is ever written.

import {
  type ConjectureCoreWriter,
  setConjectureCoreWriter,
} from '@/capabilities/agency/server/conjecture-accept';
import {
  DEFAULT_MISCONCEPTION_WEIGHT,
  promoteConjectureToMisconception,
} from '@/capabilities/agency/server/misconception-promote';
import { event, material_fsrs_state, misconception, misconception_edge } from '@/db/schema';
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
});
