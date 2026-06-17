import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import type { DispatchResult } from '@/server/question-supply/dispatcher';
import {
  type QuestionSupplyTarget,
  targetFingerprint,
} from '@/server/question-supply/target-discovery';
import { resolveSubjectProfile } from '@/subjects/profile';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { matcher } from './matcher';

// 1024-dim vector (matches EMBED_DIMS) with the first two components set — mirrors
// pool-fetch.db.test.ts's vec() helper so matcher tests seed embeddings the same way.
function vec(a: number, b: number): number[] {
  const v = new Array(1024).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
}

type QF = Partial<typeof question.$inferInsert> & { id: string };
async function seed(f: QF) {
  await db.insert(question).values({
    kind: 'short_answer',
    prompt_md: 'P',
    source: 'authentic',
    created_at: new Date(),
    updated_at: new Date(),
    draft_status: null,
    ...f,
  });
}

// Seed a knowledge node so demandToSupplyTarget's getEffectiveDomain →
// resolveSubjectProfile resolution has a real domain to walk (Task 3 Step 3).
async function seedKc(id: string, domain: string) {
  await db.insert(knowledge).values({
    id,
    name: id,
    domain,
    parent_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

// Build a fake DispatchResult so the matcher residual branch can fold a dispatch
// outcome into a SourcingNeed WITHOUT touching pg-boss / the real route planner.
function fakeDispatchResult(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    targetId: 't-fake',
    fingerprint: 'fp-fake',
    routePlan: ['quiz_gen'],
    chosenRoute: 'quiz_gen',
    status: 'dispatched',
    jobId: 'job-1',
    stopCondition: 'fake',
    reason: 'fake dispatch',
    ...over,
  };
}

describe('matcher — Task 1 (active hits, no draft, no residual)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns active pool hits sliced to limit, difficulty floor applied, by created_at order', async () => {
    const kc = 'kc-m1';
    // three active rows on the same KC, all difficulty >= 3, distinct created_at.
    await seed({
      id: 'q-a',
      knowledge_ids: [kc],
      difficulty: 3,
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q-b',
      knowledge_ids: [kc],
      difficulty: 4,
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q-c',
      knowledge_ids: [kc],
      difficulty: 5,
      created_at: new Date('2024-01-03T00:00:00Z'),
    });
    // a below-floor row + a different-KC row that must be excluded.
    await seed({
      id: 'q-lo',
      knowledge_ids: [kc],
      difficulty: 2,
      created_at: new Date('2024-01-04T00:00:00Z'),
    });
    await seed({
      id: 'q-other',
      knowledge_ids: ['kc-other'],
      difficulty: 5,
      created_at: new Date('2024-01-05T00:00:00Z'),
    });

    const result = await matcher(db, { knowledgeId: kc, difficultyMin: 3, limit: 2 });

    // two earliest of the three qualifying rows (same tier → stable created_at order).
    expect(result.used.map((u) => u.question_id)).toEqual(['q-a', 'q-b']);
    expect(result.used).toHaveLength(2);
    // no draft handling / no residual generation in Task 1.
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(true);
    // every hit is a real active row, never promoted.
    for (const u of result.used) {
      expect(u.promotedFromDraft).toBe(false);
      expect(u.verifyEventId).toBeUndefined();
    }
    // tier/source projection: bare source='authentic' with no ingestion provenance
    // derives tier 4 (deriveSourceTier keys on metadata.ingestion_session_id, NOT the
    // bare source column — mix-layer defence). Source string is projected verbatim.
    expect(result.used.every((u) => u.source === 'authentic')).toBe(true);
    expect(result.used.every((u) => u.tier === 4)).toBe(true);
  });
});

describe('matcher — Task 2 (cosine soft ranking + NULL embedding 降级)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('cosine-ranks pool hits nearest-first when queryEmbedding given (hybrid)', async () => {
    const kc = 'kc-vec';
    // three active rows, distinct embeddings; created_at order is the inverse of the
    // intended cosine order so a pass can only come from cosine ranking, not insertion.
    await seed({
      id: 'q1',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q2',
      knowledge_ids: [kc],
      embedding: vec(0, 1),
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q3',
      knowledge_ids: [kc],
      embedding: vec(-1, 0),
      created_at: new Date('2024-01-03T00:00:00Z'),
    });

    // query vector pointing almost exactly at q2's direction (0,1).
    const result = await matcher(db, {
      knowledgeId: kc,
      queryEmbedding: vec(0.05, 0.95),
      limit: 3,
    });

    expect(result.used[0].question_id).toBe('q2'); // cosine nearest first
    expect(result.used).toHaveLength(3);
  });

  it('queryText 路 B — embeds via injected embedFn exactly once', async () => {
    const kc = 'kc-text';
    await seed({ id: 'q-near', knowledge_ids: [kc], embedding: vec(0, 1) });
    await seed({ id: 'q-far', knowledge_ids: [kc], embedding: vec(1, 0) });

    const embedFn = vi.fn().mockResolvedValue(vec(0.05, 0.95));
    const result = await matcher(
      db,
      { knowledgeId: kc, queryText: 'near q-near direction', limit: 1 },
      { embedFn },
    );

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith('near q-near direction');
    // the embedded vector is forwarded as queryEmbedding → cosine nearest wins.
    expect(result.used[0].question_id).toBe('q-near');
  });

  it('queryEmbedding takes priority over queryText — embedFn not called', async () => {
    const kc = 'kc-prio';
    await seed({ id: 'q-near', knowledge_ids: [kc], embedding: vec(0, 1) });
    await seed({ id: 'q-far', knowledge_ids: [kc], embedding: vec(1, 0) });

    const embedFn = vi.fn().mockResolvedValue(vec(1, 0));
    const result = await matcher(
      db,
      { knowledgeId: kc, queryEmbedding: vec(0.05, 0.95), queryText: 'ignored', limit: 1 },
      { embedFn },
    );

    // queryEmbedding present → embedFn must NOT be consulted (路 A 优先, §9 开放问题 3).
    expect(embedFn).not.toHaveBeenCalled();
    expect(result.used[0].question_id).toBe('q-near');
  });

  it('vector mode excludes NULL-embedding rows but does not crash (§7 降级)', async () => {
    const kc = 'kc-null-vec';
    await seed({ id: 'q-vec', knowledge_ids: [kc], embedding: vec(1, 0) });
    await seed({ id: 'q-null', knowledge_ids: [kc] }); // NULL embedding

    const result = await matcher(db, { knowledgeId: kc, queryEmbedding: vec(1, 0), limit: 5 });

    // poolFetch's isNotNull(embedding) guard drops the NULL row in vector mode; matcher
    // uses the rows that came back and does not throw.
    expect(result.used.map((u) => u.question_id)).toEqual(['q-vec']);
  });

  it('scalar mode (no queryEmbedding) recalls NULL-embedding rows (§7 降级)', async () => {
    const kc = 'kc-null-scalar';
    await seed({
      id: 'q-vec',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q-null',
      knowledge_ids: [kc],
      created_at: new Date('2024-01-01T00:00:00Z'),
    }); // NULL embedding

    const result = await matcher(db, { knowledgeId: kc, limit: 5 });

    // no query vector → pure scalar pool, NULL-embedding rows recalled too, created_at order.
    expect(result.used.map((u) => u.question_id).sort()).toEqual(['q-null', 'q-vec']);
  });
});

