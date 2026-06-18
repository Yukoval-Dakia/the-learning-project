import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import type { DispatchResult } from '@/server/question-supply/dispatcher';
import {
  type QuestionSupplyTarget,
  targetFingerprint,
} from '@/server/question-supply/target-discovery';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
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
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
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
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    // three active rows clustered near the query direction (1,0) at increasing angles —
    // all WITHIN MATCHER_COSINE_MAX_DISTANCE (so the §4 threshold keeps all three; this
    // test isolates ranking, the over-threshold drop is covered separately). created_at
    // order (q1,q2,q3) differs from the intended cosine order (q2<q1<q3) so a pass can
    // only come from cosine ranking, not insertion.
    await seed({
      id: 'q1',
      knowledge_ids: [kc],
      embedding: vec(1, 0.4), // dist ~0.07
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q2',
      knowledge_ids: [kc],
      embedding: vec(1, 0.05), // dist ~0.001 (nearest)
      created_at: new Date('2024-01-02T00:00:00Z'),
    });
    await seed({
      id: 'q3',
      knowledge_ids: [kc],
      embedding: vec(1, 0.7), // dist ~0.18
      created_at: new Date('2024-01-03T00:00:00Z'),
    });

    // query vector pointing along (1,0); q2 is the closest of the three.
    const result = await matcher(db, {
      knowledgeId: kc,
      queryEmbedding: vec(1, 0),
      limit: 3,
    });

    expect(result.used[0].question_id).toBe('q2'); // cosine nearest first
    expect(result.used).toHaveLength(3);
  });

  it('queryText 路 B — embeds via injected embedFn exactly once', async () => {
    const kc = 'kc-text';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
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
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
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
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    await seed({ id: 'q-vec', knowledge_ids: [kc], embedding: vec(1, 0) });
    await seed({ id: 'q-null', knowledge_ids: [kc] }); // NULL embedding

    const result = await matcher(db, { knowledgeId: kc, queryEmbedding: vec(1, 0), limit: 5 });

    // poolFetch's isNotNull(embedding) guard drops the NULL row in vector mode; matcher
    // uses the rows that came back and does not throw.
    expect(result.used.map((u) => u.question_id)).toEqual(['q-vec']);
  });

  it('scalar mode (no queryEmbedding) recalls NULL-embedding rows (§7 降级)', async () => {
    const kc = 'kc-null-scalar';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
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
    // empty pool but a LIVE KC node (codex P2-4: residual only dispatches for a live anchor).
    const kc = 'kc-empty';
    await seedKc(kc, 'math');
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
    await seedKc(kc, 'math'); // live KC anchor (codex P2-4) for the residual dispatch.
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

describe('matcher — Task 5 (draft 命中 lazy verify-promote + cosine 阈值过滤)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // A runTaskFn that must never be consulted (verify is faked at the matcher seam).
  const noRunTask = vi.fn(async () => {
    throw new Error('runTaskFn should not be called when verify is faked');
  });

  // Step 2 — cosine over-threshold → residual (§4 boundary, "宁残余不塞次品").
  // An active row hits the KC and has an embedding, but its embedding is orthogonal to the
  // query vector (cosine distance ≈ 1, well over MATCHER_COSINE_MAX_DISTANCE). The matcher
  // must DISCARD it on threshold and fall to residual generation — never塞 a next-best.
  it('active hit whose cosine distance exceeds threshold is discarded → residual (§4)', async () => {
    const kc = 'kc-cos-thresh';
    await seedKc(kc, 'math'); // live KC anchor (codex P2-4) for the residual dispatch.
    // embedding points at (1,0); query points at (0,1) → orthogonal → distance ~1.0.
    await seed({ id: 'q-far', knowledge_ids: [kc], embedding: vec(1, 0), draft_status: null });

    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(
      db,
      { knowledgeId: kc, queryEmbedding: vec(0, 1), limit: 1 },
      { dispatch },
    );

    // the over-threshold active row is dropped; pool yields nothing usable → residual.
    expect(result.used).toEqual([]);
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(result.satisfiedFromPool).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Step 3 — draft hit (within threshold) → verify promotes → USE.
  it('draft hit within threshold → verify promotes → used carries promotedFromDraft + verifyEventId', async () => {
    const kc = 'kc-draft-ok';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    await seed({
      id: 'q-draft',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      draft_status: 'draft',
    });

    const verify = vi.fn(
      async (_p: {
        db: typeof db;
        questionId: string;
        runTaskFn: unknown;
      }): Promise<{ promoted: boolean; verifyEventId?: string }> => ({
        promoted: true,
        verifyEventId: 'ev1',
      }),
    );

    const result = await matcher(
      db,
      { knowledgeId: kc, queryEmbedding: vec(1, 0), limit: 1 },
      { verify, runTaskFn: noRunTask },
    );

    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-draft');
    expect(result.used[0].promotedFromDraft).toBe(true);
    expect(result.used[0].verifyEventId).toBe('ev1');
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(true);

    // verify called exactly once with {db, questionId, runTaskFn}.
    expect(verify).toHaveBeenCalledTimes(1);
    const callArg = verify.mock.calls[0][0];
    expect(callArg.db).toBe(db);
    expect(callArg.questionId).toBe('q-draft');
    expect(callArg.runTaskFn).toBe(noRunTask);
  });

  // Step 4 — draft fails gate → skip it, use the next candidate (an active row).
  it('draft that fails verify is skipped; next active candidate is used instead', async () => {
    const kc = 'kc-draft-fail';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    // both rows hit; same embedding (within threshold). draft ranks first by created_at but
    // fails verify; active ranks second and must be the one used.
    await seed({
      id: 'q-draft',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      draft_status: 'draft',
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q-active',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      draft_status: null,
      created_at: new Date('2024-01-02T00:00:00Z'),
    });

    const verify = vi.fn(
      async (): Promise<{ promoted: boolean; verifyEventId?: string }> => ({
        promoted: false,
      }),
    );

    const result = await matcher(
      db,
      { knowledgeId: kc, queryEmbedding: vec(1, 0), limit: 1 },
      { verify, runTaskFn: noRunTask },
    );

    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-active');
    expect(result.used[0].promotedFromDraft).toBe(false);
    expect(result.used[0].verifyEventId).toBeUndefined();
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1); // only the draft needed verification
  });

  // Step 5 — all candidates exhausted (lone draft fails verify, no active) → residual.
  it('lone draft fails verify, no active fallback → residual + dispatch', async () => {
    const kc = 'kc-exhaust';
    await seedKc(kc, 'math'); // live KC anchor (codex P2-4) for the residual dispatch.
    await seed({
      id: 'q-draft-only',
      knowledge_ids: [kc],
      embedding: vec(1, 0),
      draft_status: 'draft',
    });

    const verify = vi.fn(
      async (): Promise<{ promoted: boolean; verifyEventId?: string }> => ({
        promoted: false,
      }),
    );
    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(
      db,
      { knowledgeId: kc, queryEmbedding: vec(1, 0), limit: 1 },
      { verify, dispatch, runTaskFn: noRunTask },
    );

    expect(result.used).toEqual([]);
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(result.satisfiedFromPool).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

// ── codex P2 review findings (inc-3) ──────────────────────────────────────────
describe('matcher — codex P2 fixes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // P2-1 — repo「可用」语义 = draft_status <> 'draft' (NULL / 'active' / legacy 'final'
  // all usable). Only a true 'draft' goes to lazy verify; a non-draft row (e.g. 'final')
  // must be used DIRECTLY, never sent to verify (sending it would mis-route a usable row).
  it("non-draft 'final' row is used directly, verify NOT called (P2-1)", async () => {
    const kc = 'kc-final';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    await seed({ id: 'q-final', knowledge_ids: [kc], draft_status: 'final' });

    const verify = vi.fn(
      async (): Promise<{ promoted: boolean; verifyEventId?: string }> => ({ promoted: true }),
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 1 }, { verify });

    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-final');
    expect(result.used[0].promotedFromDraft).toBe(false);
    expect(result.used[0].verifyEventId).toBeUndefined();
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(true);
    // a non-draft row is NEVER routed through lazy verify.
    expect(verify).not.toHaveBeenCalled();
  });

  // P2-2 — soft-archived draft = draft_status='draft' + metadata.archived_at. poolFetch
  // (activeOnly:false) recalls it, but the matcher must treat it as UNUSABLE: skip it
  // before verify (never promote an archived draft back to active) and fall to residual.
  it('archived draft (metadata.archived_at) is skipped — not verified, not promoted → residual (P2-2)', async () => {
    const kc = 'kc-archived-draft';
    await seedKc(kc, 'math'); // live KC anchor (codex P2-4) so the residual still dispatches.
    await seed({
      id: 'q-arch',
      knowledge_ids: [kc],
      draft_status: 'draft',
      metadata: { archived_at: '2024-01-01T00:00:00Z' } as never,
    });

    const verify = vi.fn(
      async (): Promise<{ promoted: boolean; verifyEventId?: string }> => ({
        promoted: true,
        verifyEventId: 'should-not-happen',
      }),
    );
    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 1 }, { verify, dispatch });

    expect(result.used).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(result.satisfiedFromPool).toBe(false);
  });

  // P2-3 — a verify that REJECTS (system error: bad metadata / LLM / parse / transient DB)
  // must not break the whole arbitration. The matcher catches the throw per-candidate,
  // treats that candidate as unusable, and continues to the next ranked candidate.
  it('verify that throws is caught per-candidate; matcher continues to next active candidate (P2-3)', async () => {
    const kc = 'kc-verify-throw';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    // draft ranks first by created_at and its verify throws; an active row follows and
    // must still be used (the throw on the draft must not abort the loop).
    await seed({
      id: 'q-draft-throw',
      knowledge_ids: [kc],
      draft_status: 'draft',
      created_at: new Date('2024-01-01T00:00:00Z'),
    });
    await seed({
      id: 'q-active',
      knowledge_ids: [kc],
      draft_status: null,
      created_at: new Date('2024-01-02T00:00:00Z'),
    });

    const verify = vi.fn(async (): Promise<{ promoted: boolean; verifyEventId?: string }> => {
      throw new Error('verify blew up (bad metadata / transient)');
    });

    const result = await matcher(db, { knowledgeId: kc, limit: 1 }, { verify });

    // matcher did not reject; the bad draft was skipped, the active row used.
    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-active');
    expect(result.used[0].promotedFromDraft).toBe(false);
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1); // only the throwing draft was verified
  });

  // P2-4 — residual dispatch must verify the KC is LIVE first (mirror
  // resolveLiveKnowledgeNode: exists AND archived_at IS NULL). getEffectiveDomain does NOT
  // check archived_at, so a stale/archived KC would otherwise dispatch a residual that the
  // worker-side anchor guard only rejects as ref_not_found. Archived KC → no dispatch.
  it('archived KC → residual NOT dispatched (dispatch not called), residual empty (P2-4)', async () => {
    const kc = 'kc-archived';
    // KC node exists but is archived; empty question pool → would otherwise dispatch.
    await db.insert(knowledge).values({
      id: kc,
      name: kc,
      domain: 'math',
      parent_id: null,
      archived_at: new Date('2024-01-01T00:00:00Z'),
      created_at: new Date(),
      updated_at: new Date(),
    });

    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 2 }, { dispatch });

    expect(result.used).toEqual([]);
    // archived KC: the worker-side anchor guard would reject the job, so no dispatch.
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(false);
  });

  // P2-4 (companion) — a missing KC (no node at all) likewise must not dispatch a residual.
  it('missing KC (no node) → residual NOT dispatched (P2-4 companion)', async () => {
    const kc = 'kc-missing';
    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 2 }, { dispatch });

    expect(result.used).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(false);
  });
});

