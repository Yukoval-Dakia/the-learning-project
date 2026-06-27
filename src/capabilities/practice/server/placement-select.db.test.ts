// Placement item selection DB test — cold-start inc-B (YUK-468, PR-2a).
//
// selectNextPlacementItem finds active, non-draft questions over a goal subgraph KC set and
// picks the MAX-information one via the shared collectCandidateSignals (KLP cold / MFI warm).
// At cold θ̂=0 the information criterion (KLP or MFI) peaks where b≈θ̂=0 (difficulty 3 →
// difficultyToLogitB(3)=0), so a difficulty-3 item beats a difficulty-5 item regardless of the
// EARLY_KLP flag direction — the assertions below hold under either.
//
// resetDb() in beforeEach, testDb() handle (mirrors candidate-signals.db.test.ts).

import { knowledge, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { selectNextPlacementItem } from './placement-select';

const db = testDb();

beforeEach(() => resetDb());

async function seedKnowledge(id: string, domain = 'wenyan'): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain,
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(
  id: string,
  knowledgeIds: string[],
  opts: { difficulty?: number; draftStatus?: string; kind?: string } = {},
): Promise<void> {
  const now = new Date();
  await db.insert(question).values({
    id,
    // short_answer = 'application' (scored). fill_blank/translation = recall-locked → the
    // signal layer returns mfiScore=undefined for them (no information score).
    kind: opts.kind ?? 'short_answer',
    prompt_md: `prompt-${id}`,
    knowledge_ids: knowledgeIds,
    difficulty: opts.difficulty ?? 3,
    source: 'manual',
    draft_status: opts.draftStatus ?? 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('selectNextPlacementItem', () => {
  it('picks the max-information question over the goal subgraph (b≈θ̂=0 wins at cold start)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], { difficulty: 3 }); // b≈0 → max info at cold θ̂=0
    await seedQuestion('q-hard', ['kc1'], { difficulty: 5 }); // b high → less info

    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc1'] });
    expect(pick?.questionId).toBe('q-easy');
    expect(pick?.score).toBeGreaterThan(0);
  });

  it('excludes already-served questions (probe never repeats)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], { difficulty: 3 });
    await seedQuestion('q-hard', ['kc1'], { difficulty: 5 });

    const pick = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc1'],
      excludeQuestionIds: ['q-easy'],
    });
    expect(pick?.questionId).toBe('q-hard');
  });

  it('excludes container-only drafts (draft_status=draft never enters the probe pool)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-draft', ['kc1'], { difficulty: 3, draftStatus: 'draft' }); // would win, but draft
    await seedQuestion('q-active', ['kc1'], { difficulty: 5, draftStatus: 'active' });

    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc1'] });
    expect(pick?.questionId).toBe('q-active');
  });

  it('only considers questions in the goal subgraph (KC filter)', async () => {
    await seedKnowledge('kc-in');
    await seedKnowledge('kc-out');
    await seedQuestion('q-in', ['kc-in'], { difficulty: 3 });
    await seedQuestion('q-out', ['kc-out'], { difficulty: 3 });

    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc-in'] });
    expect(pick?.questionId).toBe('q-in');
  });

  it('returns null when the goal subgraph has no eligible questions (cold DB)', async () => {
    await seedKnowledge('kc1');
    // no questions seeded
    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc1'] });
    expect(pick).toBeNull();
  });

  it('returns null for an empty knowledgeIds set', async () => {
    const pick = await selectNextPlacementItem(db, { knowledgeIds: [] });
    expect(pick).toBeNull();
  });

  it('skips recall-locked candidates (no information score) and picks the scored one', async () => {
    await seedKnowledge('kc1');
    // recall-kind (fill_blank) → recallLocked → mfiScore undefined → must be skipped even
    // though its b≈0 would otherwise win; the application question is the only scorable one.
    await seedQuestion('q-recall', ['kc1'], { difficulty: 3, kind: 'fill_blank' });
    await seedQuestion('q-app', ['kc1'], { difficulty: 5, kind: 'short_answer' });

    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc1'] });
    expect(pick?.questionId).toBe('q-app');
  });

  it('returns null when candidates exist but none has an information score (all recall-locked)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-recall', ['kc1'], { difficulty: 3, kind: 'fill_blank' });

    // rows.length > 0 (the SQL filter passes the recall question) but every mfiScore is
    // undefined → best stays null → null (distinct code path from the empty-rows null).
    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc1'] });
    expect(pick).toBeNull();
  });

  it('breaks ties deterministically by question id', async () => {
    await seedKnowledge('kc1');
    // identical difficulty/KC → identical information score → lexicographically smaller id wins.
    await seedQuestion('q-bbb', ['kc1'], { difficulty: 3 });
    await seedQuestion('q-aaa', ['kc1'], { difficulty: 3 });

    const pick = await selectNextPlacementItem(db, { knowledgeIds: ['kc1'] });
    expect(pick?.questionId).toBe('q-aaa');
  });
});

