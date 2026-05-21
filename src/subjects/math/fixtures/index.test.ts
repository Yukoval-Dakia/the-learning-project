import { describe, expect, it } from 'vitest';
import { loadMathFixtures } from './index';

describe('math fixtures', () => {
  it('loads 10 valid items', () => {
    const items = loadMathFixtures();
    expect(items).toHaveLength(10);
  });

  it('has 5 single_choice + 5 fill_blank', () => {
    const items = loadMathFixtures();
    const byKind = items.reduce<Record<string, number>>((acc, it) => {
      acc[it.kind] = (acc[it.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind.single_choice).toBe(5);
    expect(byKind.fill_blank).toBe(5);
  });

  it('every choice item has 2-6 choices and reference is one of them', () => {
    const items = loadMathFixtures();
    const choiceItems = items.filter((i) => i.kind === 'single_choice');
    for (const it of choiceItems) {
      expect(it.choices_md).toBeDefined();
      const choices = it.choices_md ?? [];
      expect(choices.length).toBeGreaterThanOrEqual(2);
      expect(choices.length).toBeLessThanOrEqual(6);
      expect(choices).toContain(it.reference_md);
    }
  });

  it('every fill_blank item has at least one keyword in its rubric', () => {
    const items = loadMathFixtures();
    const fillItems = items.filter((i) => i.kind === 'fill_blank');
    for (const it of fillItems) {
      expect(it.rubric_json?.keywords).toBeDefined();
      const keywords = it.rubric_json?.keywords ?? [];
      expect(keywords.length).toBeGreaterThan(0);
    }
  });

  it('refs are unique', () => {
    const items = loadMathFixtures();
    const refs = items.map((i) => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
