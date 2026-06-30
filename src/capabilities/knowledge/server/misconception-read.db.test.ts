// YUK-531 (A5 S4 / ADR-0036 RT1) — per-KC misconception read model DB test.
// Imports the inbox read model + hits @/db/client, so it lives in the db partition.
// Covers: the confirmed caused_by-edge join surfaces; draft / archived-misconception /
// archived-edge rows are filtered; a per-KC pending conjecture surfaces as a candidate
// (conf '低'); an other-KC conjecture is excluded; an empty KC → [] (honest empty, never
// zero-filled); the ⑥ conf-strip invariant (no raw weight/confidence keys nor seeded
// numbers on the wire); manifest route registration.

import { knowledgeCapability } from '@/capabilities/knowledge/manifest';
import { misconception, misconception_edge } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadMisconceptionsForKc } from './misconception-read';

async function seedMisconception(opts: {
  id: string;
  kcId: string;
  title: string;
  reasoning?: string;
  weight?: number;
  status?: string;
  source?: string;
  seen?: number;
  evidence?: string[];
  miscArchived?: boolean;
  edgeArchived?: boolean;
}): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(misconception)
    .values({
      id: opts.id,
      title: opts.title,
      reasoning: opts.reasoning ?? null,
      weight: opts.weight ?? 1,
      status: opts.status ?? 'active',
      source: opts.source ?? 'soft',
      seen: opts.seen ?? 0,
      evidence: opts.evidence ?? [],
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: opts.miscArchived ? now : null,
    });
  await testDb()
    .insert(misconception_edge)
    .values({
      id: createId(),
      from_kind: 'misconception',
      from_id: opts.id,
      to_kind: 'knowledge',
      to_id: opts.kcId,
      relation_type: 'caused_by',
      weight: 1,
      created_by: { by: 'system' },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
      archived_at: opts.edgeArchived ? now : null,
    });
}

async function seedConjecture(opts: {
  claim: string;
  knowledge_id: string;
  confidence?: number;
  recurrence_count?: number;
}): Promise<void> {
  await writeAiProposal(testDb(), {
    actor_ref: 'research_meeting',
    payload: {
      kind: 'conjecture' as const,
      target: { subject_kind: 'mind_model' as const, subject_id: opts.knowledge_id },
      reason_md: 'recurrent cause×KC failure cell + low θ precision',
      evidence_refs: [
        { kind: 'event' as const, id: 'evt_seed' },
        { kind: 'question' as const, id: 'q_seed' },
      ],
      cooldown_key: `conjecture:${opts.claim}`,
      proposed_change: {
        claim_md: opts.claim,
        knowledge_id: opts.knowledge_id,
        cause_category: 'concept_misunderstanding',
        confidence: opts.confidence ?? 0.5,
        recurrence_count: opts.recurrence_count ?? 3,
        probe_md: `probe for ${opts.claim}`,
        discriminating: true,
        predicted_p: 0.3,
        baseline_p_at_induction: 0.6,
      },
    },
  });
}

