import { describe, expect, it } from 'vitest';
import fixtureData from './data.json' with { type: 'json' };
import { WenyanFixtureFileSchema, WenyanFixtureItemSchema, loadWenyanFixtures } from './index';

/**
 * P5.8 (YUK-182) — wenyan fixture structure validation (unit partition).
 * Mirrors physics/fixtures/schema.test.ts: parse, count, per-kind counts via
 * ref-prefix filters, ref uniqueness, plus the F-3 preconditions the e2e
 * semantic stub relies on (single_choice has choices_md; semantic items carry
 * rubric_json.required_points; the keyword fill_blank carries rubric.keywords).
 */
describe('wenyan fixtures', () => {
  it('data.json conforms to WenyanFixtureFileSchema', () => {
    expect(() => WenyanFixtureFileSchema.parse(fixtureData)).not.toThrow();
  });

  it('loadWenyanFixtures returns 10-12 items', () => {
    const items = loadWenyanFixtures();
    expect(items.length).toBeGreaterThanOrEqual(10);
    expect(items.length).toBeLessThanOrEqual(12);
  });

  it('per-kind counts: >=5 single_choice + >=3 translation + >=2 reading_comprehension + 1 fill_blank', () => {
    const items = loadWenyanFixtures();
    const byKind = items.reduce<Record<string, number>>((acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind.single_choice).toBeGreaterThanOrEqual(5);
    expect(byKind.translation).toBeGreaterThanOrEqual(3);
    expect(byKind.reading_comprehension).toBeGreaterThanOrEqual(2);
    expect(byKind.fill_blank ?? 0).toBe(1);
  });

  it('ref prefixes match kind (wenyan-choice-/wenyan-trans-/wenyan-read-/wenyan-short-)', () => {
    const items = loadWenyanFixtures();
    const choiceCount = items.filter((i) => i.ref.startsWith('wenyan-choice-')).length;
    const transCount = items.filter((i) => i.ref.startsWith('wenyan-trans-')).length;
    const readCount = items.filter((i) => i.ref.startsWith('wenyan-read-')).length;
    const shortCount = items.filter((i) => i.ref.startsWith('wenyan-short-')).length;
    expect(choiceCount).toBeGreaterThanOrEqual(5);
    expect(transCount).toBeGreaterThanOrEqual(3);
    expect(readCount).toBeGreaterThanOrEqual(2);
    expect(shortCount).toBe(1);
    for (const item of items) {
      if (item.ref.startsWith('wenyan-choice-')) expect(item.kind).toBe('single_choice');
      if (item.ref.startsWith('wenyan-trans-')) expect(item.kind).toBe('translation');
      if (item.ref.startsWith('wenyan-read-')) expect(item.kind).toBe('reading_comprehension');
      if (item.ref.startsWith('wenyan-short-')) expect(item.kind).toBe('fill_blank');
    }
  });

  it('every single_choice item has 2-6 choices and reference is one of them', () => {
    const items = loadWenyanFixtures();
    const choiceItems = items.filter((i) => i.kind === 'single_choice');
    for (const it of choiceItems) {
      expect(it.choices_md).toBeDefined();
      const choices = it.choices_md ?? [];
      expect(choices.length).toBeGreaterThanOrEqual(2);
      expect(choices.length).toBeLessThanOrEqual(6);
      expect(choices).toContain(it.reference_md);
    }
  });

  it('every semantic item (translation/reading_comprehension) has rubric_json.required_points', () => {
    const items = loadWenyanFixtures();
    const semanticItems = items.filter(
      (i) => i.kind === 'translation' || i.kind === 'reading_comprehension',
    );
    for (const it of semanticItems) {
      const required = it.rubric_json?.required_points ?? [];
      expect(required.length).toBeGreaterThan(0);
    }
  });

  it('every fill_blank item has at least one keyword in its rubric (keyword route)', () => {
    const items = loadWenyanFixtures();
    const fillItems = items.filter((i) => i.kind === 'fill_blank');
    expect(fillItems.length).toBe(1);
    for (const it of fillItems) {
      const keywords = it.rubric_json?.keywords ?? [];
      expect(keywords.length).toBeGreaterThan(0);
    }
  });

  it('knowledge_hint is a curriculum.json seed name', () => {
    const items = loadWenyanFixtures();
    const seedNames = new Set(['实词', '虚词', '句式', '断句', '翻译', '文学常识', '论述题']);
    for (const it of items) {
      expect(seedNames).toContain(it.knowledge_hint);
    }
  });

  it('refs are globally unique', () => {
    const items = loadWenyanFixtures();
    const refs = items.map((i) => i.ref);
    expect(new Set(refs).size).toBe(refs.length);
  });

  // PR #228 review (CodeRabbit, Major): the kind→field invariants now live in the
  // schema (superRefine), so prove the guard actually rejects malformed items —
  // not just that the shipped data.json happens to satisfy them.
  describe('schema superRefine rejects kind/field mismatches', () => {
    it('single_choice without choices_md fails', () => {
      const r = WenyanFixtureItemSchema.safeParse({
        ref: 'x',
        kind: 'single_choice',
        prompt_md: 'p',
        reference_md: 'a',
        difficulty: 1,
        knowledge_hint: '实词',
      });
      expect(r.success).toBe(false);
    });

    it('translation without rubric_json.required_points fails', () => {
      const r = WenyanFixtureItemSchema.safeParse({
        ref: 'x',
        kind: 'translation',
        prompt_md: 'p',
        reference_md: 'a',
        rubric_json: { criteria: [] },
        difficulty: 1,
        knowledge_hint: '翻译',
      });
      expect(r.success).toBe(false);
    });

    it('fill_blank without rubric_json.keywords fails', () => {
      const r = WenyanFixtureItemSchema.safeParse({
        ref: 'x',
        kind: 'fill_blank',
        prompt_md: 'p',
        reference_md: 'a',
        rubric_json: { criteria: [] },
        difficulty: 1,
        knowledge_hint: '虚词',
      });
      expect(r.success).toBe(false);
    });
  });
});
