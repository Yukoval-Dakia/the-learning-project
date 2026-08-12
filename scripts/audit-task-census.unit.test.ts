/**
 * audit-task-census.unit.test.ts — YUK-863 / F3.2
 *
 * Tests the census audit logic and validates it against the live taskCatalog.
 */

import { describe, expect, it } from 'vitest';
import { taskCatalog } from '../src/ai/task-catalog';
import { CLI_ONLY_CALLERS, EXPECTED_CENSUS, auditTaskCensus } from './audit-task-census';

describe('EXPECTED_CENSUS', () => {
  it('has exactly 51 entries', () => {
    expect(EXPECTED_CENSUS).toHaveLength(51);
  });

  it('has no duplicate entries', () => {
    const set = new Set(EXPECTED_CENSUS);
    expect(set.size).toBe(EXPECTED_CENSUS.length);
  });

  it('includes ProfileCriticTask as CLI-only caller', () => {
    expect(CLI_ONLY_CALLERS).toContain('ProfileCriticTask');
    expect(EXPECTED_CENSUS).toContain('ProfileCriticTask');
  });
});

describe('auditTaskCensus', () => {
  it('returns ok=true for the exact 51-entry census', () => {
    const result = auditTaskCensus([...EXPECTED_CENSUS]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.censusCount).toBe(51);
    expect(result.catalogCount).toBe(51);
  });

  it('fails when 50 entries are provided', () => {
    const result = auditTaskCensus([...EXPECTED_CENSUS].slice(1));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('Missing'))).toBe(true);
  });

  it('fails when 52 entries are provided (one duplicate)', () => {
    const result = auditTaskCensus([...EXPECTED_CENSUS, 'UnknownTask']);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('extra') || e.includes('Extra'))).toBe(true);
  });

  it('fails for missing CLI-only caller ProfileCriticTask', () => {
    const withoutCritic = [...EXPECTED_CENSUS].filter((k) => k !== 'ProfileCriticTask');
    const result = auditTaskCensus(withoutCritic);
    expect(result.ok).toBe(false);
    expect(result.missingFromCatalog).toContain('ProfileCriticTask');
  });

  it('fails for unknown kind not in census', () => {
    const withExtra = [...EXPECTED_CENSUS, 'SomeFutureTask'];
    const result = auditTaskCensus(withExtra);
    expect(result.ok).toBe(false);
    expect(result.extraInCatalog).toContain('SomeFutureTask');
  });
});

describe('live taskCatalog census', () => {
  it('passes the 51-entry census check against the live catalog', () => {
    const result = auditTaskCensus(Object.keys(taskCatalog));
    if (!result.ok) {
      console.error('Census audit errors:', result.errors);
    }
    expect(result.ok).toBe(true);
    expect(result.catalogCount).toBe(51);
  });

  it('catalog is frozen (no mutation after compose)', () => {
    expect(Object.isFrozen(taskCatalog)).toBe(true);
  });

  it('every catalog key has a non-empty prompt', () => {
    for (const [kind, def] of Object.entries(taskCatalog)) {
      if (def.prompt.kind === 'inline') {
        expect(def.prompt.text.trim(), `${kind} has empty prompt`).not.toBe('');
      } else {
        expect(typeof def.prompt.build, `${kind} prompt.build not a function`).toBe('function');
      }
    }
  });
});
