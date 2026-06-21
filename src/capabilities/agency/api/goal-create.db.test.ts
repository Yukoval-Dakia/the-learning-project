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
    await seedKnowledge('kc1', 'wenyan');
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

  it('derives the scope from a subjectId via the effective-domain axis', async () => {
    await seedKnowledge('kc1', 'wenyan'); // effective domain 'wenyan' → subject 'wenyan'
    await seedKnowledge('kc2', null); // untagged → not in subject
    const res = await createGoal(jsonReq({ title: 'G', subjectId: 'wenyan' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subjectId).toBe('wenyan');
    expect(body.scopeKnowledgeIds).toEqual(['kc1']);

    const rows = await db.select().from(goal).where(eq(goal.id, body.id));
    expect(rows[0].subject_id).toBe('wenyan');
    expect(rows[0].scope_knowledge_ids).toEqual(['kc1']);
  });

  it('derives scope through the domain→subject alias (classical_chinese → wenyan)', async () => {
    // resolveSubjectKnowledgeIds is alias-aware (domain.ts over-match fix): a node
    // whose raw domain ALIASES to the subject id must be swept in. Lock that the
    // entry path depends on the alias bridge, not bare domain equality.
    await seedKnowledge('kc1', 'classical_chinese');
    const res = await createGoal(jsonReq({ title: 'G', subjectId: 'wenyan' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopeKnowledgeIds).toEqual(['kc1']);
  });

  it('explicit knowledgeIds wins over subjectId-derived scope', async () => {
    await seedKnowledge('kc1', 'wenyan');
    await seedKnowledge('kc2', 'wenyan');
    const res = await createGoal(
      jsonReq({ title: 'G', subjectId: 'wenyan', knowledgeIds: ['kc2'] }),
    );
    const body = await res.json();
    expect(body.scopeKnowledgeIds).toEqual(['kc2']); // explicit, not the derived [kc1,kc2]
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
  });

  it('creates a goal with empty scope when subjectId resolves to no knowledge nodes', async () => {
    await seedKnowledge('kc1', 'wenyan');
    const res = await createGoal(jsonReq({ title: 'G', subjectId: 'no_such_subject' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subjectId).toBe('no_such_subject');
    expect(body.scopeKnowledgeIds).toEqual([]);
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
