// resolveGoalPlacementScope DB test — YUK-516 single-source-of-truth contract lock
// (independent review F3). placement-start and placement-profile both resolve goal scope
// through this ONE helper; pinning the tier contract here means neither caller can drift
// from it without this file going red — the drift class YUK-516 closed stays closed.

import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

import { resolveGoalPlacementScope } from './placement-scope';

const db = testDb();

beforeEach(() => resetDb());

async function seedKnowledge(id: string, opts: { archived?: boolean } = {}): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'yuwen',
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
    archived_at: opts.archived ? now : null,
  });
}

describe('resolveGoalPlacementScope (YUK-516 shared three-tier contract)', () => {
  it('tier-1: a non-empty frozen scope is returned as-is, never widened by live-resolve', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc2'); // active + same subject, but NOT in the frozen scope
    const scope = await resolveGoalPlacementScope(db, { scope: ['kc1'], subjectId: 'yuwen' });
    expect(scope).toEqual(['kc1']);
  });

  it('tier-2: empty frozen scope + subject resolves the live subject KC set (archived excluded)', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc2');
    await seedKnowledge('kc-archived', { archived: true });
    const scope = await resolveGoalPlacementScope(db, { scope: [], subjectId: 'yuwen' });
    expect(scope.sort()).toEqual(['kc1', 'kc2']);
  });

  it('tier-3: empty frozen scope + no subject falls back to the full active tree', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc-archived', { archived: true });
    const scope = await resolveGoalPlacementScope(db, { scope: null, subjectId: null });
    expect(scope).toEqual(['kc1']);
  });

  it('tier-3: an unknown/barren subject falls through tier-2 to the full active tree', async () => {
    await seedKnowledge('kc1');
    const scope = await resolveGoalPlacementScope(db, {
      scope: [],
      subjectId: 'no_such_subject',
    });
    expect(scope).toEqual(['kc1']);
  });
});
