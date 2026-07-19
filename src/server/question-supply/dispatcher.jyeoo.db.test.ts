// YUK-697 — dispatcher jyeoo_fetch routing (real Postgres for the observability event).
//
// Proves the kill-switch semantics end-to-end: a jyeoo-supported (math) tier-2 target
// ranks jyeoo_fetch ahead of sourcing_web (route-planner), and the dispatcher's
// chooseAutoRoute either dispatches it to the jyeoo_fetch queue (flag ON) or skips it and
// falls back to the sourcing queue (flag OFF) — the P4 "kill switch 回退 sourcing_web".

import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { dispatchSupplyTarget } from '@/server/question-supply/dispatcher';
import type { EnqueueFn } from '@/server/question-supply/dispatcher';
import type { QuestionSupplyTarget } from '@/server/question-supply/target-discovery';
import { resetDb } from '../../../tests/helpers/db';

function mathTarget(overrides: Partial<QuestionSupplyTarget> = {}): QuestionSupplyTarget {
  return {
    id: createId(),
    fingerprint: `fp-${createId()}`,
    gapKind: 'frontier_zero',
    subjectId: 'math',
    knowledgeIds: [createId()],
    kind: 'any',
    difficultyBand: 'near',
    desiredCount: 3,
    minSourceTier: 2,
    routePreference: [],
    priority: 1,
    reason: 'r',
    constraints: {},
    ...overrides,
  };
}

function capture(): {
  fn: EnqueueFn;
  calls: Array<{ queue: string; data: Record<string, unknown> }>;
} {
  const calls: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const fn: EnqueueFn = async (queue, data) => {
    calls.push({ queue, data });
    return `job-${calls.length}`;
  };
  return { fn, calls };
}

describe('dispatchSupplyTarget — jyeoo_fetch routing', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('flag ON: math tier-2 target dispatches to the jyeoo_fetch queue with the difficulty band', async () => {
    const enqueue = capture();
    const target = mathTarget({ difficultyBand: 'above' });
    const result = await dispatchSupplyTarget(db, target, {
      enqueue: enqueue.fn,
      tavilyAvailable: () => true,
      jyeooFetchAvailable: () => true,
    });

    expect(result.status).toBe('dispatched');
    expect(result.chosenRoute).toBe('jyeoo_fetch');
    expect(result.routePlan[0]).toBe('jyeoo_fetch');
    expect(enqueue.calls).toHaveLength(1);
    expect(enqueue.calls[0]?.queue).toBe('jyeoo_fetch');
    expect(enqueue.calls[0]?.data).toMatchObject({
      trigger: 'knowledge',
      knowledge_id: target.knowledgeIds[0],
      difficulty_band: 'above',
    });
  });

  it('flag OFF (kill switch): jyeoo_fetch is skipped, falls back to the sourcing queue', async () => {
    const enqueue = capture();
    const result = await dispatchSupplyTarget(db, mathTarget(), {
      enqueue: enqueue.fn,
      tavilyAvailable: () => true,
      jyeooFetchAvailable: () => false,
    });

    expect(result.status).toBe('dispatched');
    // route plan still records jyeoo_fetch as the preferred head (observability);
    // the dispatched route is the fallback.
    expect(result.routePlan[0]).toBe('jyeoo_fetch');
    expect(result.chosenRoute).toBe('sourcing_web');
    expect(enqueue.calls[0]?.queue).toBe('sourcing');
    // no difficulty_band on the sourcing payload (jyeoo-only field).
    expect(enqueue.calls[0]?.data.difficulty_band).toBeUndefined();
  });
});
