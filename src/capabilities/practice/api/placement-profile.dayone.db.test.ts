// GET /api/placement/profile — YUK-513 #123 / inc-E day-one prior surface (dark-ship).
//
// Two contracts: (1) flag OFF ⇒ NO `day_one_prior` key on any KC — byte-identical to today
// (the regression anchor); (2) flag ON + native binding present ⇒ each KC carries its
// propagated day-one prior, downstream KCs naming their weakest prerequisite. The binding is
// dev/CI-only, so (2) skips when the .node is absent; (1) always runs.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId } from '@/core/ids';
import { goal, knowledge, knowledge_edge } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

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

import { GET } from './placement-profile';

const db = testDb();

/** Narrow away null/undefined without a non-null assertion (biome noNonNullAssertion). */
function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('expected a value, got null/undefined');
  return v;
}

const NODE_PATH = resolve('crates/calibration-native/calibration-native.node');
const present = existsSync(NODE_PATH);

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

function req(goalId: string): Request {
  return new Request(`http://t/api/placement/profile?goal=${encodeURIComponent(goalId)}`);
}

interface ProfileResp {
  kcs: Array<{ id: string; day_one_prior?: { mean_mastery: number; weakest_prereq_id?: string } }>;
}

async function getProfile(goalId: string): Promise<ProfileResp> {
  const res = await GET(req(goalId));
  expect(res.status).toBe(200);
  return (await res.json()) as ProfileResp;
}

describe('GET /api/placement/profile — day_one_prior dark field', () => {
  it('flag OFF: no KC carries day_one_prior (byte-identical-off anchor)', async () => {
    flag.value = false;
    await seedKc('A');
    await seedKc('B');
    await seedEdge('A', 'B');
    await seedGoal('g1', ['A', 'B']);
    const body = await getProfile('g1');
    expect(body.kcs).toHaveLength(2);
    for (const kc of body.kcs) {
      expect(kc).not.toHaveProperty('day_one_prior');
    }
  });

  (present ? it : it.skip)(
    'flag ON: each KC carries its day-one prior; the dependent names its weakest prereq',
    async () => {
      flag.value = true;
      await seedKc('A');
      await seedKc('B');
      await seedEdge('A', 'B'); // A prereq B
      await seedGoal('g1', ['A', 'B']);
      const body = await getProfile('g1');
      const ap = must(must(body.kcs.find((k) => k.id === 'A')).day_one_prior);
      const bp = must(must(body.kcs.find((k) => k.id === 'B')).day_one_prior);
      expect(ap.weakest_prereq_id).toBeUndefined();
      expect(bp.weakest_prereq_id).toBe('A');
      expect(bp.mean_mastery).toBeLessThan(ap.mean_mastery);
    },
  );
});
