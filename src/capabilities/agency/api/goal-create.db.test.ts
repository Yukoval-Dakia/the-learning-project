// POST /api/goals at-entry goal-create DB test — cold-start P0 (YUK-472).
//
// Drives the direct goal-create handler over a seeded knowledge subgraph: explicit
// knowledgeIds, subjectId-derived scope (effective-domain axis), cold-start empty-scope
// goals (ALLOWED — north-star on an empty tree, scope grows from uploads, YUK-481), and
// title/JSON validation. Asserts the goal row lands with source='manual' (the additive
// entry path that coexists with the ADR-0025 proposal-materialize path).

import { goal, knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

import { POST as createGoal } from './goal-create';

const db = testDb();

beforeEach(() => resetDb());

function jsonReq(body: unknown): Request {
  return new Request('http://t/goals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedKnowledge(id: string, domain: string | null): Promise<void> {
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

describe('POST /api/goals (at-entry goal-create)', () => {
  it('creates a goal from an explicit knowledgeIds scope (source=manual)', async () => {
    await seedKnowledge('kc1', 'yuwen');
    const res = await createGoal(jsonReq({ title: 'G', knowledgeIds: ['kc1'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.scopeKnowledgeIds).toEqual(['kc1']);
    expect(body.status).toBe('active');

    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('manual');
    expect(rows[0].scope_knowledge_ids).toEqual(['kc1']);
    expect(rows[0].title).toBe('G');
  });

  it('does NOT freeze a subject-derived scope: subject goal lands scope_mode=subject_live + empty frozen (YUK-603)', async () => {
    // v2 contract §5.3: a subject goal's scope is a READ-TIME derivation (subject=view).
    // Freezing the write-time resolution was the armed live bug (YUK-603): the derived set
    // included the synthetic seed root, pinning placement tier-1 to [root] forever.
    await seedKnowledge('kc1', 'yuwen');
    await seedKnowledge('kc2', null); // untagged → not in subject either way
    const res = await createGoal(jsonReq({ title: 'G', subjectId: 'yuwen' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subjectId).toBe('yuwen');
    expect(body.scopeKnowledgeIds).toEqual([]); // no write-time freeze

    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows[0].subject_id).toBe('yuwen');
    expect(rows[0].scope_knowledge_ids).toEqual([]);
    expect(rows[0].scope_mode).toBe('subject_live');
  });

  it('day-one regression (YUK-603): subject goal on a seed-root-only tree must not freeze [seed:*:root]', async () => {
    // The exact armed-bug shape: only the synthetic subject root exists (zero content KCs).
    // Pre-fix, resolveSubjectKnowledgeIds returned ['seed:yuwen:root'] (the root self-matches
    // its own domain) and goal-create froze it → placement tier-1 pinned to [root] → probe
    // permanently sourcingNeeded. Post-fix the row must be scope_mode=subject_live + [].
    await seedKnowledge('seed:yuwen:root', 'yuwen');
    const res = await createGoal(jsonReq({ title: 'G', subjectId: 'yuwen' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows[0].scope_knowledge_ids).toEqual([]); // NOT ['seed:yuwen:root']
    expect(rows[0].scope_mode).toBe('subject_live');
  });

  it('explicit knowledgeIds wins over subjectId-derived scope', async () => {
    await seedKnowledge('kc1', 'yuwen');
    await seedKnowledge('kc2', 'yuwen');
    const res = await createGoal(
      jsonReq({ title: 'G', subjectId: 'yuwen', knowledgeIds: ['kc2'] }),
    );
    const body = await res.json();
    expect(body.scopeKnowledgeIds).toEqual(['kc2']); // explicit, not the derived [kc1,kc2]
    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows[0].scope_mode).toBe('explicit'); // explicit set → frozen scope stays authoritative
  });

  it('creates a scope-less north-star goal when neither knowledgeIds nor subjectId is given (cold-start)', async () => {
    // Day-one: empty tree, cross-subject or no subject — the goal is a north-star whose
    // scope grows from uploads (YUK-481). Must NOT be rejected (was the cold-start blocker).
    const res = await createGoal(jsonReq({ title: 'G' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopeKnowledgeIds).toEqual([]);
    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('manual');
    expect(rows[0].scope_knowledge_ids).toEqual([]);
    expect(rows[0].scope_mode).toBe('explicit'); // no subject → nothing to live-derive from
  });

  it('an unknown subjectId still lands subject_live (live resolution degrades to empty, PR4 adds the 422 gate)', async () => {
    // PR-0 keeps the write permissive (the 归一/422 write gate is YUK-600/PR4 scope); the
    // row is subject_live so scope resolution stays a read-time concern either way.
    await seedKnowledge('kc1', 'yuwen');
    const res = await createGoal(jsonReq({ title: 'G', subjectId: 'no_such_subject' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subjectId).toBe('no_such_subject');
    expect(body.scopeKnowledgeIds).toEqual([]);
    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows[0].scope_mode).toBe('subject_live');
  });

  it('parity holds across both PROJECTION_IS_WRITER_GOAL states for a subject_live goal (§8 test 5)', async () => {
    // OFF path: assertGoalParity runs in-tx (dev/test THROW on fold!=row) — a scope_mode wiring
    // gap in GoalRowSnapshot / fold / goalLiveRowToSnapshot would make THIS create throw.
    await seedKnowledge('kc1', 'yuwen');
    const offRes = await createGoal(jsonReq({ title: 'G-off', subjectId: 'yuwen' }));
    expect(offRes.status).toBe(200);

    // ON path: projectGoal write-through folds the genesis and writes the row — the projected
    // row must carry the same scope_mode the imperative writer would have written.
    const prev = process.env.PROJECTION_IS_WRITER_GOAL;
    process.env.PROJECTION_IS_WRITER_GOAL = '1';
    try {
      const onRes = await createGoal(jsonReq({ title: 'G-on', subjectId: 'yuwen' }));
      expect(onRes.status).toBe(200);
      const onBody = await onRes.json();
      const rows = await db.select().from(goal).where(eq(goal.id, onBody.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].scope_mode).toBe('subject_live');
      expect(rows[0].scope_knowledge_ids).toEqual([]);
    } finally {
      // restore OFF ('0' — projectionIsWriter checks === '1'; precedent parity-writers-c3:144)
      process.env.PROJECTION_IS_WRITER_GOAL = prev ?? '0';
    }
  });

  it('400s on a missing title', async () => {
    const res = await createGoal(jsonReq({ knowledgeIds: ['kc1'] }));
    expect(res.status).toBe(400);
  });

  it('400s on a malformed JSON body', async () => {
    const req = new Request('http://t/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    const res = await createGoal(req);
    expect(res.status).toBe(400);
  });
});
