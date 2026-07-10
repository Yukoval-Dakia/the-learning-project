// resolveGoalPlacementScope DB test — YUK-516 single-source-of-truth contract lock
// (independent review F3). placement-start and placement-profile both resolve goal scope
// through this ONE helper; pinning the tier contract here means neither caller can drift
// from it without this file going red — the drift class YUK-516 closed stays closed.
//
// YUK-603 (v2 contract §5): tier-1 is gated on scope_mode — only an EXPLICIT goal's
// non-empty frozen scope short-circuits; a subject_live goal always live-resolves
// (its frozen column is [] by invariant and ignored even if stale-non-empty).

import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

import { resolveGoalPlacementScope } from './placement-scope';

const db = testDb();

beforeEach(() => resetDb());

async function seedKnowledge(
  id: string,
  opts: { archived?: boolean; parentId?: string | null; domain?: string | null } = {},
): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: opts.domain === undefined ? 'yuwen' : opts.domain,
    parent_id: opts.parentId ?? null,
    created_at: now,
    updated_at: now,
    version: 0,
    archived_at: opts.archived ? now : null,
  });
}

describe('resolveGoalPlacementScope (YUK-516 shared three-tier contract)', () => {
  it('tier-1: an EXPLICIT non-empty frozen scope is returned as-is, never widened by live-resolve', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc2'); // active + same subject, but NOT in the frozen scope
    const scope = await resolveGoalPlacementScope(db, {
      scope: ['kc1'],
      subjectId: 'yuwen',
      scopeMode: 'explicit',
    });
    expect(scope).toEqual(['kc1']);
  });

  it('tier-2: empty frozen scope + subject resolves the live subject KC set (archived excluded)', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc2');
    await seedKnowledge('kc-archived', { archived: true });
    const scope = await resolveGoalPlacementScope(db, {
      scope: [],
      subjectId: 'yuwen',
      scopeMode: 'explicit',
    });
    expect(scope.sort()).toEqual(['kc1', 'kc2']);
  });

  it('tier-3: empty frozen scope + no subject falls back to the full active tree', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc-archived', { archived: true });
    const scope = await resolveGoalPlacementScope(db, {
      scope: null,
      subjectId: null,
      scopeMode: 'explicit',
    });
    expect(scope).toEqual(['kc1']);
  });

  it('tier-3: an unknown/barren subject falls through tier-2 to the full active tree', async () => {
    await seedKnowledge('kc1');
    const scope = await resolveGoalPlacementScope(db, {
      scope: [],
      subjectId: 'no_such_subject',
      scopeMode: 'explicit',
    });
    expect(scope).toEqual(['kc1']);
  });

  it('subject_live: live-resolves the subject KC set every call (never reads frozen)', async () => {
    await seedKnowledge('kc1');
    const scope1 = await resolveGoalPlacementScope(db, {
      scope: [],
      subjectId: 'yuwen',
      scopeMode: 'subject_live',
    });
    expect(scope1).toEqual(['kc1']);
    // A KC bridged AFTER goal creation must enter scope on the next resolve — the exact
    // capability the frozen [seed:*:root] pin destroyed (YUK-603).
    await seedKnowledge('kc2');
    const scope2 = await resolveGoalPlacementScope(db, {
      scope: [],
      subjectId: 'yuwen',
      scopeMode: 'subject_live',
    });
    expect(scope2.sort()).toEqual(['kc1', 'kc2']);
  });

  it('subject_live: a stale non-empty frozen scope is IGNORED (belt-and-braces for legacy rows)', async () => {
    await seedKnowledge('seed:yuwen:root');
    await seedKnowledge('kc1', { parentId: 'seed:yuwen:root', domain: null });
    // Invariant says subject_live rows carry frozen=[]; if a legacy/corrupt row still holds
    // the pinned root, the reader must NOT tier-1 it back into authority.
    const scope = await resolveGoalPlacementScope(db, {
      scope: ['seed:yuwen:root'],
      subjectId: 'yuwen',
      scopeMode: 'subject_live',
    });
    expect(scope).toEqual(['kc1']); // live subject set — root excluded at the source (§5.4)
  });

  it('subject_live tier-2 excludes the synthetic seed root from the resolved set (§5.4)', async () => {
    await seedKnowledge('seed:yuwen:root');
    await seedKnowledge('kc1', { parentId: 'seed:yuwen:root', domain: null }); // effective domain via root
    const scope = await resolveGoalPlacementScope(db, {
      scope: [],
      subjectId: 'yuwen',
      scopeMode: 'subject_live',
    });
    expect(scope).toEqual(['kc1']); // NOT ['seed:yuwen:root', 'kc1']
  });
});