describe('matcher — Task 3 (residual generation: demandToSupplyTarget + dispatchSupplyTarget)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('empty pool → residual + dispatch called once with a valid QuestionSupplyTarget (Step 1)', async () => {
    // empty DB (no question rows on this KC) → matcher must dispatch a residual.
    const kc = 'kc-empty';
    const captured: QuestionSupplyTarget[] = [];
    const fakeDispatchAsTarget = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> => {
        captured.push(target);
        return fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint });
      },
    );

    const result = await matcher(
      db,
      { knowledgeId: kc, limit: 2 },
      { dispatch: fakeDispatchAsTarget },
    );

    expect(result.used).toEqual([]);
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(result.satisfiedFromPool).toBe(false);

    // residual is a SourcingNeed shape with a legal SourcingSequenceStep source.
    const need = result.residual[0];
    expect(need.kind).toBe('question_generation');
    expect(need.knowledge_id).toBe(kc);
    expect(['external_sourcing', 'material_grounded', 'closed_book']).toContain(need.source);

    // dispatch called exactly once with a well-formed QuestionSupplyTarget.
    expect(fakeDispatchAsTarget).toHaveBeenCalledTimes(1);
    const target = captured[0];
    expect(target.knowledgeIds[0]).toBe(kc);
    expect(target.desiredCount).toBe(2); // full gap (limit - 0 used)
    expect(typeof target.fingerprint).toBe('string');
    expect(target.fingerprint.length).toBeGreaterThan(0);
    expect(typeof target.subjectId).toBe('string');
    expect(target.subjectId.length).toBeGreaterThan(0);
  });

  it('partial pool → partial residual, dispatch gap reflects shortfall (Step 2)', async () => {
    const kc = 'kc-partial';
    await seed({ id: 'q-have', knowledge_ids: [kc] });

    let capturedTarget: QuestionSupplyTarget | null = null;
    const fakeDispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> => {
        capturedTarget = target;
        return fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint });
      },
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 3 }, { dispatch: fakeDispatch });

    // one active hit used, residual present, gap = 3 - 1 = 2.
    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-have');
    expect(result.satisfiedFromPool).toBe(false);
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(fakeDispatch).toHaveBeenCalledTimes(1);
    expect((capturedTarget as QuestionSupplyTarget | null)?.desiredCount).toBe(2);
  });

  it('subjectId resolved from KC domain; fingerprint includes it (Step 3)', async () => {
    const kc = 'kc-domain';
    await seedKc(kc, 'math'); // KC node with a real domain, empty question pool.

    let capturedTarget: QuestionSupplyTarget | null = null;
    const fakeDispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> => {
        capturedTarget = target;
        return fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint });
      },
    );

    await matcher(db, { knowledgeId: kc, limit: 2 }, { dispatch: fakeDispatch });

    const expectedSubjectId = resolveSubjectProfile('math').id;
    expect(capturedTarget).not.toBeNull();
    // TS narrows the closure-assigned var to null at this scope; assert through unknown.
    const t = capturedTarget as unknown as QuestionSupplyTarget;
    expect(t.subjectId).toBe(expectedSubjectId);

    // fingerprint is the imported targetFingerprint over the same parts (cooldown stability).
    const expectedFingerprint = targetFingerprint({
      subjectId: t.subjectId,
      knowledgeIds: t.knowledgeIds,
      kind: t.kind,
      difficultyBand: t.difficultyBand,
      gapKind: t.gapKind,
      minSourceTier: t.minSourceTier,
    });
    expect(t.fingerprint).toBe(expectedFingerprint);
    // and the fingerprint string literally carries the resolved subjectId (first segment).
    expect(t.fingerprint.startsWith(`${expectedSubjectId}|`)).toBe(true);
  });
});
