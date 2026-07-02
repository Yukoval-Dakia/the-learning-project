// P2 (YUK-489) — tagKnowledge (unified match-or-propose) DB tests.
//
// Uses orthogonal unit basis vectors for predictable cosine distances (mirrors
// match-similarity.db.test.ts): <=>(unit(i),unit(i))=0 (a guaranteed MATCH), and
// <=>(unit(i),unit(j≠i))=1 (well past MATCH_THRESHOLD=0.55 → PROPOSE). NO real model /
// embedder is called — embedFn + nameKcFn are stubbed.
import { event, knowledge } from '@/db/schema';
import { projectKnowledgeNode } from '@/server/projections/knowledge';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { tagKnowledge } from './tag-knowledge';
import { MATCH_THRESHOLD } from './tagging-flags';

const DIMS = 1024;
const SUBJECT_ROOT = 'seed:math:root';

/** A 1024-dim unit basis vector: 1 at index `i`, 0 elsewhere. */
function unitVec(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  return v;
}

async function seedKc(
  db: ReturnType<typeof testDb>,
  id: string,
  embedding: number[] | null,
  opts: { name?: string; domain?: string | null; parent_id?: string | null } = {},
): Promise<void> {
  const now = new Date();
  const values: Record<string, unknown> = {
    id,
    name: opts.name ?? id,
    domain: opts.domain ?? null,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  };
  if (embedding) values.embedding = embedding;
  await db.insert(knowledge).values(values as typeof knowledge.$inferInsert);
}

/** Plant the subject root so applyProposeNew's assertParentExists passes. */
async function seedRoot(db: ReturnType<typeof testDb>): Promise<void> {
  await seedKc(db, SUBJECT_ROOT, unitVec(500), { name: 'Math', domain: 'math' });
}

/** embedFn stub: always return the given fixed query vector (no real embedder). */
function stubEmbed(vec: number[]): (text: string) => Promise<number[]> {
  return async () => vec;
}

/** nameKcFn stub: always return the given name (no real model). Tracks call count. */
function stubName(name: string): {
  fn: (args: {
    questionText: string;
    knowledgeHint: string | null;
    subjectId: string;
    knownSubjectIds: readonly string[];
  }) => Promise<{ kc_name: string }>;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    fn: async () => {
      state.calls += 1;
      return { kc_name: name };
    },
    get calls() {
      return state.calls;
    },
  };
}

