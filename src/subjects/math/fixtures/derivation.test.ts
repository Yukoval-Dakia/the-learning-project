import { describe, expect, it } from 'vitest';
import { loadMathDerivationFixtures } from './derivation';

describe('math derivation fixtures', () => {
  it('loads 5 derivation items', () => {
    const items = loadMathDerivationFixtures();
    expect(items).toHaveLength(5);
  });

  it('every item has reference_solution with non-empty expected_signals', () => {
    const items = loadMathDerivationFixtures();
    for (const it of items) {
      expect(it.rubric_json.reference_solution.expected_signals.length).toBeGreaterThan(0);
      expect(it.rubric_json.reference_solution.final_answer.length).toBeGreaterThan(0);
    }
  });

  it('every item has at least one answer_equivalent', () => {
    const items = loadMathDerivationFixtures();
    for (const it of items) {
      expect(it.rubric_json.reference_solution.answer_equivalents.length).toBeGreaterThan(0);
    }
  });
});
