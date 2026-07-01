import { event } from '@/db/schema';
// YUK-531 (A5 S4 / RT1) — gatherDissociationEvidence DB reader (Tier-1, dark).
// Proves the thin reader: it reads a KC's `experimental:prediction_score` LOG events, JOINS each
// back to its conjecture proposal (via conjecture_event_id) to recover the misconception CAUSE,
// keeps ONLY the scores whose (cause × kc) match the requested identity, maps each to a
// DissociationRecord (fail-closed), distils the count summary, and — from today's UN-TAGGED live
// data (no m_diagnostic) — yields evidence that decideDissociation reduces to INSUFFICIENT (the
// hard track structurally cannot fire off current data). The cause-scoped join is the FAIL-2 fix:
// two rival misconceptions on the SAME KC (different cause) are never pooled into one summary.
import { decideDissociation, gatherDissociationEvidence } from '@/server/conjectures/hard-confirm';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

const PREDICTION_SCORE_ACTION = 'experimental:prediction_score';
const CONJECTURE_PROPOSAL_ACTION = 'experimental:proposal';

// `type` (NOT `interface`) so the payload gets an implicit index signature and stays assignable
// to the event.payload column's `$type<Record<string, unknown>>()` (FAIL-1 typecheck fix).
type ScorePayload = {
  knowledge_id: string;
  /** links the score back to its conjecture proposal → cause_category (the join key). */
  conjecture_event_id?: string;
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
};

/**
 * Write a backing conjecture proposal event so gather can recover `cause_category` by joining on
 * `conjecture_event_id`. Mirrors the LIVE shape research_meeting_nightly.ts writes via
 * writeAiProposal: action `experimental:proposal`, payload.ai_proposal.kind='conjecture',
 * proposed_change.{cause_category,knowledge_id}. The prediction_score payload itself never carries
 * cause_category (reconcile.ts) — the join is the only way to attribute a score to a cause.
 */
