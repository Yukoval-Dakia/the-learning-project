// B3 frontier (YUK-349 #3) — learnableFrontier prereq-gated read + the NO-OP-safety
// invariants. The mastery predicate is the canonical PFA p(L) (β=0 here, no
// item_calibration): point = σ(γ·success + ρ·fail), γ=0.5, ρ=−0.25 (YUK-539 retune),
// AND (YUK-539) an evidence_count ≥ FRONTIER_MASTERY_MIN_EVIDENCE (4) floor. So:
//   - success=4, fail=0, evidence=4 → σ(2.0)=0.88 ≥ 0.7 AND evidence 4 ≥ 4 → MASTERED
//   - no row / success=0, fail=0 → σ(0)=0.5 < 0.7 → NOT MASTERED (cold start)
//   - success=3, fail=0, evidence=3 → σ(1.5)=0.82 ≥ 0.7 but evidence 3 < 4 → NOT mastered-enough

import { knowledge, knowledge_edge, mastery_state } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  FRONTIER_DEPTH_LIMIT,
  FRONTIER_NODE_CAP,
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
      domain: 'yuwen',
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

/**
 * Batch-seed a linear prereq chain `${prefix}0 → ${prefix}1 → … → ${prefix}edges` (edges
 * edges, edges+1 KCs) in TWO bulk inserts instead of 2·edges serial round-trips — the
 * overflow shapes ((d) / (j) / (p)) need 20+-edge chains and were the slowest seeds in the
 * file (review E1).
 */
async function seedChain(prefix: string, edges: number): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values(
      Array.from({ length: edges + 1 }, (_, i) => ({
        id: `${prefix}${i}`,
        name: `${prefix}${i}`,
        domain: 'yuwen',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        // as const: Array.from 回调内字面量会被 widen 成 string,过不了 enum union 列类型。
        approval_status: 'approved' as const,
        created_at: now,
        updated_at: now,
        version: 0,
      })),
    )
    .onConflictDoNothing();
  await testDb()
    .insert(knowledge_edge)
    .values(
      Array.from({ length: edges }, (_, i) => ({
        id: createId(),
        from_knowledge_id: `${prefix}${i}`,
        to_knowledge_id: `${prefix}${i + 1}`,
        relation_type: 'prerequisite',
        weight: 1,
        created_by: 'user' as never,
        reasoning: null,
        created_at: now,
        archived_at: null,
      })),
    );
}

/**
 * CR1 (PR #697) — depth-1 COMPLETE BIPARTITE prereq graph: `prereqs` roots (bp*) each a
 * prerequisite of ALL `dependents` (bd*) → prereqs·dependents distinct
 * (frontier_kc, prereq_kc) closure pairs, every one at depth 1. This trips the NODE-CAP arm
 * of the overflow probe with depthOverflow FALSE — the chain shapes ((d)/(j)/(p)) can only
 * trip the depth arm. Real-data trigger by design: FRONTIER_NODE_CAP is closed over inside
 * learnableFrontierResolved, so "mocking the constant" would mean mocking the module under
 * test itself (a self-certifying test). Edge rows bulk-insert in chunks (9 bind params/row;
 * postgres wire protocol caps a statement at 65,534 params).
 */
async function seedBipartite(prereqs: number, dependents: number): Promise<void> {
  const now = new Date();
  const kcIds = [
    ...Array.from({ length: prereqs }, (_, i) => `bp${i}`),
    ...Array.from({ length: dependents }, (_, i) => `bd${i}`),
  ];
  await testDb()
    .insert(knowledge)
    .values(
      kcIds.map((id) => ({
        id,
        name: id,
        domain: 'yuwen',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved' as const,
        created_at: now,
        updated_at: now,
        version: 0,
      })),
    )
    .onConflictDoNothing();
  const edgeRows = [];
  for (let p = 0; p < prereqs; p++) {
    for (let d = 0; d < dependents; d++) {
      edgeRows.push({
        id: createId(),
        from_knowledge_id: `bp${p}`,
        to_knowledge_id: `bd${d}`,
        relation_type: 'prerequisite',
        weight: 1,
        created_by: 'user' as never,
        reasoning: null,
        created_at: now,
        archived_at: null,
      });
    }
  }
  const CHUNK = 5_000; // 5,000 rows × 9 params = 45,000 < 65,534.
  for (let i = 0; i < edgeRows.length; i += CHUNK) {
    await testDb()
      .insert(knowledge_edge)
      .values(edgeRows.slice(i, i + CHUNK));
  }
}

