// GET /api/placement/profile DB test — cold-start inc-B profile read (YUK-473 Slice 4).
//
// Drives the profile read over a seeded goal scope + mastery_state rows: per-KC projection
// (getMasteryProjection SoT), tested-first ordering, untested in-scope KCs surfacing as
// tested:false, scope-less / unknown-goal / missing-param edges.

import { newId } from '@/core/ids';
import { goal, knowledge, mastery_state } from '@/db/schema';
import { upsertLearnerAxisState } from '@/server/calibration/axis-writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

import { GET } from './placement-profile';

const db = testDb();

beforeEach(() => resetDb());

async function seedKnowledge(id: string, name: string): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name,
    domain: 'wenyan',
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedGoal(id: string, scope: string[]): Promise<void> {
  const now = new Date();
  await db.insert(goal).values({
    id,
    title: 'G',
    subject_id: null,
    scope_knowledge_ids: scope,
    sequence_hint: 0,
    status: 'active',
    source: 'manual',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedMastery(
  kcId: string,
  opts: {
    evidence_count: number;
    success_count: number;
    fail_count: number;
    theta_precision: number;
  },
): Promise<void> {
  await db.insert(mastery_state).values({
    id: newId(),
    subject_kind: 'knowledge',
    subject_id: kcId,
    theta_hat: 0.6,
    evidence_count: opts.evidence_count,
    success_count: opts.success_count,
    fail_count: opts.fail_count,
    theta_precision: opts.theta_precision,
    updated_at: new Date(),
  });
}

function req(goalId?: string): Request {
  const url =
    goalId === undefined
      ? 'http://t/api/placement/profile'
      : `http://t/api/placement/profile?goal=${encodeURIComponent(goalId)}`;
  return new Request(url);
}

describe('GET /api/placement/profile', () => {
  it('400s when the goal param is missing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
  });

  it('404s on an unknown goal', async () => {
    const res = await GET(req('nope'));
    expect(res.status).toBe(404);
  });

  it('returns empty kcs for a scope-less (cold north-star) goal', async () => {
    await seedGoal('g1', []);
    const res = await GET(req('g1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kcs).toEqual([]);
    expect(body.evidenceCount).toBe(0);
    expect(body.testedCount).toBe(0);
    expect(body.totalKcs).toBe(0);
  });

  it('projects per-KC mastery; tested first, untested in-scope KCs surface as tested:false', async () => {
    await seedKnowledge('kc1', '虚词·之');
    await seedKnowledge('kc2', '使动用法'); // in scope, never attempted → untested
    await seedGoal('g1', ['kc1', 'kc2']);
    await seedMastery('kc1', {
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      theta_precision: 2.1,
    });

    const res = await GET(req('g1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kcs).toHaveLength(2);

    // tested KC leads (it has evidence); projection fields present + named.
    const k1 = body.kcs[0];
    expect(k1.id).toBe('kc1');
    expect(k1.name).toBe('虚词·之');
    expect(k1.tested).toBe(true);
    expect(k1.evidence_count).toBe(3);
    expect(typeof k1.p_l).toBe('number');
    expect(typeof k1.mastery_lo).toBe('number');
    expect(typeof k1.mastery_hi).toBe('number');
    expect(typeof k1.theta_se).toBe('number');

    // untested in-scope KC surfaces (no mastery_state row) → tested:false, no projection.
    const k2 = body.kcs[1];
    expect(k2.id).toBe('kc2');
    expect(k2.tested).toBe(false);
    expect(k2.evidence_count).toBe(0);
    expect(k2.p_l).toBeUndefined();

    // evidenceCount = summed evidence across tested KCs (coverage signal, not distinct Qs).
    expect(body.evidenceCount).toBe(3);
    // testedCount = KCs with a mastery_state row (kc1); totalKcs = full in-scope set (kc1+kc2).
    expect(body.testedCount).toBe(1);
    expect(body.totalKcs).toBe(2);
  });

  // YUK-445 (A11) — the EZ-diffusion axis descriptor is the read-out surface: when the nightly
  // batch has written a learner_axis_state row for an in-scope KC, the profile read attaches it
  // (independent of mastery — present on both tested and untested KCs).
  it('surfaces the A11 axis descriptor for scope KCs that have a learner_axis_state row', async () => {
    await seedKnowledge('kc1', '虚词·之'); // will be tested (mastery row)
    await seedKnowledge('kc2', '使动用法'); // untested, but has an axis row
    await seedGoal('g1', ['kc1', 'kc2']);
    await seedMastery('kc1', {
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      theta_precision: 2.1,
    });
    // adaptive provenance: boundary_a + ter present, drift_v NULL (A11 hard boundary).
    await upsertLearnerAxisState(db, {
      subjectId: 'kc1',
      driftV: null,
      boundaryA: 0.13,
      ter: 0.29,
      nObs: 42,
      provenance: 'adaptive',
    });
    // an UNTESTED KC can still carry an axis descriptor.
    await upsertLearnerAxisState(db, {
      subjectId: 'kc2',
      driftV: 0.21,
      boundaryA: 0.1,
      ter: 0.31,
      nObs: 55,
      provenance: 'probe',
    });

    const res = await GET(req('g1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = Object.fromEntries(body.kcs.map((k: { id: string }) => [k.id, k]));

    expect(byId.kc1.axis).toEqual({
      drift_v: null,
      boundary_a: 0.13,
      ter: 0.29,
      n_obs: 42,
      provenance: 'adaptive',
    });
    expect(byId.kc1.tested).toBe(true);

    expect(byId.kc2.tested).toBe(false);
    expect(byId.kc2.axis).toEqual({
      drift_v: 0.21,
      boundary_a: 0.1,
      ter: 0.31,
      n_obs: 55,
      provenance: 'probe',
    });
  });

  it('omits the axis field for scope KCs with no learner_axis_state row', async () => {
    await seedKnowledge('kc1', '虚词·之');
    await seedGoal('g1', ['kc1']);
    await seedMastery('kc1', {
      evidence_count: 3,
      success_count: 2,
      fail_count: 1,
      theta_precision: 2.1,
    });
    const res = await GET(req('g1'));
    const body = await res.json();
    expect(body.kcs[0].axis).toBeUndefined();
  });
});
