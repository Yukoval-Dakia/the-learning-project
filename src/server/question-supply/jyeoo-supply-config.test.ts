import { afterEach, describe, expect, it } from 'vitest';
import {
  jyeooDgTokenForBand,
  jyeooFetchEnabled,
  jyeooSupplySubjectFor,
  subjectSupportsJyeooFetch,
} from './jyeoo-supply-config';
import { planSupplyRoutes } from './route-planner';
import type { QuestionSupplyTarget } from './target-discovery';

function target(overrides: Partial<QuestionSupplyTarget> = {}): QuestionSupplyTarget {
  return {
    id: 't',
    fingerprint: 'fp',
    gapKind: 'frontier_zero',
    subjectId: 'math',
    knowledgeIds: ['k1'],
    kind: 'any',
    difficultyBand: 'near',
    desiredCount: 2,
    minSourceTier: 3,
    routePreference: [],
    priority: 1,
    reason: 'r',
    constraints: {},
    ...overrides,
  };
}

describe('jyeoo subject support (profile-declared)', () => {
  it('math declares jyeoo support (subject math2)', () => {
    expect(jyeooSupplySubjectFor('math')).toBe('math2');
    expect(subjectSupportsJyeooFetch('math')).toBe(true);
  });

  it('resolves the math alias to the same jyeoo subject', () => {
    expect(subjectSupportsJyeooFetch('mathematics')).toBe(true);
  });

  it('yuwen / general / unknown have no jyeoo support', () => {
    expect(subjectSupportsJyeooFetch('yuwen')).toBe(false);
    expect(subjectSupportsJyeooFetch('general')).toBe(false);
    expect(subjectSupportsJyeooFetch('nonexistent-subject')).toBe(false);
    expect(jyeooSupplySubjectFor('yuwen')).toBeNull();
  });
});

describe('jyeooDgTokenForBand', () => {
  it('maps loom difficulty bands to jyeoo --dg tokens', () => {
    expect(jyeooDgTokenForBand('below')).toBe('easy');
    expect(jyeooDgTokenForBand('near')).toBe('medium');
    expect(jyeooDgTokenForBand('above')).toBe('hard');
    expect(jyeooDgTokenForBand('stretch')).toBe('difficult');
  });
});

describe('jyeooFetchEnabled (kill switch)', () => {
  const prev = process.env.JYEOO_FETCH_ENABLED;
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    if (prev === undefined) delete process.env.JYEOO_FETCH_ENABLED;
    else process.env.JYEOO_FETCH_ENABLED = prev;
  });

  it('defaults OFF (dark-ship)', () => {
    // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
    delete process.env.JYEOO_FETCH_ENABLED;
    expect(jyeooFetchEnabled()).toBe(false);
  });

  it('accepts both "true" and "1"', () => {
    process.env.JYEOO_FETCH_ENABLED = 'true';
    expect(jyeooFetchEnabled()).toBe(true);
    process.env.JYEOO_FETCH_ENABLED = '1';
    expect(jyeooFetchEnabled()).toBe(true);
  });

  it('any other value is OFF', () => {
    process.env.JYEOO_FETCH_ENABLED = 'yes';
    expect(jyeooFetchEnabled()).toBe(false);
  });
});

// planSupplyRoutes stays PURE (target + static profile) — it does NOT read the kill
// switch (that's the dispatcher's job). So a jyeoo-supported subject always ranks
// jyeoo_fetch ahead of sourcing_web in the tier-2 + objectiveOnly branches.
describe('planSupplyRoutes — jyeoo-supported subject (math)', () => {
  it('minSourceTier<=2 → jyeoo_fetch before sourcing_web', () => {
    expect(planSupplyRoutes(target({ subjectId: 'math', minSourceTier: 2 }))).toEqual([
      'jyeoo_fetch',
      'sourcing_web',
      'ingest_existing',
      'author_question',
    ]);
  });

  it('objectiveOnly (tier 3) → jyeoo_fetch before sourcing_web', () => {
    expect(
      planSupplyRoutes(
        target({ subjectId: 'math', minSourceTier: 3, constraints: { objectiveOnly: true } }),
      ),
    ).toEqual(['jyeoo_fetch', 'sourcing_web', 'author_question']);
  });

  it('needsImage still wins (no jyeoo — image questions are filtered pre-persist)', () => {
    expect(
      planSupplyRoutes(
        target({ subjectId: 'math', minSourceTier: 1, constraints: { needsImage: true } }),
      ),
    ).toEqual(['image_candidate', 'ingest_existing', 'sourcing_web']);
  });

  it('a non-jyeoo subject (yuwen) is unchanged (no jyeoo_fetch)', () => {
    expect(planSupplyRoutes(target({ subjectId: 'yuwen', minSourceTier: 2 }))).toEqual([
      'sourcing_web',
      'ingest_existing',
      'author_question',
    ]);
  });
});