describe('loadMisconceptionsForKc (A5 S4, YUK-531)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('surfaces a live confirmed misconception via the caused_by edge', async () => {
    await seedMisconception({
      id: 'mc_1',
      kcId: 'kc_target',
      title: '把导数相乘当链式法则',
      reasoning: '链式法则是外层导数乘内层导数，不是把两个导数直接相乘',
      weight: 0.8,
      source: 'hard',
      seen: 4,
      evidence: ['evt_x', 'evt_y'],
    });

    const rows = await loadMisconceptionsForKc(testDb(), 'kc_target');
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r.id).toBe('mc_1');
    expect(r.segment).toBe('confirmed');
    expect(r.label).toBe('把导数相乘当链式法则');
    expect(r.belief).toContain('链式法则');
    expect(r.source).toBe('hard');
    expect(r.conf).toBe('高'); // weight 0.8 ≥ 0.67 → 高
    expect(r.status).toBe('active'); // conf 高 → active (not fading)
    expect(r.seen).toBe(4);
    expect(r.evidence).toEqual(['evt_x', 'evt_y']);
  });

  it('projects a low-confidence active misconception to status fading', async () => {
    await seedMisconception({
      id: 'mc_low',
      kcId: 'kc_low',
      title: '低置信误区',
      reasoning: '弱信号',
      weight: 0.2, // < 0.34 → conf 低 → fading
      seen: 2,
    });

    const rows = await loadMisconceptionsForKc(testDb(), 'kc_low');
    expect(rows).toHaveLength(1);
    expect(rows[0].conf).toBe('低');
    expect(rows[0].status).toBe('fading');
  });

  it('filters out draft, archived-misconception, and archived-edge rows', async () => {
    await seedMisconception({ id: 'mc_draft', kcId: 'kc_t', title: '草稿', status: 'draft' });
    await seedMisconception({ id: 'mc_arch', kcId: 'kc_t', title: '归档误区', miscArchived: true });
    await seedMisconception({ id: 'mc_earch', kcId: 'kc_t', title: '边归档', edgeArchived: true });

    const rows = await loadMisconceptionsForKc(testDb(), 'kc_t');
    expect(rows).toEqual([]);
  });

  it('surfaces a per-KC pending conjecture as a candidate (conf 低) and excludes other-KC conjectures', async () => {
    await seedConjecture({
      claim: '以为平方和等于和的平方',
      knowledge_id: 'kc_target',
      recurrence_count: 5,
    });
    await seedConjecture({
      claim: '别的 KC 的猜想',
      knowledge_id: 'kc_other',
      recurrence_count: 2,
    });

    const rows = await loadMisconceptionsForKc(testDb(), 'kc_target');
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r.segment).toBe('candidate');
    expect(r.label).toBe('以为平方和等于和的平方'); // < 40 chars → no clamp
    expect(r.belief).toBe('以为平方和等于和的平方');
    expect(r.status).toBe('active');
    expect(r.source).toBe('soft');
    expect(r.conf).toBe('低'); // FIXED — never derived from confidence
    expect(r.seen).toBe(5);
    expect(r.evidence).toEqual(['evt_seed', 'q_seed']);
  });

  it('returns confirmed rows before candidate rows when both exist for the KC', async () => {
    await seedMisconception({
      id: 'mc_both',
      kcId: 'kc_both',
      title: '确认误区',
      reasoning: '已校准',
      weight: 0.9,
      source: 'hard',
      seen: 3,
    });
    await seedConjecture({ claim: '候选误区', knowledge_id: 'kc_both', recurrence_count: 2 });

    const rows = await loadMisconceptionsForKc(testDb(), 'kc_both');
    expect(rows.map((r) => r.segment)).toEqual(['confirmed', 'candidate']);
  });

  it('returns [] for a KC with no misconceptions or conjectures (honest empty, never zero-fill)', async () => {
    const rows = await loadMisconceptionsForKc(testDb(), 'kc_empty');
    expect(rows).toEqual([]);
  });

  it('never leaks raw confidence/weight numbers on the wire (⑥ anti-guilt, defense in depth)', async () => {
    // Confirmed weight 0.73 + candidate confidence 0.73 — neither may serialize, neither
    // as a key nor as the raw number. (predicted_p=0.3 / baseline=0.6 are seed defaults.)
    await seedMisconception({
      id: 'mc_strip',
      kcId: 'kc_s',
      title: '误区',
      reasoning: '解释',
      weight: 0.73,
      seen: 2,
      evidence: ['evt_z'],
    });
    await seedConjecture({
      claim: '候选误区',
      knowledge_id: 'kc_s',
      confidence: 0.73,
      recurrence_count: 4,
    });

    const rows = await loadMisconceptionsForKc(testDb(), 'kc_s');
    expect(rows).toHaveLength(2);

    const json = JSON.stringify({ rows });
    expect(json).not.toContain('"weight"');
    expect(json).not.toContain('"confidence"');
    expect(json).not.toContain('"predicted_p"');
    expect(json).not.toContain('"baseline_p_at_induction"');
    // Raw numbers: the wire carries no float/timestamp field, so these checks need no
    // timestamp stripping (contrast prep-desk.db.test.ts, whose proposed_at could flake).
    expect(json).not.toContain('0.73');
    expect(json).not.toContain('0.3');
    expect(json).not.toContain('0.6');

    for (const r of rows) {
      expect('weight' in r).toBe(false);
      expect('confidence' in r).toBe(false);
    }
  });

  it('registers GET /api/knowledge/[id]/misconceptions on the knowledge manifest', () => {
    const routes = knowledgeCapability.api?.routes.map((r) => `${r.method} ${r.path}`) ?? [];
    expect(routes).toContain('GET /api/knowledge/[id]/misconceptions');
  });
});
