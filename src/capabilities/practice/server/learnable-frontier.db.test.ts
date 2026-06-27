// B3 frontier (YUK-349 #3) — learnableFrontier prereq-gated read + the NO-OP-safety
// invariants. The mastery predicate is the canonical PFA p(L) (β=0 here, no
// item_calibration): point = σ(γ·success + ρ·fail), γ=0.4, ρ=−0.2. So:
//   - success=4, fail=0 → σ(1.6)=0.83 ≥ 0.7  → MASTERED
//   - no row / success=0, fail=0 → σ(0)=0.5 < 0.7 → NOT MASTERED (cold start)

import { knowledge, knowledge_edge, mastery_state } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  FRONTIER_DEPTH_LIMIT,
  learnableFrontier,
  learnableFrontierResolved,
} from './learnable-frontier';

async function seedKc(id: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

/** `from` is a prerequisite of `to` (from_knowledge_id → to_knowledge_id). */
async function seedPrereq(
  from: string,
  to: string,
  opts: { archived?: boolean } = {},
): Promise<void> {
  await seedKc(from);
  await seedKc(to);
  await testDb()
    .insert(knowledge_edge)
    .values({
      id: createId(),
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: 'prerequisite',
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
      archived_at: opts.archived ? new Date() : null,
    });
}

/** Mark a KC mastered (p(L)=σ(0.4·4)=0.83 ≥ 0.7). */
async function setMastered(kc: string): Promise<void> {
  await seedKc(kc);
  await testDb()
    .insert(mastery_state)
    .values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: kc,
      theta_hat: 0,
      evidence_count: 4,
      success_count: 4,
      fail_count: 0,
      theta_precision: 4,
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

/** Mark a KC explicitly NOT mastered (p(L)=σ(0)=0.5 < 0.7). */
async function setNotMastered(kc: string): Promise<void> {
  await seedKc(kc);
  await testDb()
    .insert(mastery_state)
    .values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: kc,
      theta_hat: 0,
      evidence_count: 0,
      success_count: 0,
      fail_count: 0,
      theta_precision: 1,
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

describe('learnableFrontier (B3, YUK-349 #3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('(a) surfaces exactly the {all-prereqs-mastered ∧ self-not-mastered} KCs', async () => {
    // F: prereqs p1,p2 mastered; F not mastered → SURFACES.
    await seedPrereq('p1', 'F');
    await seedPrereq('p2', 'F');
    await setMastered('p1');
    await setMastered('p2');
    await setNotMastered('F');
    // G: prereq u1 NOT mastered; G not mastered → gated OUT.
    await seedPrereq('u1', 'G');
    await setNotMastered('u1');
    await setNotMastered('G');
    // H: prereq p1 mastered, but H itself mastered → excluded (self-mastered).
    await seedPrereq('p1', 'H');
    await setMastered('H');

    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual(['F']);
  });

  it('(b) sparse/empty graph → [] (the NO-OP anchor)', async () => {
    // Knowledge nodes exist but NO prerequisite edges → base case empty → [].
    await seedKc('a');
    await seedKc('b');
    await setNotMastered('a');
    await setNotMastered('b');
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual([]);
  });

  it('(c) cycle guard: A↔B prereq cycle terminates and returns sanely', async () => {
    // A is prereq of B AND B is prereq of A (a 2-cycle). The path-array guard must
    // terminate the walk. B mastered, A not → A surfaces (its only prereq B is mastered);
    // B excluded (self-mastered).
    await seedPrereq('A', 'B');
    await seedPrereq('B', 'A');
    await setMastered('B');
    await setNotMastered('A');
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual(['A']);
  });

  it('(d) depth-limit overflow → fail-safe [] (never a partial frontier)', async () => {
    // Linear prereq chain k0 → k1 → ... → kN with N > FRONTIER_DEPTH_LIMIT: the deepest
    // closure row has depth > the limit → whole result refused → [].
    const n = FRONTIER_DEPTH_LIMIT + 4; // 20
    for (let i = 0; i < n; i++) {
      await seedPrereq(`k${i}`, `k${i + 1}`); // k_i is prereq of k_{i+1}
    }
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual([]);
  });

  it('(e) archived prerequisite edge is excluded (does not gate or surface)', async () => {
    // F's only prereq edge is archived → F never appears as a `to_` of a LIVE edge → F is
    // not a frontier candidate. F2 has a live mastered prereq → surfaces. Proves archived
    // exclusion while the live path still works.
    await seedPrereq('p', 'F', { archived: true });
    await setMastered('p');
    await setNotMastered('F');
    await seedPrereq('p2', 'F2');
    await setMastered('p2');
    await setNotMastered('F2');

    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual(['F2']);
    expect(frontier).not.toContain('F');
  });

  it('(f) vacuous exclusion: a zero-prereq KC NEVER surfaces, even when not-mastered', async () => {
    // Z has NO prerequisites and is not mastered — it must NOT surface (it is never a
    // `to_` endpoint → "all prereqs mastered" can never be satisfied vacuously). F (with a
    // mastered prereq) does surface, proving the gate is structural, not a blanket empty.
    await seedKc('Z');
    await setNotMastered('Z');
    await seedPrereq('p', 'F');
    await setMastered('p');
    await setNotMastered('F');

    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual(['F']);
    expect(frontier).not.toContain('Z');
  });

  it('(g) cold-start prereq (no mastery row, p(L)=0.5) gates its dependent OUT', async () => {
    // F's prereq p has NO mastery_state row → p(L)=0.5 < 0.7 → NOT mastered → F gated out.
    await seedPrereq('p', 'F');
    await setNotMastered('F');
    // (no setMastered/setNotMastered for p → no row → cold start)
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual([]);
  });

  // Diamond A→B, A→C, B→D, C→D. A is a transitive prereq of D via TWO paths (A→B→D and
  // A→C→D). The old per-path closure enumerated A once PER simple path; the UNION set-walk +
  // GROUP BY collapse the convergent paths to ONE (D,A) pair. (B, C are self-mastered →
  // excluded; A is an apex with no incoming prereq edge → never a frontier candidate.)
  async function seedDiamond(): Promise<void> {
    await seedPrereq('A', 'B');
    await seedPrereq('A', 'C');
    await seedPrereq('B', 'D');
    await seedPrereq('C', 'D');
  }

  it('(h) diamond DAG: D surfaces when its full deduped closure {A,B,C} is mastered', async () => {
    await seedDiamond();
    await setMastered('A');
    await setMastered('B');
    await setMastered('C');
    await setNotMastered('D');
    expect(await learnableFrontier(testDb())).toEqual(['D']);
  });

  it('(h2) diamond DAG: the multi-path apex A still gates — A unproven → D gated OUT', async () => {
    // A is reached via BOTH B→D and C→D; proving it is IN D's transitive closure (not lost
    // to dedup). A has no mastery row → cold-start p(L)=0.5 < 0.7 → unproven → D gated out.
    await seedDiamond();
    await setMastered('B');
    await setMastered('C');
    await setNotMastered('D');
    // (A intentionally left cold — no mastery row)
    expect(await learnableFrontier(testDb())).toEqual([]);
  });

  // Shallow but WIDE diamond: apex R → m0..m11 (12 middles) → T. T reaches R via 12 distinct
  // depth-2 paths. UNION ALL would materialise R 12× in the working table (and a chain of
  // such layers would be exponential); the UNION set-walk + GROUP BY keep it to a single
  // (T,R) pair — the path-explosion guard.
  const FAN_IN_WIDTH = 12;
  const fanInMiddles = Array.from({ length: FAN_IN_WIDTH }, (_, i) => `m${i}`);
  async function seedWideFanIn(): Promise<void> {
    for (const m of fanInMiddles) {
      await seedPrereq('R', m); // R is a prereq of every middle
      await seedPrereq(m, 'T'); // every middle is a prereq of T
    }
  }

  it('(i) wide multi-path fan-in stays bounded and correct — T surfaces when {R, mₙ} mastered', async () => {
    await seedWideFanIn();
    await setMastered('R');
    for (const m of fanInMiddles) await setMastered(m);
    await setNotMastered('T');
    expect(await learnableFrontier(testDb())).toEqual(['T']);
  });

  it('(i2) wide multi-path fan-in: the deduped apex R still gates — R unproven → T gated OUT', async () => {
    // R is reached via all 12 fan-in paths; proving it is a single deduped transitive prereq
    // that still gates. R left cold (no mastery row) → unproven → T gated out.
    await seedWideFanIn();
    for (const m of fanInMiddles) await setMastered(m);
    await setNotMastered('T');
    // (R intentionally left cold — no mastery row)
    expect(await learnableFrontier(testDb())).toEqual([]);
  });

  it('(j) learnableFrontierResolved surfaces the closure state (sparse | dense | overflow)', async () => {
    // sparse: nodes but no prereq edges → empty closure.
    await seedKc('s1');
    await setNotMastered('s1');
    const sparse = await learnableFrontierResolved(testDb());
    expect(sparse.kind).toBe('sparse');
    expect(sparse.ids).toEqual([]);

    // dense: a real prereq edge with a mastered prereq → a learnable frontier.
    await seedPrereq('dp', 'dF');
    await setMastered('dp');
    await setNotMastered('dF');
    const dense = await learnableFrontierResolved(testDb());
    expect(dense.kind).toBe('dense');
    expect(dense.ids).toEqual(['dF']);

    // overflow: a chain deeper than FRONTIER_DEPTH_LIMIT trips the depth fail-safe →
    // kind 'overflow', ids [] (the case YUK-514 must tell apart from cold-start 'sparse').
    const n = FRONTIER_DEPTH_LIMIT + 4;
    for (let i = 0; i < n; i++) await seedPrereq(`c${i}`, `c${i + 1}`);
    const overflow = await learnableFrontierResolved(testDb());
    expect(overflow.kind).toBe('overflow');
    expect(overflow.ids).toEqual([]);
  });
});