// YUK-480 — leaning preference is an ORDERING-ONLY tier layered above the info pick. It never
// rewrites the reported score nor touches θ̂/p(L); an empty preferKnowledgeIds is byte-identical
// to the pre-YUK-480 selection.
describe('selectNextPlacementItem — leaning preference (YUK-480, ordering only)', () => {
  it('prefers a leaning-subject candidate over a higher-info non-leaning one', async () => {
    await seedKnowledge('kc-lean');
    await seedKnowledge('kc-other');
    // q-other has the higher info (diff 3 → b≈θ̂=0) and would win with NO preference.
    await seedQuestion('q-other', ['kc-other'], { difficulty: 3 });
    // q-lean has lower info (diff 5) but is in the leaning KC set → wins on the preference tier.
    await seedQuestion('q-lean', ['kc-lean'], { difficulty: 5 });

    const pick = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc-lean', 'kc-other'],
      preferKnowledgeIds: ['kc-lean'],
    });
    expect(pick?.questionId).toBe('q-lean');
    // the reported score stays the TRUE info value (the preference reorders WHICH wins, it does
    // not rewrite the psychometric score).
    expect(pick?.score).toBeGreaterThan(0);
  });

  it('empty preferKnowledgeIds → byte-identical to the no-preference pick (max info wins)', async () => {
    await seedKnowledge('kc-lean');
    await seedKnowledge('kc-other');
    await seedQuestion('q-other', ['kc-other'], { difficulty: 3 });
    await seedQuestion('q-lean', ['kc-lean'], { difficulty: 5 });

    const withEmpty = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc-lean', 'kc-other'],
      preferKnowledgeIds: [],
    });
    const without = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc-lean', 'kc-other'],
    });
    expect(withEmpty?.questionId).toBe('q-other'); // info wins; preference is a no-op
    expect(withEmpty).toEqual(without);
  });

  it('within the leaning tier, max-info then id tie-break still hold', async () => {
    await seedKnowledge('kc-lean');
    await seedKnowledge('kc-other');
    // two leaning candidates with identical info → smaller id wins; a same-info non-leaning
    // candidate is still outranked by the preference tier.
    await seedQuestion('q-lean-bbb', ['kc-lean'], { difficulty: 3 });
    await seedQuestion('q-lean-aaa', ['kc-lean'], { difficulty: 3 });
    await seedQuestion('q-other', ['kc-other'], { difficulty: 3 });

    const pick = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc-lean', 'kc-other'],
      preferKnowledgeIds: ['kc-lean'],
    });
    expect(pick?.questionId).toBe('q-lean-aaa');
  });

  it('is deterministic across repeated calls (replay-safe)', async () => {
    await seedKnowledge('kc-lean');
    await seedKnowledge('kc-other');
    await seedQuestion('q-other', ['kc-other'], { difficulty: 3 });
    await seedQuestion('q-lean', ['kc-lean'], { difficulty: 5 });

    const a = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc-lean', 'kc-other'],
      preferKnowledgeIds: ['kc-lean'],
    });
    const b = await selectNextPlacementItem(db, {
      knowledgeIds: ['kc-lean', 'kc-other'],
      preferKnowledgeIds: ['kc-lean'],
    });
    expect(a).toEqual(b);
  });
});
