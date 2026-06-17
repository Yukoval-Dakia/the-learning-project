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
