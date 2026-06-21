// GET /api/placement/profile DB test — cold-start inc-B profile read (YUK-473 Slice 4).
//
// Drives the profile read over a seeded goal scope + mastery_state rows: per-KC projection
// (getMasteryProjection SoT), tested-first ordering, untested in-scope KCs surfacing as
// tested:false, scope-less / unknown-goal / missing-param edges.

import { newId } from '@/core/ids';
import { goal, knowledge, mastery_state } from '@/db/schema';
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
    expect(body.answeredCount).toBe(0);
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

    // answeredCount = summed evidence across tested KCs.
    expect(body.answeredCount).toBe(3);
  });
});
