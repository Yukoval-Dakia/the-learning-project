import { describe, expect, it } from 'vitest';
import { loadMathDerivationImageFixtures } from './derivation-with-images';

describe('math derivation-with-images fixtures', () => {
  it('loads 5 items', () => {
    expect(loadMathDerivationImageFixtures()).toHaveLength(5);
  });

  it('every item has non-empty image_refs prefixed with placeholder-', () => {
    for (const item of loadMathDerivationImageFixtures()) {
      expect(item.image_refs.length).toBeGreaterThan(0);
      expect(item.image_refs[0]).toMatch(/^placeholder-/);
    }
  });

  it('every item has reference_solution with all 3 fields populated', () => {
    for (const item of loadMathDerivationImageFixtures()) {
      const rs = item.rubric_json.reference_solution;
      expect(rs.expected_signals.length).toBeGreaterThan(0);
      expect(rs.final_answer.length).toBeGreaterThan(0);
      expect(rs.answer_equivalents.length).toBeGreaterThan(0);
    }
  });
});