// ── YUK-401 — matcher 算子 3 个硬化修 (codex round-2 A 段) ──────────────────────
describe('matcher — YUK-401 operator hardening', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Fix 1 — Demand.minSourceTier enforcement. A candidate counts toward `used` ONLY if
  // its derived source tier SATISFIES minSourceTier (deriveSourceTier: tier 1 authentic
  // best → 4 generated; minSourceTier=2 ⇒ require tier ≤ 2). A bare source row with no
  // provenance markers derives tier 4 (low); under minSourceTier:2 it must be skipped
  // (not counted toward used) → gap → residual dispatched (target carries minSourceTier).
  it('minSourceTier:2 — a low-tier (tier 4) active candidate does NOT satisfy the demand → residual (Fix 1)', async () => {
    const kc = 'kc-mintier';
    await seedKc(kc, 'math'); // live KC anchor so the residual dispatches.
    // source='quiz_gen' with NO provenance metadata → deriveSourceTier falls through to tier 4.
    await seed({ id: 'q-low', knowledge_ids: [kc], source: 'quiz_gen', draft_status: null });

    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, minSourceTier: 2, limit: 1 }, { dispatch });

    // tier-4 row does not meet minSourceTier:2 → not used; pool yields nothing usable → residual.
    expect(result.used).toEqual([]);
    expect(result.satisfiedFromPool).toBe(false);
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Fix 1 (control) — WITHOUT minSourceTier, the same tier-4 row is used normally
  // (the floor only applies when the demand declares it). Guards against over-filtering.
  it('no minSourceTier — the same tier-4 active row is used normally (Fix 1 control)', async () => {
    const kc = 'kc-mintier-control';
    await seedKc(kc, 'math'); // live KC anchor (YUK-401 Fix 3 front-loaded guard).
    await seed({ id: 'q-low', knowledge_ids: [kc], source: 'quiz_gen', draft_status: null });

    const result = await matcher(db, { knowledgeId: kc, limit: 1 });

    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-low');
    expect(result.satisfiedFromPool).toBe(true);
    expect(result.residual).toEqual([]);
  });

  // codex #3 (round 2) — minSourceTier is an ACQUISITION-tier floor (1-3), but the floor
  // judge must map the candidate's 4-level provenance tier onto that 3-level acquisition
  // scale via acquisitionTierForQuestion (provenance 3 material + 4 generated → acquisition
  // 3). The OLD Fix-1 compared the raw provenance tier (deriveSourceTier 1-4) against the
  // acquisition floor, so a bare quiz_gen row (provenance tier 4 = acquisition tier 3) was
  // wrongly skipped under minSourceTier:3 (4 > 3). It must be USED: acquisition 3 ≤ 3.
  it('minSourceTier:3 — a generated (provenance tier 4 = acquisition tier 3) row IS used, not wrongly skipped (Fix A)', async () => {
    const kc = 'kc-acqtier3';
    await seedKc(kc, 'math'); // live KC anchor.
    // source='quiz_gen' with NO material_grounded provenance → deriveSourceTier tier 4,
    // but acquisitionTierForQuestion maps it to acquisition tier 3 (generated/草稿级).
    await seed({ id: 'q-gen', knowledge_ids: [kc], source: 'quiz_gen', draft_status: null });

    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, minSourceTier: 3, limit: 1 }, { dispatch });

    // acquisition tier 3 satisfies floor 3 → the row is used; pool满足, no residual.
    expect(result.used).toHaveLength(1);
    expect(result.used[0].question_id).toBe('q-gen');
    // the `used` entry still carries the PROVENANCE tier (4) for the A2 sort comparator —
    // only the minSourceTier FLOOR judgement switched to acquisition tier, the sort tier
    // stays provenance (deriveSourceTier). Invariant: A2 sort unchanged.
    expect(result.used[0].tier).toBe(4);
    expect(result.satisfiedFromPool).toBe(true);
    expect(result.residual).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Fix A (contrast) — the SAME generated row (acquisition tier 3) under minSourceTier:2 is
  // skipped (acquisition 3 > 2) → residual. Pins that the floor still excludes below-floor
  // acquisition tiers; only the 3-vs-3 boundary was the bug.
  it('minSourceTier:2 — the same generated row (acquisition tier 3 > 2) is skipped → residual (Fix A contrast)', async () => {
    const kc = 'kc-acqtier2-skip';
    await seedKc(kc, 'math'); // live KC anchor so the residual dispatches.
    await seed({ id: 'q-gen', knowledge_ids: [kc], source: 'quiz_gen', draft_status: null });

    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, minSourceTier: 2, limit: 1 }, { dispatch });

    expect(result.used).toEqual([]);
    expect(result.satisfiedFromPool).toBe(false);
    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // codex #1 (round 2) — pre-dispatch live recheck restores the TOCTOU guard. The top-of-
  // matcher() guard passes (KC live), but the KC is archived DURING the pool-fetch / lazy-
  // verify window; the residual branch must re-check resolveKnowledgeNodeLive and NOT
  // dispatch to a now-dead anchor. We exercise the race by archiving the KC inside the
  // injected verify seam (which runs in the arbitration loop, after the top guard, before
  // residual dispatch). The lone draft then fails verify → gap > 0 → residual recheck →
  // KC now archived → no dispatch, empty residual.
  it('KC live at top but archived before residual dispatch → recheck blocks dispatch (Fix B)', async () => {
    const kc = 'kc-toctou';
    await seedKc(kc, 'math'); // live at the top guard.
    await seed({ id: 'q-draft-only', knowledge_ids: [kc], draft_status: 'draft' });

    // verify archives the KC as a side effect (the TOCTOU window) then fails the draft.
    const verify = vi.fn(async (): Promise<{ promoted: boolean; verifyEventId?: string }> => {
      await db
        .update(knowledge)
        .set({ archived_at: new Date('2024-01-01T00:00:00Z') })
        .where(eq(knowledge.id, kc));
      return { promoted: false };
    });
    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 1 }, { verify, dispatch });

    expect(result.used).toEqual([]);
    // top guard passed (poolFetch ran, verify ran), but the pre-dispatch recheck caught the
    // mid-flight archival → residual NOT dispatched, residual stays empty.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(false);
  });

  // Fix 2 — compositeParentOnly propagation to the residual target.constraints. The
  // demand's 篇-only structural axis must reach the generation end: demandToSupplyTarget
  // writes demand.compositeParentOnly into target.constraints so the dispatched target
  // carries the 「篇」constraint (otherwise the generation side drops it).
  it('compositeParentOnly:true → dispatched target.constraints carries compositeParentOnly (Fix 2)', async () => {
    const kc = 'kc-composite';
    await seedKc(kc, 'math'); // live KC, empty pool → residual dispatch fires.
    let captured: QuestionSupplyTarget | null = null;
    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> => {
        captured = target;
        return fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint });
      },
    );

    const result = await matcher(
      db,
      { knowledgeId: kc, compositeParentOnly: true, limit: 1 },
      { dispatch },
    );

    expect(result.residual.length).toBeGreaterThanOrEqual(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const t = captured as unknown as QuestionSupplyTarget;
    expect(t.constraints.compositeParentOnly).toBe(true);
  });

  // Fix 2 (control) — a demand WITHOUT compositeParentOnly must NOT set the flag on the
  // target (it stays absent/falsy), so the generation side is unconstrained by default.
  it('no compositeParentOnly → dispatched target.constraints does not set it (Fix 2 control)', async () => {
    const kc = 'kc-composite-control';
    await seedKc(kc, 'math');
    let captured: QuestionSupplyTarget | null = null;
    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> => {
        captured = target;
        return fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint });
      },
    );

    await matcher(db, { knowledgeId: kc, limit: 1 }, { dispatch });

    const t = captured as unknown as QuestionSupplyTarget;
    expect(t.constraints.compositeParentOnly).toBeFalsy();
  });

  // Fix 3 — archived-KC live check moved to the TOP of matcher(), before poolFetch. An
  // archived KC that still carries a stale active question must NOT be served from the
  // pool (an archived KC serves no stale items) and must NOT dispatch a residual (the
  // worker anchor guard would reject it anyway). matcher returns the empty triple
  // immediately: used [], residual [], satisfiedFromPool false — a distinguishable signal.
  it('archived KC with a stale active question → pool NOT served, dispatch NOT called, empty triple (Fix 3)', async () => {
    const kc = 'kc-archived-stale';
    // archived KC node…
    await db.insert(knowledge).values({
      id: kc,
      name: kc,
      domain: 'math',
      parent_id: null,
      archived_at: new Date('2024-01-01T00:00:00Z'),
      created_at: new Date(),
      updated_at: new Date(),
    });
    // …that STILL carries a live (non-draft) question on its knowledge_ids.
    await seed({ id: 'q-stale-active', knowledge_ids: [kc], draft_status: null });

    const dispatch = vi.fn(
      async (_db: typeof db, target: QuestionSupplyTarget): Promise<DispatchResult> =>
        fakeDispatchResult({ targetId: target.id, fingerprint: target.fingerprint }),
    );

    const result = await matcher(db, { knowledgeId: kc, limit: 2 }, { dispatch });

    // archived KC: the stale active row is NOT used (poolFetch never reached);
    // no residual dispatched; the empty triple is the distinguishable dead-KC signal.
    expect(result.used).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.residual).toEqual([]);
    expect(result.satisfiedFromPool).toBe(false);
  });
});