async function writeConjecture(
  conjectureEventId: string,
  causeCategory: string,
  knowledgeId: string,
): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: conjectureEventId,
    actor_kind: 'agent',
    actor_ref: 'research_meeting',
    action: CONJECTURE_PROPOSAL_ACTION,
    subject_kind: 'mind_model',
    subject_id: knowledgeId,
    payload: {
      ai_proposal: {
        kind: 'conjecture',
        proposed_change: { cause_category: causeCategory, knowledge_id: knowledgeId },
      },
    },
    created_at: new Date('2026-06-30T00:00:00Z'),
  });
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
    // One backing conjecture for the (concept × kn_chain_rule) identity all chain_rule scores
    // resolve to, plus a distinct-KC conjecture the knowledge_id filter excludes.
    await writeConjecture('cj_chain', 'concept', 'kn_chain_rule');
    await writeConjecture('cj_product', 'concept', 'kn_product_rule');
    // Two DISTINCT discriminating observations (fully-tagged synthetic data) …
    await writeScore(
      {
        knowledge_id: 'kn_chain_rule',
        conjecture_event_id: 'cj_chain',
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
        conjecture_event_id: 'cj_chain',
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
        conjecture_event_id: 'cj_chain',
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
        conjecture_event_id: 'cj_product',
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

    const ev = await gatherDissociationEvidence(db, {
      knowledgeId: 'kn_chain_rule',
      causeCategory: 'concept',
    });

    expect(ev.nDedup).toBe(2); // pr_1 rerun collapsed, pr_2 distinct — other KC excluded
    expect(ev.contextSpread).toBe(2); // symbolic + real_world
    expect(ev.crucialConfirmedCount).toBe(3); // all three chain_rule rows are crucial+confirmed
    expect(ev.hasDiscriminatingContext).toBe(true);
    expect(ev.lastDiscriminatingActivation).toEqual(new Date('2026-07-02T00:00:00Z'));
  });

  it("with today's UN-TAGGED live data (no m_diagnostic) the hard track is DARK — INSUFFICIENT", async () => {
    const db = testDb();
    // Backing conjecture so the scores DO resolve to (concept × kn_chain_rule) — the honest
    // version: even correctly-attributed data, if un-tagged, stays INSUFFICIENT.
    await writeConjecture('cj_chain', 'concept', 'kn_chain_rule');
    // Mirrors what the LIVE reconcile loop writes: scoring facts only, NO discrimination tags.
    for (let i = 1; i <= 3; i++) {
      await writeScore(
        {
          knowledge_id: 'kn_chain_rule',
          conjecture_event_id: 'cj_chain',
          predicted_p: 0.2,
          baseline_p: 0.8,
          outcome: 0,
          resolution: 'confirmed',
          probe_result_event_id: `pr_${i}`,
        },
        new Date(`2026-07-0${i}T00:00:00Z`),
      );
    }

    const ev = await gatherDissociationEvidence(db, {
      knowledgeId: 'kn_chain_rule',
      causeCategory: 'concept',
    });
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

  it('does NOT pool rival misconceptions — same KC, different cause stay separate identities', async () => {
    const db = testDb();
    // Two RIVAL misconceptions on the SAME KC: M1 (concept, symbolic) + M2 (method, real_world),
    // each a SINGLE fully-crucial discriminating context. If gather pooled by knowledge_id alone
    // (the FAIL-2 bug), the union would show nDedup=2 / contextSpread=2 → gates PASS and a held-M
    // gets forged from a RIVAL M′'s evidence. Cause-scoped, each identity is INSUFFICIENT.
    await writeConjecture('cj_concept', 'concept', 'kn_chain_rule');
    await writeConjecture('cj_method', 'method', 'kn_chain_rule');
    await writeScore(
      {
        knowledge_id: 'kn_chain_rule',
        conjecture_event_id: 'cj_concept',
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_concept',
        discriminating: true,
        m_diagnostic: true,
        context: 'symbolic',
        session_window: '2026-07-01',
        judge_run_id: 'rc',
      },
      new Date('2026-07-01T00:00:00Z'),
    );
    await writeScore(
      {
        knowledge_id: 'kn_chain_rule',
        conjecture_event_id: 'cj_method',
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_method',
        discriminating: true,
        m_diagnostic: true,
        context: 'real_world',
        session_window: '2026-07-02',
        judge_run_id: 'rm',
      },
      new Date('2026-07-02T00:00:00Z'),
    );

    const permissive = {
      hardConfirmEnabled: true,
      hasRivalProbe: true,
      ownerFreshlyConfirmed: true,
    } as const;

    // M1 = (concept × kn_chain_rule): its single symbolic context does NOT absorb M2's real_world.
    const concept = await gatherDissociationEvidence(db, {
      knowledgeId: 'kn_chain_rule',
      causeCategory: 'concept',
    });
    expect(concept.nDedup).toBe(1); // only pr_concept — pr_method belongs to a rival identity
    expect(concept.contextSpread).toBe(1); // symbolic only — NOT pooled to 2
    expect(concept.crucialConfirmedCount).toBe(1);
    expect(decideDissociation(concept, permissive)).toBe('INSUFFICIENT');

    // M2 = (method × kn_chain_rule): symmetric — its real_world context stays alone.
    const method = await gatherDissociationEvidence(db, {
      knowledgeId: 'kn_chain_rule',
      causeCategory: 'method',
    });
    expect(method.nDedup).toBe(1); // only pr_method
    expect(method.contextSpread).toBe(1); // real_world only — NOT pooled to 2
    expect(method.crucialConfirmedCount).toBe(1);
    expect(decideDissociation(method, permissive)).toBe('INSUFFICIENT');
  });

  it('drops a mis-stamped score whose payload kc disagrees with its proposal kc (Finding-3)', async () => {
    const db = testDb();
    // Two SAME-cause conjectures on DIFFERENT KCs.
    await writeConjecture('cj_a', 'concept', 'kn_a');
    await writeConjecture('cj_b', 'concept', 'kn_b');
    // One legit, fully-crucial discriminating score for (concept × kn_a).
    await writeScore(
      {
        knowledge_id: 'kn_a',
        conjecture_event_id: 'cj_a',
        predicted_p: 0.2,
        baseline_p: 0.8,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_a',
        discriminating: true,
        m_diagnostic: true,
        context: 'symbolic',
        session_window: '2026-07-01',
        judge_run_id: 'ra',
      },
      new Date('2026-07-01T00:00:00Z'),
    );
    // A MIS-STAMPED score: payload.knowledge_id says kn_a (matches the SQL kc pre-filter AND the
    // OLD cause-only match, since cj_b's cause is ALSO 'concept'), but its conjecture_event_id
    // points at cj_b — a conjecture actually about kn_b. Under the old cause-only filter this would
    // pool into (concept × kn_a) as a fake SECOND discriminating context and forge the spread. The
    // proposal-identity cross-check drops it: cj_b's proposal kc (kn_b) ≠ requested kc (kn_a).
    await writeScore(
      {
        knowledge_id: 'kn_a',
        conjecture_event_id: 'cj_b',
        predicted_p: 0.25,
        baseline_p: 0.75,
        outcome: 0,
        resolution: 'confirmed',
        probe_result_event_id: 'pr_mis',
        discriminating: true,
        m_diagnostic: true,
        context: 'real_world',
        session_window: '2026-07-02',
        judge_run_id: 'rmis',
      },
      new Date('2026-07-02T00:00:00Z'),
    );

    const ev = await gatherDissociationEvidence(db, {
      knowledgeId: 'kn_a',
      causeCategory: 'concept',
    });
    // Only the correctly-stamped pr_a survives; pr_mis is dropped, so the fake 2nd context (and
    // thus the fake nDedup=2 / contextSpread=2) never forms.
    expect(ev.nDedup).toBe(1);
    expect(ev.contextSpread).toBe(1);
    expect(ev.crucialConfirmedCount).toBe(1);
    // With a single context the identity is INSUFFICIENT even under the most permissive opts.
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
    // Backing conjecture so the malformed row PASSES the cause filter and is dropped by the
    // reader's fail-closed parse (not silently excluded by a cause mismatch).
    await writeConjecture('cj_chain', 'concept', 'kn_chain_rule');
    // A row missing predicted_p / with a bad outcome must be dropped, not poison the summary.
    await db.insert(event).values({
      id: 'ps_bad',
      actor_kind: 'system',
      actor_ref: 'research_meeting',
      action: PREDICTION_SCORE_ACTION,
      subject_kind: 'event',
      subject_id: 'pr_bad',
      payload: {
        knowledge_id: 'kn_chain_rule',
        conjecture_event_id: 'cj_chain',
        outcome: 7,
        resolution: 'confirmed',
      },
      created_at: new Date('2026-07-01T00:00:00Z'),
    });

    const ev = await gatherDissociationEvidence(db, {
      knowledgeId: 'kn_chain_rule',
      causeCategory: 'concept',
    });
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
