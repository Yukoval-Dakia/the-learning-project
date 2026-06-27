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

  it('start LIVE-resolves an empty frozen goal scope from the goal subject (YUK-482 Lane B)', async () => {
    // Cold-start goal: declared on an empty tree → frozen scope_knowledge_ids is empty. A KC
    // was later bridged under the subject (effective domain 'wenyan') with a live active
    // question. The frozen-only read would see [] → sourcingNeeded; live-resolve must pick the
    // KC up via the subject's effective-domain axis and return a REAL question.
    await seedKnowledge('kc-bridged'); // domain 'wenyan' (seedKnowledge sets domain: 'wenyan')
    await seedQuestion('q-bridged', ['kc-bridged'], 3);
    const now = new Date();
    await db.insert(goal).values({
      id: 'g-cold',
      title: 'Cold goal',
      subject_id: 'wenyan',
      scope_knowledge_ids: [], // frozen empty (cold-start)
      status: 'active',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    const res = await startPlacement(jsonReq({ goalId: 'g-cold' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // The live-resolved subject KC set entered scope.
    expect(body.knowledgeIds).toEqual(['kc-bridged']);
    expect(body.question?.questionId).toBe('q-bridged');
    expect(body.sourcingNeeded).toBe(false);
  });

  it('start RESPECTS a non-empty frozen goal scope (no live-resolve override) (YUK-482 Lane B)', async () => {
    // An explicit narrow scope must be honored as-is: even though the subject has TWO live KCs,
    // a goal frozen to only kc-a must keep scope=[kc-a] (live-resolve is NOT triggered when the
    // frozen scope is non-empty), so the probe never widens to kc-b.
    await seedKnowledge('kc-a');
    await seedKnowledge('kc-b');
    await seedQuestion('q-a', ['kc-a'], 3);
    await seedQuestion('q-b', ['kc-b'], 3);
    const now = new Date();
    await db.insert(goal).values({
      id: 'g-narrow',
      title: 'Narrow goal',
      subject_id: 'wenyan', // subject has both kc-a + kc-b live...
      scope_knowledge_ids: ['kc-a'], // ...but the goal is explicitly narrowed to kc-a only
      status: 'active',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    const res = await startPlacement(jsonReq({ goalId: 'g-narrow' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Frozen scope respected — NOT widened to the full subject set.
    expect(body.knowledgeIds).toEqual(['kc-a']);
    expect(body.question?.questionId).toBe('q-a');
  });

  it('start TIER-3 falls back to the full active tree for a NULL-subject empty-scope goal (YUK-481)', async () => {
    // The original YUK-473 live trigger: a day-one goal that is cross-subject / picked no subject
    // (subject_id null) with a frozen empty scope. Tier-1 (frozen) and tier-2 (subject) both yield
    // nothing, so placement must fall back to the WHOLE active tree rather than 400. A live KC with
    // a question exists in the tree → the probe is reachable and returns a real first question.
    await seedKnowledge('kc-anywhere'); // active KC in the tree (domain 'wenyan')
    await seedQuestion('q-anywhere', ['kc-anywhere'], 3);
    const now = new Date();
    await db.insert(goal).values({
      id: 'g-no-subject',
      title: 'Cross-subject day-one goal',
      // subject_id intentionally OMITTED (null) — the no-subject cold-start case.
      scope_knowledge_ids: [], // frozen empty (cold-start)
      status: 'active',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    const res = await startPlacement(jsonReq({ goalId: 'g-no-subject' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Full active tree entered scope; the eligible question is served.
    expect(body.knowledgeIds).toEqual(['kc-anywhere']);
    expect(body.question?.questionId).toBe('q-anywhere');
    expect(body.sourcingNeeded).toBe(false);
  });

  it('start TIER-3 falls back to the full tree when the goal subject resolves to no KC (YUK-481)', async () => {
    // A goal DOES carry a subject ('physics') but that subject has no live KC yet (root planted,
    // children not grown). Tier-2 resolves empty; tier-3 falls back to the full active tree, which
    // DOES hold a live KC under a different subject ('wenyan'). This is the deliberate cold-start
    // looseness (owner decision): a subject-bearing goal whose subject is barren still gets placed
    // over whatever active KCs exist, rather than 400ing the cold-start probe.
    await seedKnowledge('kc-wenyan'); // domain 'wenyan' (NOT physics)
    await seedQuestion('q-wenyan', ['kc-wenyan'], 3);
    const now = new Date();
    await db.insert(goal).values({
      id: 'g-barren-subject',
      title: 'Goal with barren subject',
      subject_id: 'physics', // no physics KC exists
      scope_knowledge_ids: [],
      status: 'active',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });

    const res = await startPlacement(jsonReq({ goalId: 'g-barren-subject' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    // tier-2 (physics) was empty → tier-3 full-tree picked up the wenyan KC.
    expect(body.knowledgeIds).toEqual(['kc-wenyan']);
    expect(body.question?.questionId).toBe('q-wenyan');
  });

  it('start 400s only when the ENTIRE active tree is empty (tier-3 found nothing) (YUK-481)', async () => {
    // The degenerate floor: a cold goal whose subject has no KC AND the whole active tree is empty
    // (zero active KC anywhere) → tier-3 full-tree fallback also yields [] → 400. This is the
    // semantically-correct "truly nothing to place against" case (no KC exists at all), NOT the
    // no-subject case (which tier-3 now rescues whenever any active KC exists).
    const now = new Date();
    await db.insert(goal).values({
      id: 'g-empty',
      title: 'Empty subject goal',
      subject_id: 'physics', // no physics KC seeded — and nothing else is seeded either
      scope_knowledge_ids: [],
      status: 'active',
      source: 'manual',
      created_at: now,
      updated_at: now,
    });
    const res = await startPlacement(jsonReq({ goalId: 'g-empty' }));
    expect(res.status).toBe(400);
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

  it('start ORDERS the first question toward a self-reported leaning subject (YUK-480)', async () => {
    const now = new Date();
    // two KCs in different effective domains (subject=view).
    await db.insert(knowledge).values([
      {
        id: 'kc-wenyan',
        name: 'KW',
        domain: 'wenyan',
        parent_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'kc-math',
        name: 'KM',
        domain: 'math',
        parent_id: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);
    // q-math has the higher info (diff 3 → b≈θ̂=0) and would win with NO leaning; q-wenyan (diff
    // 5) is lower info but in the leaning subject → the preference tier orders it first.
    await seedQuestion('q-math', ['kc-math'], 3);
    await seedQuestion('q-wenyan', ['kc-wenyan'], 5);

    // leaning toward 'wenyan' → resolveSubjectKnowledgeIds('wenyan') = [kc-wenyan] → preferred.
    const res = await startPlacement(
      jsonReq({ knowledgeIds: ['kc-wenyan', 'kc-math'], leanings: ['wenyan'] }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.question?.questionId).toBe('q-wenyan');

    // control: NO leaning → the higher-info q-math wins (byte-identical to pre-YUK-480).
    const ctrl = await (
      await startPlacement(jsonReq({ knowledgeIds: ['kc-wenyan', 'kc-math'] }))
    ).json();
    expect(ctrl.question?.questionId).toBe('q-math');
  });

  it('next derives the probe cap from the self-reported pace SERVER-SIDE (YUK-480: light → 5)', async () => {
    await seedKnowledge('kc1');
    for (let i = 0; i < 10; i++) await seedQuestion(`q${i}`, ['kc1'], 3);
    const start = await (
      await startPlacement(jsonReq({ knowledgeIds: ['kc1'], pace: 'light' }))
    ).json();
    // answer 5 — the light-pace cap, fewer than the default 8.
    for (let i = 0; i < 5; i++) await seedAnswer(start.sessionId, `q${i}`);

    // No cap in the body → the route derives it from the pace persisted at /start ('light' → 5).
    const res = await nextPlacement(jsonReq({}), { id: start.sessionId });
    const body = await res.json();
    expect(body.done).toBe(true);
    expect(body.reason).toBe('cap');
    expect(body.answeredCount).toBe(5);
  });

  it('next holds the default cap (8) when no pace was reported (back-compat)', async () => {
    await seedKnowledge('kc1');
    for (let i = 0; i < 10; i++) await seedQuestion(`q${i}`, ['kc1'], 3);
    const start = await (await startPlacement(jsonReq({ knowledgeIds: ['kc1'] }))).json();
    for (let i = 0; i < 5; i++) await seedAnswer(start.sessionId, `q${i}`);
    // 5 < the default cap 8 → NOT done (a light-pace probe would already have stopped here).
    const res = await nextPlacement(jsonReq({}), { id: start.sessionId });
    const body = await res.json();
    expect(body.done).toBe(false);
    expect(body.answeredCount).toBe(5);
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
