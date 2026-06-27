// YUK-406 / YUK-440 (教研团 Phase 0 / U4 备课台) — prep-desk read model DB test.
// Imports the inbox read model (hits @/db/client), so it lives in the db partition.
// Covers: salience sort + cap-at-3, the confidence-never-leaks invariant, and route
// registration on the shell manifest.

import { shellCapability } from '@/capabilities/shell/manifest';
import { loadPrepDeskConjectures } from '@/capabilities/shell/server/prep-desk';
import { writeAiProposal } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

function conjecture(opts: {
  claim: string;
  confidence: number;
  recurrence_count: number;
  knowledge_id?: string;
}) {
  return {
    kind: 'conjecture' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: opts.knowledge_id ?? 'kn_x' },
    reason_md: 'recurrent cause×KC failure cell + low θ precision',
    evidence_refs: [
      { kind: 'event' as const, id: 'evt_a' },
      { kind: 'question' as const, id: 'q_b' },
    ],
    cooldown_key: `conjecture:${opts.claim}`,
    proposed_change: {
      claim_md: opts.claim,
      knowledge_id: opts.knowledge_id ?? 'kn_x',
      cause_category: 'concept_misunderstanding',
      confidence: opts.confidence,
      recurrence_count: opts.recurrence_count,
      probe_md: `probe for ${opts.claim}`,
      discriminating: true,
      predicted_p: 0.3,
      baseline_p_at_induction: 0.6,
    },
  };
}

async function seed(opts: Parameters<typeof conjecture>[0]) {
  return writeAiProposal(testDb(), { actor_ref: 'research_meeting', payload: conjecture(opts) });
}

describe('loadPrepDeskConjectures', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('ranks by salience (confidence × recurrence_count) and caps at 3', async () => {
    // salience: low=0.9×2=1.8, mid=0.5×5=2.5, hi=0.8×4=3.2, x=0.99×2=1.98
    // → top-3 DESC = [hi(3.2), mid(2.5), x(1.98)]; low(1.8) drops off.
    await seed({ claim: 'low', confidence: 0.9, recurrence_count: 2 });
    await seed({ claim: 'mid', confidence: 0.5, recurrence_count: 5 });
    await seed({ claim: 'hi', confidence: 0.8, recurrence_count: 4 });
    await seed({ claim: 'x', confidence: 0.99, recurrence_count: 2 });

    const out = await loadPrepDeskConjectures(testDb());

    expect(out.conjectures.map((c) => c.claim)).toEqual(['hi', 'mid', 'x']);
  });

  it('never leaks calibration numbers (confidence / predicted_p / baseline); surfaces probe_md, evidence, claim', async () => {
    await seed({
      claim: 'you multiply derivatives for the chain rule',
      confidence: 0.73,
      recurrence_count: 3,
      knowledge_id: 'kn_chain_rule',
    });

    const out = await loadPrepDeskConjectures(testDb());
    expect(out.conjectures).toHaveLength(1);
    const [c] = out.conjectures;

    // Anti-guilt invariant (defense in depth): NO internal calibration probability —
    // confidence, predicted_p, baseline_p_at_induction — crosses the wire, neither the
    // raw number nor the key. (predicted_p=0.3 / baseline=0.6 are the seed defaults.)
    const json = JSON.stringify(out);
    expect(json).not.toContain('"confidence"');
    expect(json).not.toContain('0.73');
    expect(json).not.toContain('"predicted_p"');
    expect(json).not.toContain('0.3');
    expect(json).not.toContain('"baseline_p_at_induction"');
    expect(json).not.toContain('0.6');

    expect(c.claim).toBe('you multiply derivatives for the chain rule');
    expect(c.knowledge_id).toBe('kn_chain_rule');
    expect(c.probe_md).toBe('probe for you multiply derivatives for the chain rule');
    expect(c.recurrence_count).toBe(3);
    expect(c.discriminating).toBe(true);
    expect(c.corrected_by_owner).toBe(false);
    expect(c.evidence).toEqual([
      { kind: 'event', id: 'evt_a' },
      { kind: 'question', id: 'q_b' },
    ]);
    expect(typeof c.proposed_at).toBe('string');
    expect(Number.isNaN(Date.parse(c.proposed_at))).toBe(false);
    // hard-assert the calibration fields are structurally absent, not just stringly-hidden.
    expect('confidence' in c).toBe(false);
    expect('predicted_p' in c).toBe(false);
    expect('baseline_p_at_induction' in c).toBe(false);
  });

  it('registers GET /api/prep-desk/conjectures on the shell manifest', () => {
    const routes = shellCapability.api?.routes.map((r) => `${r.method} ${r.path}`) ?? [];
    expect(routes).toContain('GET /api/prep-desk/conjectures');
  });
});
