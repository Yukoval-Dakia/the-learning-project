// Phase 0 关系脑 (YUK-406 / YUK-440) — conjecture accept applier lifecycle.
// Enters through the public dispatch shell (acceptAiProposal / dismissAiProposal)
// to cover the whole 「壳路由 → agency applier」 chain. Asserts the three
// semantics (accept = calibration anchor / edit → mem0 CORE / reject → digest),
// idempotency, and the ND-5 red line: NO FSRS / review row is ever written.

import {
  type ConjectureCoreWriter,
  setConjectureCoreWriter,
} from '@/capabilities/agency/server/conjecture-accept';
import { event, material_fsrs_state } from '@/db/schema';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('acceptConjectureProposal lifecycle', () => {
  let coreWriter: ReturnType<typeof vi.fn<ConjectureCoreWriter>>;

  beforeEach(async () => {
    await resetDb();
    coreWriter = vi.fn<ConjectureCoreWriter>(async () => {});
    setConjectureCoreWriter(coreWriter);
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
});