describe('tagKnowledge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('MATCH: a candidate within threshold → kind:match, returns its id, NO new KC', async () => {
    const db = testDb();
    await seedRoot(db);
    await seedKc(db, 'kc-near', unitVec(0), { name: 'Quadratics', parent_id: SUBJECT_ROOT });

    const namer = stubName('SHOULD-NOT-BE-CALLED');
    const before = (await db.select({ id: knowledge.id }).from(knowledge)).length;

    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn },
      { questionText: 'solve x^2 - 5x + 6 = 0', subjectRootId: SUBJECT_ROOT },
    );

    expect(out.kind).toBe('match');
    expect(out.knowledge_ids).toContain('kc-near');
    expect(namer.calls).toBe(0); // MATCH never names
    // No KC created (count unchanged).
    const after = (await db.select({ id: knowledge.id }).from(knowledge)).length;
    expect(after).toBe(before);
    // No audit event written under the PROPOSE action — this is the collision-safety
    // regression anchor (YUK-540 must never reuse `_created` for MATCH).
    const events = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_created'));
    expect(events).toHaveLength(0);

    // YUK-540: MATCH now DOES write its own, distinctly-named audit event.
    const matchEvents = await db
      .select({ subject_id: event.subject_id, payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_matched'));
    expect(matchEvents).toHaveLength(1);
    expect(matchEvents[0].subject_id).toBe('kc-near');
    const payload = matchEvents[0].payload as Record<string, unknown> & {
      matches: Array<{ knowledge_id: string; name: string; cosine_distance: number }>;
    };
    expect(payload.threshold).toBe(MATCH_THRESHOLD);
    expect(payload.primary_knowledge_id).toBe('kc-near');
    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0].knowledge_id).toBe('kc-near');
    expect(payload.matches[0].name).toBe('Quadratics');
    // Identical-direction vectors → cosine distance ~0 (codebase convention for this fixture
    // shape — see match-similarity.db.test.ts, which also tolerates float noise rather than
    // asserting exact 0).
    expect(payload.matches[0].cosine_distance).toBeLessThan(0.01);
  });

  it('MATCH multi: every candidate within threshold is returned nearest-first; outside one excluded', async () => {
    const db = testDb();
    await seedRoot(db);
    // Place candidates in distinct directions (each mixes e0 with a different orthogonal axis)
    // so query=unit(0) sees cosine DISTANCE = 1 - cos. Two land inside MATCH_THRESHOLD (0.55),
    // one lands outside. The load-bearing assertion: tagKnowledge returns BOTH inner ids in
    // nearest-first order and DROPS the outer — not just the single nearest.
    function mixedAxis(cos: number, axis: number): number[] {
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      const v = new Array<number>(DIMS).fill(0);
      v[0] = cos;
      v[axis] = sin;
      return v;
    }
    await seedKc(db, 'kc-near1', mixedAxis(0.9, 1), { name: 'Near1', parent_id: SUBJECT_ROOT }); // dist ~0.10
    await seedKc(db, 'kc-near2', mixedAxis(0.75, 2), { name: 'Near2', parent_id: SUBJECT_ROOT }); // dist ~0.25
    await seedKc(db, 'kc-far', mixedAxis(0.3, 3), { name: 'Far', parent_id: SUBJECT_ROOT }); // dist ~0.70 → out (> 0.55)

    const namer = stubName('SHOULD-NOT-BE-CALLED');
    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn },
      { questionText: 'q-multi', subjectRootId: SUBJECT_ROOT },
    );

    expect(out.kind).toBe('match');
    // Both inner ids, nearest-first (near1 closer than near2); the outer one excluded.
    expect(out.knowledge_ids).toEqual(['kc-near1', 'kc-near2']);
    expect(namer.calls).toBe(0);

    // YUK-540: the match event's payload.matches fidelity — exactly the 2 in-threshold ids
    // (nearest-first), the 3rd (out-of-threshold) excluded.
    const matchEvents = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_matched'));
    expect(matchEvents).toHaveLength(1);
    const payload = matchEvents[0].payload as Record<string, unknown> & {
      matches: Array<{ knowledge_id: string }>;
    };
    expect(payload.matches.map((m) => m.knowledge_id)).toEqual(['kc-near1', 'kc-near2']);
  });

  it('PROPOSE: no candidate within threshold → kind:propose, new approved KC + audit event', async () => {
    const db = testDb();
    await seedRoot(db);
    // An existing KC orthogonal to the query (distance ~1, well past 0.55) → no match.
    await seedKc(db, 'kc-far', unitVec(1), { name: 'Trigonometry', parent_id: SUBJECT_ROOT });

    const namer = stubName('Probability');
    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn },
      {
        questionText: 'a fair die is rolled twice',
        knowledgeHint: 'odds',
        subjectRootId: SUBJECT_ROOT,
      },
    );

    expect(out.kind).toBe('propose');
    expect(namer.calls).toBe(1);
    expect(out.knowledge_ids).toHaveLength(1);
    const newId = out.knowledge_ids[0];
    if (out.kind === 'propose') {
      expect(out.kc_name).toBe('Probability');
    }

    // The new KC is live, approved, under the subject root, with the proposed name.
    const created = (await db.select().from(knowledge).where(eq(knowledge.id, newId)))[0];
    expect(created).toBeDefined();
    expect(created.name).toBe('Probability');
    expect(created.parent_id).toBe(SUBJECT_ROOT);
    expect(created.approval_status).toBe('approved');
    expect(created.proposed_by_ai).toBe(true);

    // The audit-only event exists, points at the new KC, and carries provenance.
    const events = await db
      .select({ subject_id: event.subject_id, payload: event.payload })
      .from(event)
      .where(
        and(eq(event.action, 'experimental:auto_tag_kc_created'), eq(event.subject_id, newId)),
      );
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.auto_created_kc_id).toBe(newId);
    expect(payload.subject_root_id).toBe(SUBJECT_ROOT);
    expect(payload.name).toBe('Probability');
  });

  it('threshold boundary: just-inside → match, just-outside → propose', async () => {
    const db = testDb();
    await seedRoot(db);
    // Build a candidate whose cosine DISTANCE to the query is exactly just-inside vs
    // just-outside MATCH_THRESHOLD by mixing two orthogonal basis vectors. For a query =
    // unit(0) and candidate proportional to (cosθ·e0 + sinθ·e1), cosine distance = 1 - cosθ.
    // Pick cosθ so distance lands ε on each side of the threshold.
    const eps = 0.02;
    const cosInside = 1 - (MATCH_THRESHOLD - eps); // distance = threshold - eps  → MATCH
    const cosOutside = 1 - (MATCH_THRESHOLD + eps); // distance = threshold + eps → PROPOSE

    function mixed(cos: number): number[] {
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      const v = new Array<number>(DIMS).fill(0);
      v[0] = cos;
      v[1] = sin;
      return v;
    }

    // --- just inside → MATCH ---
    await seedKc(db, 'kc-inside', mixed(cosInside), { name: 'Inside', parent_id: SUBJECT_ROOT });
    const insideNamer = stubName('SHOULD-NOT-BE-CALLED');
    const inside = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: insideNamer.fn },
      { questionText: 'q-inside', subjectRootId: SUBJECT_ROOT },
    );
    expect(inside.kind).toBe('match');
    expect(inside.knowledge_ids).toContain('kc-inside');
    expect(insideNamer.calls).toBe(0);
    // YUK-540: the inside branch wrote exactly 1 match event, cosine_distance ≈ threshold - eps.
    const insideMatchEvents = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_matched'));
    expect(insideMatchEvents).toHaveLength(1);
    const insidePayload = insideMatchEvents[0].payload as Record<string, unknown> & {
      matches: Array<{ cosine_distance: number }>;
    };
    expect(insidePayload.matches[0].cosine_distance).toBeCloseTo(MATCH_THRESHOLD - eps, 2);

    // --- just outside → PROPOSE (fresh DB, only the outside candidate present) ---
    await resetDb();
    await seedRoot(db);
    await seedKc(db, 'kc-outside', mixed(cosOutside), { name: 'Outside', parent_id: SUBJECT_ROOT });
    const outsideNamer = stubName('FreshConcept');
    const outside = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: outsideNamer.fn },
      { questionText: 'q-outside', subjectRootId: SUBJECT_ROOT },
    );
    expect(outside.kind).toBe('propose');
    expect(outsideNamer.calls).toBe(1);
  });

  it('batch-cache reuse: two siblings proposing the same name → second reuses, ONE KC created', async () => {
    const db = testDb();
    await seedRoot(db);
    // No matchable candidate (orthogonal) → both questions take the PROPOSE path.
    await seedKc(db, 'kc-far', unitVec(1), { name: 'Other', parent_id: SUBJECT_ROOT });

    const namer = stubName('SharedTopic');
    const batchCache = new Map<string, string>();

    const first = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn, batchCache },
      { questionText: 'sibling question 1', subjectRootId: SUBJECT_ROOT },
    );
    const second = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn, batchCache },
      { questionText: 'sibling question 2', subjectRootId: SUBJECT_ROOT },
    );

    expect(first.kind).toBe('propose');
    expect(second.kind).toBe('propose');
    // Second reuses the first's id.
    expect(second.knowledge_ids).toEqual(first.knowledge_ids);
    // Naming ran for both (cache keys on the name → must name to learn it), but only ONE KC
    // was created (second hit the cache before applyProposeNew).
    expect(namer.calls).toBe(2);
    const created = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(eq(knowledge.name, 'SharedTopic'));
    expect(created).toHaveLength(1);
    // Exactly one audit event, too.
    const events = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_created'));
    expect(events).toHaveLength(1);
  });

  it('empty tree (only the subject root, orthogonal) → propose', async () => {
    const db = testDb();
    await seedRoot(db); // root embed is unitVec(500), orthogonal to the query → no match
    const namer = stubName('FirstConcept');

    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn },
      { questionText: 'the very first uploaded question', subjectRootId: SUBJECT_ROOT },
    );

    expect(out.kind).toBe('propose');
    expect(namer.calls).toBe(1);
    expect(out.knowledge_ids).toHaveLength(1);
    const created = (
      await db.select().from(knowledge).where(eq(knowledge.id, out.knowledge_ids[0]))
    )[0];
    expect(created.name).toBe('FirstConcept');
    expect(created.parent_id).toBe(SUBJECT_ROOT);
  });

  it('D1 subject filter: a near candidate under a DIFFERENT subject root → propose, not a cross-subject match', async () => {
    const db = testDb();
    // Target subject root = math (domain math). Plant a SECOND subject root (physics) and a
    // near candidate (distance 0 to the query) UNDER it. Nothing matchable lives under math.
    await seedRoot(db); // seed:math:root, domain 'math'
    await seedKc(db, 'seed:physics:root', unitVec(700), { name: 'Physics', domain: 'physics' });
    // The query vector exactly equals this physics KC's embedding → distance 0 (well inside
    // MATCH_THRESHOLD). Without the D1 subject filter this would yield a WRONG cross-subject
    // match. With the filter it is dropped and the question proposes under the math root.
    await seedKc(db, 'kc-physics-near', unitVec(0), {
      name: 'Projectile Motion',
      parent_id: 'seed:physics:root',
    });

    const namer = stubName('Quadratic Equations');
    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: namer.fn },
      { questionText: 'solve x^2 - 5x + 6 = 0', subjectRootId: SUBJECT_ROOT },
    );

    // The cross-subject near-neighbour was filtered out → no match → PROPOSE under math root.
    expect(out.kind).toBe('propose');
    expect(namer.calls).toBe(1);
    expect(out.knowledge_ids).toHaveLength(1);
    const created = (
      await db.select().from(knowledge).where(eq(knowledge.id, out.knowledge_ids[0]))
    )[0];
    expect(created.name).toBe('Quadratic Equations');
    // Minted under the MATH root, not orphaned under physics.
    expect(created.parent_id).toBe(SUBJECT_ROOT);
    // The physics KC was untouched (not returned, not re-parented).
    const physicsKc = (
      await db.select().from(knowledge).where(eq(knowledge.id, 'kc-physics-near'))
    )[0];
    expect(physicsKc.parent_id).toBe('seed:physics:root');
  });

  it('PROPOSE with an empty name from the namer → throws, creates nothing', async () => {
    const db = testDb();
    await seedRoot(db);
    const before = (await db.select({ id: knowledge.id }).from(knowledge)).length;

    await expect(
      tagKnowledge(
        { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: stubName('   ').fn }, // whitespace-only
        { questionText: 'q', subjectRootId: SUBJECT_ROOT },
      ),
    ).rejects.toThrow(/empty KC name/);

    // No KC minted, no audit event.
    const after = (await db.select({ id: knowledge.id }).from(knowledge)).length;
    expect(after).toBe(before);
    const events = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_created'));
    expect(events).toHaveLength(0);
  });

  // YUK-540 — sourceRef threading: the caller-supplied provenance anchor lands verbatim on
  // the MATCH audit event's payload.source_ref, and defaults to null when omitted.
  it('sourceRef threading: MATCH with a sourceRef → payload.source_ref carries it verbatim', async () => {
    const db = testDb();
    await seedRoot(db);
    await seedKc(db, 'kc-near', unitVec(0), { name: 'Quadratics', parent_id: SUBJECT_ROOT });

    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: stubName('SHOULD-NOT-BE-CALLED').fn },
      {
        questionText: 'solve x^2 - 5x + 6 = 0',
        subjectRootId: SUBJECT_ROOT,
        sourceRef: { kind: 'question_block', id: 'block-123' },
      },
    );
    expect(out.kind).toBe('match');

    const matchEvents = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_matched'));
    expect(matchEvents).toHaveLength(1);
    const payload = matchEvents[0].payload as Record<string, unknown>;
    expect(payload.source_ref).toEqual({ kind: 'question_block', id: 'block-123' });
  });

  it('sourceRef threading: MATCH with sourceRef omitted → payload.source_ref is null', async () => {
    const db = testDb();
    await seedRoot(db);
    await seedKc(db, 'kc-near', unitVec(0), { name: 'Quadratics', parent_id: SUBJECT_ROOT });

    const out = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: stubName('SHOULD-NOT-BE-CALLED').fn },
      { questionText: 'solve x^2 - 5x + 6 = 0', subjectRootId: SUBJECT_ROOT },
    );
    expect(out.kind).toBe('match');

    const matchEvents = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_matched'));
    expect(matchEvents).toHaveLength(1);
    const payload = matchEvents[0].payload as Record<string, unknown>;
    expect(payload.source_ref).toBeNull();
  });

  // YUK-540 (adversarial-review addition) — fold-parity: the MATCH audit event's action
  // (`experimental:auto_tag_kc_matched`) is UNKNOWN to foldKnowledgeNode (core/projections/
  // knowledge.ts) — no branch matches it, so the reducer must fall through and leave the
  // node's projected row untouched. This pins that "reducer ignores unknown actions" invariant
  // now that a MATCH writes a second, differently-shaped event against an EXISTING (already
  // event-sourced) node — the fold's gather (Q1, subject-keyed) WILL pick up this new event
  // (same subject_kind/subject_id as the node's genesis), so this is a real regression anchor,
  // not a vacuous one. YUK-471 W1 PR-B (projection-SoT flip) is in flight; a fold that
  // mis-handles this new action is exactly the kind of drift that flip would surface live.
  it('fold-parity: a MATCH event against an existing (event-sourced) KC does not perturb its projected row', async () => {
    const db = testDb();
    await seedRoot(db);
    // No matchable candidate yet → the first tag PROPOSEs, giving the KC a real genesis
    // anchor (experimental:auto_tag_kc_created) so gatherAndFoldKnowledgeNode can reproduce it
    // (a directly-seeded, non-event-sourced fixture would fold to null — not what we want to
    // test here).
    const proposeNamer = stubName('Ratios');
    const proposed = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: proposeNamer.fn },
      { questionText: 'q-genesis', subjectRootId: SUBJECT_ROOT },
    );
    expect(proposed.kind).toBe('propose');
    const kcId = proposed.knowledge_ids[0];

    // applyProposeNew does not embed the new KC (that is the nightly embed_backfill's job) —
    // matchKnowledgeBySimilarity only returns EMBEDDED rows, so without this the second call
    // below would find no candidate and PROPOSE again instead of MATCH-ing kcId. Backfill it
    // directly (mirrors the nightly job) so this KC becomes the matchable target.
    await db
      .update(knowledge)
      .set({ embedding: unitVec(0) })
      .where(eq(knowledge.id, kcId));

    const rowBefore = (await db.select().from(knowledge).where(eq(knowledge.id, kcId)))[0];
    expect(rowBefore).toBeDefined();

    // Now MATCH against this exact KC (same query embedding → distance ~0).
    const matchNamer = stubName('SHOULD-NOT-BE-CALLED');
    const matched = await tagKnowledge(
      { db, embedFn: stubEmbed(unitVec(0)), nameKcFn: matchNamer.fn },
      {
        questionText: 'q-match',
        subjectRootId: SUBJECT_ROOT,
        sourceRef: { kind: 'question_block', id: 'block-xyz' },
      },
    );
    expect(matched.kind).toBe('match');
    expect(matched.knowledge_ids).toContain(kcId);
    expect(matchNamer.calls).toBe(0);

    const matchEvents = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_matched'));
    expect(matchEvents).toHaveLength(1);

    // The live row is untouched by MATCH itself (no `knowledge` table write in that branch).
    const rowAfterMatch = (await db.select().from(knowledge).where(eq(knowledge.id, kcId)))[0];
    expect(rowAfterMatch).toEqual(rowBefore);

    // Re-derive the row from the event log (gather→fold→write-through) and assert it is
    // byte-identical to before — the reducer must silently skip the unknown MATCH action.
    await projectKnowledgeNode(db, kcId);
    const rowAfterProject = (await db.select().from(knowledge).where(eq(knowledge.id, kcId)))[0];
    expect(rowAfterProject).toEqual(rowBefore);
  });
});
