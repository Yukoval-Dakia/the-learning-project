// listActiveGoalsWithResolvedScope DB test — YUK-603 (v2 contract §5.3 read path).
//
// The four goal-strand readers (coach_daily / dreaming_nightly / due-list rerank /
// learner-state) consumed listActiveGoals' FROZEN scope column directly — no live tier at
// all — so a subject goal's pinned [seed:*:root] scope silently no-op'd all of them. They
// now default to THIS resolved read: explicit → frozen passthrough; subject_live →
// resolveSubjectKnowledgeIds per DISTINCT subject (one resolve per subject, Map-deduped).

import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { insertGoal, listActiveGoalsWithResolvedScope } from './queries';

const db = testDb();

beforeEach(() => resetDb());

const now = new Date();
const kBase = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  created_at: now,
  updated_at: now,
  version: 0,
};

async function seedSubjectTree(): Promise<void> {
  await db.insert(knowledge).values([
    { id: 'seed:yuwen:root', name: '语文', domain: 'yuwen', parent_id: null, ...kBase },
    { id: 'kc1', name: '虚词', domain: null, parent_id: 'seed:yuwen:root', ...kBase },
    { id: 'kc2', name: '句读', domain: null, parent_id: 'seed:yuwen:root', ...kBase },
  ]);
}

describe('listActiveGoalsWithResolvedScope (YUK-603 goal-strand live read)', () => {
  it('subject_live goals get the LIVE subject KC set; frozen [] is ignored', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: 'yuwen',
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 0,
      source: 'manual',
    });
    const goals = await listActiveGoalsWithResolvedScope(db);
    expect(goals).toHaveLength(1);
    expect(goals[0].scope_knowledge_ids.sort()).toEqual(['kc1', 'kc2']); // live, root excluded
  });

  it('explicit goals pass their frozen scope through untouched', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: 'yuwen',
      scope_knowledge_ids: ['kc1'],
      scope_mode: 'explicit',
      sequence_hint: 0,
      source: 'manual',
    });
    const goals = await listActiveGoalsWithResolvedScope(db);
    expect(goals[0].scope_knowledge_ids).toEqual(['kc1']); // NOT widened to [kc1,kc2]
  });

  it('two subject_live goals on the same subject both resolve (single Map-deduped resolve)', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: 'yuwen',
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 0,
      source: 'manual',
    });
    await insertGoal(db, {
      id: 'g2',
      title: 'G2',
      subject_id: 'yuwen',
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 1,
      source: 'manual',
    });
    const goals = await listActiveGoalsWithResolvedScope(db);
    expect(goals).toHaveLength(2);
    for (const g of goals) expect(g.scope_knowledge_ids.sort()).toEqual(['kc1', 'kc2']);
  });

  it('a subject_live goal with an UNKNOWN subject resolves to []', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: 'no_such_subject',
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 0,
      source: 'manual',
    });
    const goals = await listActiveGoalsWithResolvedScope(db);
    expect(goals[0].scope_knowledge_ids).toEqual([]);
  });

  it('a subject_live goal with a NULL subject resolves to [] (nothing to derive from)', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: null,
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 0,
      source: 'manual',
    });
    const goals = await listActiveGoalsWithResolvedScope(db);
    expect(goals[0].scope_knowledge_ids).toEqual([]);
  });

  it('a KC bridged after goal creation enters the resolved scope on the next read (the YUK-603 payoff)', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: 'yuwen',
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 0,
      source: 'manual',
    });
    const before = await listActiveGoalsWithResolvedScope(db);
    expect(before[0].scope_knowledge_ids.sort()).toEqual(['kc1', 'kc2']);
    await db
      .insert(knowledge)
      .values({ id: 'kc3', name: '新篇', domain: null, parent_id: 'seed:yuwen:root', ...kBase });
    const after = await listActiveGoalsWithResolvedScope(db);
    expect(after[0].scope_knowledge_ids.sort()).toEqual(['kc1', 'kc2', 'kc3']);
  });

  it('only ACTIVE goals are listed (parity with listActiveGoals)', async () => {
    await seedSubjectTree();
    await insertGoal(db, {
      id: 'g1',
      title: 'G1',
      subject_id: 'yuwen',
      scope_knowledge_ids: [],
      scope_mode: 'subject_live',
      sequence_hint: 0,
      source: 'manual',
      status: 'dormant',
    });
    expect(await listActiveGoalsWithResolvedScope(db)).toEqual([]);
  });
});