/**
 * Shared mastery_state seeding core (review S3) — the named wrappers below document the four
 * gate-relevant shapes; tests keep using the wrappers for readability.
 */
async function seedMasteryState(
  kc: string,
  shape: { evidence: number; success: number; fail?: number; precision?: number },
): Promise<void> {
  await seedKc(kc);
  await testDb()
    .insert(mastery_state)
    .values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: kc,
      theta_hat: 0,
      evidence_count: shape.evidence,
      success_count: shape.success,
      fail_count: shape.fail ?? 0,
      theta_precision: shape.precision ?? 4,
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

/** Mark a KC mastered (p(L)=σ(0.5·4)=0.88 ≥ 0.7 AND evidence_count 4 ≥ floor 4). */
const setMastered = (kc: string) => seedMasteryState(kc, { evidence: 4, success: 4 });

/** Mark a KC explicitly NOT mastered (p(L)=σ(0)=0.5 < 0.7). */
const setNotMastered = (kc: string) =>
  seedMasteryState(kc, { evidence: 0, success: 0, precision: 1 });

/** Mark a KC "near-mastered" (YUK-539): raw p(L)=σ(0.5·3)=0.82 ≥ 0.7 BUT evidence_count 3 <
 *  the FRONTIER_MASTERY_MIN_EVIDENCE floor (4) → NOT mastered-enough (three lucky corrects). */
const setNearMastered = (kc: string) => seedMasteryState(kc, { evidence: 3, success: 3 });

/**
 * YUK-551 (spec Q4/M4; 诚实化 per review A2) — a SYNTHETIC shape isolating the EVIDENCE arm
 * of the AND gate: high p(L) point (success=4/fail=0 → σ(2.0)=0.88 at β=0) with
 * evidence_count=0 (the value the kg-borrow branch hard-codes). This is NOT a reproduction
 * of the real borrow projection: that branch is IN-MEMORY only (applyKgSoftLayer synthesizes
 * projection entries — no mastery_state row is ever written), is flag-dark today, and its
 * point estimate is σ(−β) from pfaLogit(β,γ,ρ,0,0) (state.ts) — ≤0.5 for any β≥0 anchor,
 * i.e. a real borrowed prereq would typically fail the p(L) arm TOO. Seeding a DB row with
 * high p(L) + zero evidence deliberately over-approximates that shape: it pins that EVEN IF
 * a 0-evidence entry cleared the p(L) arm, the evidence floor ALONE still gates. Near-twin
 * of setNearMastered (evidence=3, test (l)). True borrow-branch characterization (through
 * applyKgSoftLayer itself) is deferred to register #6 (the kg-borrowing unit).
 */
const setSyntheticHighPlZeroEvidence = (kc: string) =>
  seedMasteryState(kc, { evidence: 0, success: 4 });

describe('learnableFrontier (B3, YUK-349 #3)', () => {
  // console.warn spy for the overflow-emit tests ((p)/(q)/(r)) — describe-level so the
  // per-test try/finally boilerplate is gone (review S1); other tests simply ignore it.
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    // A is prereq of B AND B is prereq of A (a 2-cycle). The frontier-anchor guard
    // (e.from_knowledge_id <> c.frontier_kc) cuts the back-edge to each anchor, terminating
    // the walk (each node is the anchor of its own closure, so its self-cycle is blocked).
    // B mastered, A not → A surfaces (its only prereq B is mastered); B excluded (self-mastered).
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
    await seedChain('k', FRONTIER_DEPTH_LIMIT + 4); // 20 edges
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
    await seedChain('c', FRONTIER_DEPTH_LIMIT + 4);
    const overflow = await learnableFrontierResolved(testDb());
    expect(overflow.kind).toBe('overflow');
    expect(overflow.ids).toEqual([]);
  });

  it('(k) upstream prereq-only cycle NOT containing the frontier anchor → overflow (fail-safe)', async () => {
    // YUK-512 residual semantics lock. The frontier-anchor guard (from <> frontier_kc) only
    // cuts a cycle that returns to the dependent being gated. An upstream prereq-only cycle
    // among ANCESTORS that never re-touches the anchor (A→B→C→A, all upstream of F) is NOT
    // cut by the anchor guard — it increments depth each lap until c.depth < depthProbe trips,
    // so the closure for frontier_kc=F carries a row with depth > FRONTIER_DEPTH_LIMIT. Per
    // invariant ③ that makes the WHOLE result fail-safe to overflow→[] (never a partial/garbage
    // frontier), where the old per-path ARRAY guard would have terminated gracefully. This
    // pins that fail-safe as INTENDED behavior before the graph densifies (NIT-1).
    await seedPrereq('A', 'F'); // A is a (direct) prereq of F — F is the frontier anchor.
    await seedPrereq('A', 'B'); // A→B→C→A: a 3-node prereq cycle entirely UPSTREAM of F,
    await seedPrereq('B', 'C'); //   none of whose nodes is the anchor F, so the anchor guard
    await seedPrereq('C', 'A'); //   never trips on it → the depth bound is what terminates it.
    await setNotMastered('F');

    const resolved = await learnableFrontierResolved(testDb());
    expect(resolved.kind).toBe('overflow');
    expect(resolved.ids).toEqual([]);
    // The thin wrapper collapses overflow to the byte-identical [] live-path contract.
    expect(await learnableFrontier(testDb())).toEqual([]);
  });

  it('(l) evidence-count floor — prereq role: 3 clean corrects (raw p(L)≥0.7, evidence<4) do NOT satisfy a prereq → dependent gated OUT', async () => {
    // p1 has success=3/fail=0/evidence=3: raw p(L)=σ(1.5)=0.82 ≥ 0.7, but evidence 3 < the
    // FRONTIER_MASTERY_MIN_EVIDENCE floor (4) → NOT mastered-enough → F's only prereq is
    // unproven → F gated OUT, despite p1 clearing the p(L) threshold (YUK-539 defect-b fix).
    await seedPrereq('p1', 'F');
    await setNearMastered('p1');
    await setNotMastered('F');
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual([]);
  });

  it('(m) evidence-count floor — self role: F with 3 clean corrects (evidence<4) still surfaces (NOT skipped as self-mastered)', async () => {
    // F itself has success=3/fail=0/evidence=3 (raw p(L)≥0.7 but evidence<4) and a
    // fully-mastered prereq. The self-skip is gated on masteredEnough (p(L) AND evidence), so
    // F is NOT dropped as "self already mastered" on three lucky answers → it surfaces.
    await seedPrereq('p1', 'F');
    await setMastered('p1');
    await setNearMastered('F');
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual(['F']);
  });

  it('(n) evidence-count floor boundary: at evidence_count=4 the same streak now counts as mastered-enough → F self-mastered, excluded', async () => {
    // Companion boundary pin to (m): with the existing setMastered helper (success=4/
    // evidence=4), F clears BOTH the p(L) threshold AND the evidence floor → masteredEnough →
    // F is skipped as self-mastered (excluded) even though its prereq is mastered. Pins the
    // floor boundary at exactly 4.
    await seedPrereq('p1', 'F');
    await setMastered('p1');
    await setMastered('F');
    const frontier = await learnableFrontier(testDb());
    expect(frontier).toEqual([]);
  });

  it('(o) evidence-arm isolation (kg-borrow 前瞻) — a prereq with evidence_count=0 never satisfies a dependent, even at synthetic high p(L)', async () => {
    // 前瞻锚定（YUK-551 spec Q4；register 单元 kg-borrowing-prereq-propagation-sprawl,
    // state.ts 借值分支硬编码 evidence_count:0,两 flag 今 dark）。本测经完整 gate
    // （learnableFrontierResolved / learnableFrontier）隔离 AND-gate 的 EVIDENCE 臂:
    // evidence_count=0（借值分支会携带的值）即便 p(L) 合成到很高（σ(2.0)=0.88）也永不过
    // floor（4）→ 其 dependent 被 gate out。注意这是**合成**形状,非 borrow 投影复现——真实
    // borrow 是 in-memory、flag-dark、且 point=σ(−β) 通常 ≤0.5（见 helper docblock）;真 borrow
    // 特性化（经 applyKgSoftLayer）defer 到 register #6。与既有 (l)（evidence=3 近孪生,prereq
    // 角色）、(m)（self 角色）、(n)（边界=4）互补。归属:test 归本单元(gate 防御性质属 gate 测试
    // 面);借值分支自身正确性 = kg-borrowing 单元 remediation。
    await seedPrereq('p1', 'F'); // p1 is F's only prerequisite.
    await setSyntheticHighPlZeroEvidence('p1'); // synthetic: p(L)=0.88 but evidence_count=0.
    await setNotMastered('F');
    // F's only prereq p1 clears p(L) 0.7 but NOT the evidence floor → NOT mastered-enough →
    // F gated OUT (distinct from (l)'s evidence=3 shape; this is the evidence_count=0 shape).
    expect(await learnableFrontier(testDb())).toEqual([]);
  });

  // ── YUK-551 (spec Q1) — overflow single-point emit observability ────────────────
  // The overflow fail-safe (depth/node-cap → blank frontier) now emits ONE console.warn in
  // learnableFrontierResolved, so all three consumers (composer / FrontierRail / nightly)
  // inherit it. Pin: overflow fires exactly once with the fail-safe payload; sparse + dense
  // stay SILENT (negative assertions guard against emitting on the wrong branch). Spy is the
  // describe-level warnSpy (beforeEach/afterEach above).

  it('(p) overflow → single console.warn carrying the fail-safe payload', async () => {
    // Reuse the (d)/(j)/(k) overflow shape: a linear chain deeper than FRONTIER_DEPTH_LIMIT.
    await seedChain('ow', FRONTIER_DEPTH_LIMIT + 4);
    const res = await learnableFrontierResolved(testDb());
    expect(res.kind).toBe('overflow');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[frontier] closure overflow'),
      expect.objectContaining({
        depthOverflow: true,
        depthLimit: FRONTIER_DEPTH_LIMIT,
        nodeCap: FRONTIER_NODE_CAP,
        rows: expect.any(Number),
      }),
    );
  });

  it('(s) node-cap overflow → console.warn payload flags nodeOverflow, NOT depthOverflow (CR1, PR #697)', async () => {
    // (p) only exercises the DEPTH arm (a deep chain trips depthOverflow before the node cap
    // can ever fill). Isolate the NODE-CAP arm with a depth-1 complete bipartite graph whose
    // pair count exceeds FRONTIER_NODE_CAP while every depth stays 1 < FRONTIER_DEPTH_LIMIT.
    // Sizes derived from the constant so the test tracks a retuned cap.
    const dependents = 100;
    const prereqs = Math.floor(FRONTIER_NODE_CAP / dependents) + 1; // 101 → 10,100 pairs > cap
    await seedBipartite(prereqs, dependents);
    const res = await learnableFrontierResolved(testDb());
    expect(res.kind).toBe('overflow');
    expect(res.ids).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[frontier] closure overflow'),
      expect.objectContaining({
        nodeOverflow: true,
        depthOverflow: false, // 区分度:确证走的是 node-cap 臂,不是 depth 臂。
        nodeCap: FRONTIER_NODE_CAP,
        // The SQL fetch is LIMIT nodeCap+1 (the one-past-cap probe), so the reported rowcount
        // is exactly nodeCap+1 — pinning the probe design, not just "some big number".
        rows: FRONTIER_NODE_CAP + 1,
      }),
    );
  });

  it('(q) sparse (no prereq edges) → NO console.warn (not the overflow branch)', async () => {
    await seedKc('sw1');
    await setNotMastered('sw1');
    const res = await learnableFrontierResolved(testDb());
    expect(res.kind).toBe('sparse');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('(r) dense (a real mastered-prereq closure) → NO console.warn', async () => {
    await seedPrereq('dwp', 'dwF');
    await setMastered('dwp');
    await setNotMastered('dwF');
    const res = await learnableFrontierResolved(testDb());
    expect(res.kind).toBe('dense');
    expect(res.ids).toEqual(['dwF']);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
