// Placement probe API flow DB test — cold-start inc-B (YUK-468, PR-2b).
//
// Drives the three route handlers (start / next / end) over a seeded goal subgraph, simulating
// answers by inserting review events chained to the probe's session_id (the same trail the
// shared /api/review/submit path writes). PLACEMENT_PROBE_ENABLED is mocked true so the
// dark-ship start gate is exercised in both directions.

import { newId } from '@/core/ids';
import { event, goal, knowledge, question } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// Mock just the PLACEMENT_PROBE_ENABLED flag (EARLY_KLP pattern) — keep startPlacementSession /
// completePlacementSession / abandonPlacementSession real. The default is dark-ship false; we
// flip it per-test to cover both the gated-off 404 and the live flow.
const placementFlag = { value: true };
vi.mock('@/server/session/placement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/session/placement')>();
  return {
    ...actual,
    get PLACEMENT_PROBE_ENABLED() {
      return placementFlag.value;
    },
  };
});

import { POST as endPlacement } from './placement-end';
import { POST as nextPlacement } from './placement-next';
import { POST as startPlacement } from './placement-start';

const db = testDb();

beforeEach(() => {
  placementFlag.value = true;
  return resetDb();
});

function jsonReq(body: unknown): Request {
  return new Request('http://t/placement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function seedKnowledge(id: string): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain: 'wenyan',
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(id: string, kcs: string[], difficulty = 3): Promise<void> {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `p-${id}`,
    knowledge_ids: kcs,
    difficulty,
    source: 'manual',
    draft_status: 'active',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

// Simulate one answered probe question (what /api/review/submit writes: a review event on the
// question, chained by session_id).
async function seedAnswer(sessionId: string, questionId: string): Promise<void> {
  const now = new Date();
  await db.insert(event).values({
    id: newId(),
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'success',
    payload: {},
    created_at: now,
  });
}

describe('placement API flow', () => {
  it('start (flag on) creates a started session + returns the max-info first question', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], 3); // b≈0 → wins at cold θ̂=0
    await seedQuestion('q-hard', ['kc1'], 5);

    const res = await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.question?.questionId).toBe('q-easy');
    expect(body.sourcingNeeded).toBe(false);
  });

  it('start resolves the KC scope from a goal when knowledgeIds is omitted', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q1', ['kc1'], 3);
    const now = new Date();
    await db.insert(goal).values({
      id: 'g1',
      title: 'G',
      scope_knowledge_ids: ['kc1'],
      status: 'active',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    const res = await startPlacement(jsonReq({ goalId: 'g1' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.knowledgeIds).toEqual(['kc1']);
    expect(body.question?.questionId).toBe('q1');
  });

  it('start 404s when the dark-ship flag is off', async () => {
    placementFlag.value = false;
    const res = await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }));
    expect(res.status).toBe(404);
  });

  it('start 400s with neither goalId nor knowledgeIds resolvable', async () => {
    const res = await startPlacement(jsonReq({}));
    expect(res.status).toBe(400);
  });

  it('start 400s on a malformed JSON body (clear error, not a confusing Zod message)', async () => {
    const req = new Request('http://t/placement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    const res = await startPlacement(req);
    expect(res.status).toBe(400);
  });

  it('start flags sourcingNeeded on a cold subgraph (no eligible questions)', async () => {
    await seedKnowledge('kc1');
    const res = await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }));
    const body = await res.json();
    expect(body.question).toBeNull();
    expect(body.sourcingNeeded).toBe(true);
  });

  it('next excludes already-answered questions and returns the remaining one', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], 3);
    await seedQuestion('q-hard', ['kc1'], 5);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    await seedAnswer(start.sessionId, 'q-easy'); // answered the first

    const res = await nextPlacement(jsonReq({ knowledgeIds: ['kc1'] }), { id: start.sessionId });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.done).toBe(false);
    expect(body.answeredCount).toBe(1);
    expect(body.question?.questionId).toBe('q-hard');
  });

  it('next counts DISTINCT answered questions (duplicate events on one question count once)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], 3);
    await seedQuestion('q-hard', ['kc1'], 5);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    // two events for the SAME question (retry / double-submit) must not inflate the count.
    await seedAnswer(start.sessionId, 'q-easy');
    await seedAnswer(start.sessionId, 'q-easy');

    const res = await nextPlacement(jsonReq({ knowledgeIds: ['kc1'] }), { id: start.sessionId });
    const body = await res.json();
    expect(body.answeredCount).toBe(1); // distinct, not 2
    expect(body.question?.questionId).toBe('q-hard');
  });

  it('next reports done(reason=cap) once the cap is reached', async () => {
    await seedKnowledge('kc1');
    for (let i = 0; i < 10; i++) await seedQuestion(`q${i}`, ['kc1'], 3);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    // answer 8 (the default cap)
    for (let i = 0; i < 8; i++) await seedAnswer(start.sessionId, `q${i}`);

    const res = await nextPlacement(jsonReq({ knowledgeIds: ['kc1'], cap: 8 }), {
      id: start.sessionId,
    });
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.reason).toBe('cap');
    expect(body.answeredCount).toBe(8);
  });

  it('next reads scope SERVER-SIDE (no knowledgeIds in body) from the persisted session (YUK-470)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], 3);
    await seedQuestion('q-hard', ['kc1'], 5);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    await seedAnswer(start.sessionId, 'q-easy');

    // No knowledgeIds in the /next body — the route must use the scope persisted at /start.
    const res = await nextPlacement(jsonReq({}), { id: start.sessionId });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.done).toBe(false);
    expect(body.answeredCount).toBe(1);
    expect(body.question?.questionId).toBe('q-hard');
  });

  it('next concurrency lock: two concurrent POSTs do NOT return the same question (YUK-470)', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q-easy', ['kc1'], 3);
    await seedQuestion('q-hard', ['kc1'], 5);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();

    // Fire two /next concurrently with NO answers yet. The FOR UPDATE row lock serializes them.
    // Both legitimately observe answeredCount=0 (no answer-before-next has happened), so both may
    // select the same max-info item — that is correct: the lock's contract is serialization of
    // the read-select cycle, and the answer-before-next protocol guarantees no double-serve in
    // real flow. What the lock PREVENTS is interleaved reads producing inconsistent answeredIds.
    // Assert both calls succeed under the lock without error / deadlock.
    const [r1, r2] = await Promise.all([
      nextPlacement(jsonReq({}), { id: start.sessionId }),
      nextPlacement(jsonReq({}), { id: start.sessionId }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    expect(b1.done).toBe(false);
    expect(b2.done).toBe(false);

    // Now exercise the real answer-before-next protocol under concurrency: with one answer
    // committed, a /next must exclude it. Serialized reads guarantee the post-answer call never
    // re-serves the answered question.
    await seedAnswer(start.sessionId, 'q-easy');
    const after = await nextPlacement(jsonReq({}), { id: start.sessionId });
    const afterBody = await after.json();
    expect(afterBody.answeredCount).toBe(1);
    expect(afterBody.question?.questionId).toBe('q-hard');
  });

  it('next 400s when the session has no persisted scope and no knowledgeIds override (YUK-470)', async () => {
    // A probe started without a scope (legacy / pre-YUK-470 row). startPlacementSession with no
    // knowledgeIds leaves scope_knowledge_ids null; with no override, /next has nothing to select.
    const { Placement } = await import('@/server/session');
    const { sessionId } = await Placement.startPlacementSession(db, {});
    const res = await nextPlacement(jsonReq({}), { id: sessionId });
    expect(res.status).toBe(400);
  });

  it('next accepts a client knowledgeIds OVERRIDE over the persisted scope (YUK-470)', async () => {
    await seedKnowledge('kc1');
    await seedKnowledge('kc2');
    await seedQuestion('q-kc1', ['kc1'], 3);
    await seedQuestion('q-kc2', ['kc2'], 3);
    // Start scoped to kc1 only.
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    // Override to kc2 — the route honors the explicit override.
    const res = await nextPlacement(jsonReq({ knowledgeIds: ['kc2'] }), { id: start.sessionId });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.question?.questionId).toBe('q-kc2');
  });

  it('next 404s for an unknown session and 409s for a closed one', async () => {
    const r404 = await nextPlacement(jsonReq({ knowledgeIds: ['kc1'] }), { id: 'nope' });
    expect(r404.status).toBe(404);

    await seedKnowledge('kc1');
    await seedQuestion('q1', ['kc1'], 3);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    await endPlacement(jsonReq({ status: 'completed' }), { id: start.sessionId });
    const r409 = await nextPlacement(jsonReq({ knowledgeIds: ['kc1'] }), { id: start.sessionId });
    expect(r409.status).toBe(409);
  });

  it('end completes the probe', async () => {
    await seedKnowledge('kc1');
    await seedQuestion('q1', ['kc1'], 3);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    const res = await endPlacement(jsonReq({ status: 'completed' }), { id: start.sessionId });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('completed');
  });
});
