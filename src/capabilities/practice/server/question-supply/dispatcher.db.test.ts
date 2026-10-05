// YUK-287 — dispatcher 转发回归（真实 Postgres：dispatch 永远 emit 观测事件）。
//
// 覆盖：target.difficultyBand → supply_execute.items[].difficulty_band（曾硬编码 null）·
// target.difficultyBand + constraints.compositeParentOnly → quiz_gen payload
// difficulty_band / composite_parent_only。
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { resetDb } from '../../../../../tests/helpers/db';
import { type EnqueueFn, dispatchSupplyTarget } from './dispatcher';
import type { QuestionSupplyTarget } from './target-discovery';

function makeTarget(overrides: Partial<QuestionSupplyTarget> = {}): QuestionSupplyTarget {
  return {
    id: `target_${createId()}`,
    fingerprint: `fp_${createId()}`,
    gapKind: 'frontier_zero',
    subjectId: 'math',
    knowledgeIds: [createId()],
    kind: 'any',
    difficultyBand: 'above',
    desiredCount: 2,
    minSourceTier: 2,
    routePreference: [],
    priority: 1,
    reason: 'test gap',
    constraints: {},
    ...overrides,
  };
}

describe('dispatchSupplyTarget — YUK-287 difficulty/unit 转发', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('sourcing_web 路由：supply_execute 需求项带上 target.difficultyBand', async () => {
    const captured: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      captured.push({ queue, data });
      return `job-${captured.length}`;
    };

    const target = makeTarget({ difficultyBand: 'above' });
    const result = await dispatchSupplyTarget(db, target, {
      enqueue,
      webSearchAvailable: () => true,
    });

    expect(result.status).toBe('dispatched');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.queue).toBe('supply_execute');
    const items = captured[0]?.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.difficulty_band).toBe('above');
  });

  it('quiz_gen 路由：difficulty_band + composite_parent_only 都进 job payload', async () => {
    const captured: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      captured.push({ queue, data });
      return `job-${captured.length}`;
    };

    const target = makeTarget({
      difficultyBand: 'stretch',
      minSourceTier: 3,
      routePreference: ['quiz_gen'],
      constraints: { compositeParentOnly: true },
    });
    const result = await dispatchSupplyTarget(db, target, {
      enqueue,
      webSearchAvailable: () => false,
    });

    expect(result.status).toBe('dispatched');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.queue).toBe('quiz_gen');
    expect(captured[0]?.data.difficulty_band).toBe('stretch');
    expect(captured[0]?.data.composite_parent_only).toBe(true);
  });

  it('quiz_gen 路由：无 composite 约束时不写 composite_parent_only 字段', async () => {
    const captured: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const enqueue: EnqueueFn = async (queue, data) => {
      captured.push({ queue, data });
      return `job-${captured.length}`;
    };

    const target = makeTarget({
      difficultyBand: 'near',
      minSourceTier: 3,
      routePreference: ['quiz_gen'],
    });
    const result = await dispatchSupplyTarget(db, target, {
      enqueue,
      webSearchAvailable: () => false,
    });

    expect(result.status).toBe('dispatched');
    expect(captured[0]?.queue).toBe('quiz_gen');
    expect(captured[0]?.data.difficulty_band).toBe('near');
    expect('composite_parent_only' in (captured[0]?.data ?? {})).toBe(false);
  });
});
