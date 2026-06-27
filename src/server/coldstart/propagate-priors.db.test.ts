// YUK-513 Phase 2 (#123 / inc-E) — loadDayOnePriors DB test.
//
// Covers the dark-ship contract (flag-off / empty / binding-absent → null NO-OP) without the
// binding, and — when the OPT-IN .node is built (`pnpm build:native`; skipped otherwise) —
// the propagated-prior topology through the real Rust kernel: roots at the uniform 0.5 prior,
// downstream KCs sitting strictly lower, depth compounding, and weakest-prereq attribution.
//
// The flag lives in @/core/theta-grid (consumed across a module boundary), so we toggle it
// with the same getter-mock the THETA_GRID_ENABLED suites use (candidate-signals.db.test.ts).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId } from '@/core/ids';
import { knowledge, knowledge_edge } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

// Toggle PREREQ_PROPAGATION_ENABLED at call time; ...actual keeps GRID_THETA etc. real.
const flag = { value: false };
vi.mock('@/core/theta-grid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/theta-grid')>();
  return {
    ...actual,
    get PREREQ_PROPAGATION_ENABLED() {
      return flag.value;
    },
  };
});

import { type DayOnePrior, loadDayOnePriors } from './propagate-priors';

const db = testDb();

/** Narrow away null/undefined without a non-null assertion (biome noNonNullAssertion). */
function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('expected a value, got null/undefined');
  return v;
}
function priorOf(priors: Map<string, DayOnePrior> | null, id: string): DayOnePrior {
  return must(must(priors).get(id));
}

// The native binding is dev/CI-only; when absent the kernel-driven assertions skip (the
// flag-off / empty NO-OP cases still run, since they return before touching the binding).
const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
const present = existsSync(NODE_PATH);
const dWithBinding = present ? describe : describe.skip;

beforeEach(() => {
  flag.value = false;
  return resetDb();
});

async function seedKc(id: string): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'wenyan',
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

/** from = prerequisite, to = dependent (topology-gate learning-order convention). */
async function seedEdge(from: string, to: string): Promise<void> {
  await db.insert(knowledge_edge).values({
    id: newId(),
    from_knowledge_id: from,
    to_knowledge_id: to,
    relation_type: 'prerequisite',
    created_by: { by: 'system' },
    created_at: new Date(),
  });
}

describe('loadDayOnePriors — dark-ship NO-OP contract', () => {
  it('flag OFF: returns null even with a seeded prereq DAG (no DB read, byte-identical-off)', async () => {
    flag.value = false;
    await seedKc('A');
    await seedKc('B');
    await seedEdge('A', 'B');
    expect(await loadDayOnePriors(db, ['A', 'B'])).toBeNull();
  });

  it('flag ON, empty scope: returns null', async () => {
    flag.value = true;
    expect(await loadDayOnePriors(db, [])).toBeNull();
  });

  it('flag ON, blank-only scope ids: returns null after trim/filter', async () => {
    flag.value = true;
    expect(await loadDayOnePriors(db, ['', '   '])).toBeNull();
  });
});

dWithBinding('loadDayOnePriors — propagated topology (native binding present)', () => {
  it('a root KC sits at the uniform 0.5 prior with no weakest-prereq attribution', async () => {
    flag.value = true;
    await seedKc('A');
    const priors = await loadDayOnePriors(db, ['A']);
    const a = priorOf(priors, 'A');
    expect(a.mean_mastery).toBeCloseTo(0.5, 3);
    expect(a.weakest_prereq_id).toBeUndefined();
    expect(a.weakest_prereq_mastery).toBeUndefined();
  });

  it('a dependent sits strictly lower than its prerequisite + attributes the short-board', async () => {
    flag.value = true;
    await seedKc('A');
    await seedKc('B');
    await seedEdge('A', 'B'); // A prereq B
    const priors = await loadDayOnePriors(db, ['A', 'B']);
    const a = priorOf(priors, 'A');
    const b = priorOf(priors, 'B');
    expect(b.mean_mastery).toBeLessThan(a.mean_mastery);
    expect(b.weakest_prereq_id).toBe('A');
    expect(must(b.weakest_prereq_mastery)).toBeGreaterThan(0);
    expect(must(b.weakest_prereq_mastery)).toBeLessThan(1);
    expect(a.weakest_prereq_id).toBeUndefined();
  });

  it('depth compounds: C < B < A along a chain A→B→C', async () => {
    flag.value = true;
    await seedKc('A');
    await seedKc('B');
    await seedKc('C');
    await seedEdge('A', 'B');
    await seedEdge('B', 'C');
    const priors = await loadDayOnePriors(db, ['A', 'B', 'C']);
    const a = priorOf(priors, 'A');
    const b = priorOf(priors, 'B');
    const c = priorOf(priors, 'C');
    expect(b.mean_mastery).toBeLessThan(a.mean_mastery);
    expect(c.mean_mastery).toBeLessThan(b.mean_mastery);
    expect(c.weakest_prereq_id).toBe('B'); // C's only prereq
  });

  it('conjunction: a KC with two weak prereqs is shrunk below either root', async () => {
    flag.value = true;
    await seedKc('A');
    await seedKc('B');
    await seedKc('C');
    await seedEdge('A', 'C');
    await seedEdge('B', 'C'); // C needs BOTH A and B
    const priors = await loadDayOnePriors(db, ['A', 'B', 'C']);
    const a = priorOf(priors, 'A');
    const c = priorOf(priors, 'C');
    expect(c.mean_mastery).toBeLessThan(a.mean_mastery);
    // both roots tie at 0.5 → argmin breaks to the lowest-index id (scope order A,B,C → A).
    expect(c.weakest_prereq_id).toBe('A');
  });

  it('edges whose endpoints leave scope are ignored (sub-DAG only)', async () => {
    flag.value = true;
    await seedKc('A');
    await seedKc('B');
    await seedEdge('A', 'B');
    // Query only B: the A→B edge has an out-of-scope endpoint (A) → B is treated as a root.
    const priors = await loadDayOnePriors(db, ['B']);
    const b = priorOf(priors, 'B');
    expect(b.mean_mastery).toBeCloseTo(0.5, 3);
    expect(b.weakest_prereq_id).toBeUndefined();
  });

  it('flag ON: a cyclic prereq graph degrades to NO-OP — kernel rejection caught + logged, never thrown', async () => {
    flag.value = true;
    await seedKc('A');
    await seedKc('B');
    await seedEdge('A', 'B');
    await seedEdge('B', 'A'); // 2-cycle: the kernel rejects (prerequisites must be a DAG)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Must RESOLVE to null (caught), not reject — the live read must never break. And the
    // degradation must be LOGGED (observable), not a silent swallow.
    await expect(loadDayOnePriors(db, ['A', 'B'])).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
