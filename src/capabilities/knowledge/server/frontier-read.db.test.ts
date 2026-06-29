// A5 S2 (YUK-354) — FrontierRail read model. Covers the THREE closure states the rail
// must render: DENSE (live prereq-gated), SPARSE-empty (cold start, no proposals), and
// PROPOSE (cold-start proposed/non-live prereq edges → low-confidence suggestions), plus
// the disjointness guards (live-covered KCs and self-mastered KCs never appear as propose).

import { knowledge, knowledge_edge, mastery_state } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadFrontierRail } from './frontier-read';

async function seedKc(id: string, name = id): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name,
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

/** `from` is a LIVE prerequisite of `to`. */
async function seedLivePrereq(from: string, to: string): Promise<void> {
  await seedKc(from);
  await seedKc(to);
  await testDb()
    .insert(knowledge_edge)
    .values({
      id: createId(),
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: 'prerequisite',
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
      archived_at: null,
    });
}

/** Mark a KC mastered (p(L)=σ(0.4·4)=0.83 ≥ 0.7). */
async function setMastered(kc: string): Promise<void> {
  await seedKc(kc);
  await testDb()
    .insert(mastery_state)
    .values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: kc,
      theta_hat: 0,
      evidence_count: 4,
      success_count: 4,
      fail_count: 0,
      theta_precision: 4,
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

/** Write a PROPOSE-ONLY (pending, non-live) prerequisite edge `from→to` — the cold-start
 *  bootstrap shape frontier_fill_nightly emits (writeAiProposal, NO live knowledge_edge). */
async function proposePrereq(from: string, to: string, reasoning: string): Promise<void> {
  await seedKc(from);
  await seedKc(to);
  await writeAiProposal(testDb(), {
    actor_ref: 'dreaming',
    outcome: 'success',
    payload: {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: reasoning,
      evidence_refs: [],
      proposed_change: {
        edge_op: 'create',
        from_knowledge_id: from,
        to_knowledge_id: to,
        relation_type: 'prerequisite',
        weight: 0.4,
      },
      cooldown_key: `knowledge_edge:${from}|${to}|prerequisite`,
    },
  });
}

describe('loadFrontierRail (A5 S2, YUK-354)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('DENSE: surfaces a live prereq-gated KC as propose=false with a "前置已掌握" reason', async () => {
    // p1, p2 mastered → F (not mastered) is learnable now.
    await seedKc('p1', '前置一');
    await seedKc('p2', '前置二');
    await seedKc('F', '目标');
    await seedLivePrereq('p1', 'F');
    await seedLivePrereq('p2', 'F');
    await setMastered('p1');
    await setMastered('p2');

    const rail = await loadFrontierRail(testDb());
    expect(rail).toHaveLength(1);
    const item = rail[0];
    expect(item.kid).toBe('F');
    expect(item.name).toBe('目标');
    expect(item.propose).toBe(false);
    expect(item.lowConf).toBe(false);
    expect(item.reason).toBe('已掌握全部 2 个前置');
    // F has no mastery row → cold-start band fields (BandChip renders 未知).
    expect(item.mastery).toBeNull();
    expect(item.evidence_count).toBe(0);
  });

  it('SPARSE + no proposals → [] (honest empty, not a fabricated next step)', async () => {
    await seedKc('a');
    await seedKc('b');
    const rail = await loadFrontierRail(testDb());
    expect(rail).toEqual([]);
  });

  it('PROPOSE: a pending proposed (non-live) prereq edge surfaces `to` as propose+lowConf', async () => {
    // Cold start: no live edges at all; only a proposed prereq foundation→target.
    await seedKc('foundation', '基础');
    await seedKc('target', '进阶');
    await proposePrereq('foundation', 'target', '基础是进阶的前置');

    const rail = await loadFrontierRail(testDb());
    expect(rail).toHaveLength(1);
    const item = rail[0];
    expect(item.kid).toBe('target');
    expect(item.name).toBe('进阶');
    expect(item.propose).toBe(true);
    expect(item.lowConf).toBe(true);
    expect(item.reason).toContain('基础'); // proposed prereq NAME in the reason
    expect(item.reason).toContain('待确认');
  });

  it('PROPOSE is disjoint from LIVE: a `to` already covered by a live prereq edge is dropped', async () => {
    // `target` has a LIVE prereq (live, but unmastered → gated out of dense too) AND a
    // separate proposed prereq. It must NOT appear as a propose suggestion (not cold-start).
    await seedKc('liveprq', '实前置');
    await seedKc('target', '目标');
    await seedLivePrereq('liveprq', 'target'); // live coverage (unmastered)
    await proposePrereq('proposedprq', 'target', '另一条提议前置');

    const rail = await loadFrontierRail(testDb());
    expect(rail).toEqual([]);
  });

  it('PROPOSE: a self-mastered candidate is never suggested', async () => {
    await seedKc('foundation', '基础');
    await seedKc('done', '已掌握');
    await proposePrereq('foundation', 'done', '提议前置');
    await setMastered('done'); // already mastered → drop from suggestions

    const rail = await loadFrontierRail(testDb());
    expect(rail).toEqual([]);
  });
});
