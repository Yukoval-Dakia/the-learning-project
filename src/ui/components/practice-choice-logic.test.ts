// YUK-261 — unit tests for the practice choice selection pure logic.
// No-DB unit partition (no imports of db/postgres/drizzle).

import { describe, expect, it } from 'vitest';
import {
  answerMdToSelection,
  deriveMultiSelect,
  indexToLetter,
  isNormalizedLabel,
  isReferenceChoice,
  keyToIndex,
  letterToIndex,
  parseSelection,
  selectionToAnswerMd,
  serializeSelection,
  toggleChoice,
  toggleMulti,
  toggleSingle,
} from './practice-choice-logic';

describe('index ↔ letter', () => {
  it('maps index to uppercase letter', () => {
    expect(indexToLetter(0)).toBe('A');
    expect(indexToLetter(3)).toBe('D');
  });
  it('maps letter to index, -1 for non A-Z', () => {
    expect(letterToIndex('A')).toBe(0);
    expect(letterToIndex('d')).toBe(3);
    expect(letterToIndex('1')).toBe(-1);
  });
});

describe('parseSelection (letter-string normalization)', () => {
  it('returns [] for empty / nullish', () => {
    expect(parseSelection('', 4)).toEqual([]);
    expect(parseSelection(null, 4)).toEqual([]);
    expect(parseSelection(undefined, 4)).toEqual([]);
  });
  it('parses a single letter', () => {
    expect(parseSelection('A', 4)).toEqual([0]);
  });
  it('parses, dedups, and sorts a multi letter string regardless of input order', () => {
    expect(parseSelection('CB', 4)).toEqual([1, 2]);
    expect(parseSelection('CBB', 4)).toEqual([1, 2]);
  });
  it('tolerates lowercase, full-width, and separators (exact-judge parity)', () => {
    expect(parseSelection('b c', 4)).toEqual([1, 2]);
    expect(parseSelection('B、C', 4)).toEqual([1, 2]);
    expect(parseSelection('Ａ', 4)).toEqual([0]); // full-width A → NFKC → A
  });
  it('drops out-of-range letters', () => {
    expect(parseSelection('AE', 4)).toEqual([0]); // E (index 4) beyond 4 options
  });
});

describe('serializeSelection (canonical letter string)', () => {
  it('empty selection → empty string', () => {
    expect(serializeSelection([])).toBe('');
  });
  it('single index → single letter', () => {
    expect(serializeSelection([0])).toBe('A');
  });
  it('multi indices → ascending dedup letters', () => {
    expect(serializeSelection([2, 1])).toBe('BC');
    expect(serializeSelection([2, 1, 1])).toBe('BC');
  });
});

describe('toggleSingle (single-select: select / switch / deselect)', () => {
  it('selects an option when nothing chosen', () => {
    expect(toggleSingle('', 0, 4)).toBe('A');
  });
  it('switches to a different option (replaces previous)', () => {
    expect(toggleSingle('A', 2, 4)).toBe('C');
  });
  it('deselects when clicking the already-selected option', () => {
    expect(toggleSingle('A', 0, 4)).toBe('');
  });
});

describe('toggleMulti (multi-select: toggle, keep others)', () => {
  it('adds an unselected option', () => {
    expect(toggleMulti('', 0, 4)).toBe('A');
    expect(toggleMulti('A', 2, 4)).toBe('AC');
  });
  it('removes a selected option, keeping the rest', () => {
    expect(toggleMulti('AC', 0, 4)).toBe('C');
  });
  it('result is always ascending normalized', () => {
    expect(toggleMulti('C', 0, 4)).toBe('AC'); // add A in front of C
  });
});

describe('toggleChoice (entry point)', () => {
  it('routes to single when multiSelect=false', () => {
    expect(toggleChoice('A', 1, 4, false)).toBe('B'); // switch, not add
  });
  it('routes to multi when multiSelect=true', () => {
    expect(toggleChoice('A', 1, 4, true)).toBe('AB'); // add
  });
});

describe('selectionToAnswerMd (submit-time letter → option text expansion)', () => {
  const choices = ['苏轼', '苏洵', '苏辙', '欧阳修'];
  it('expands a single letter to its option text (grading fix)', () => {
    expect(selectionToAnswerMd('B', choices)).toBe('苏洵');
    expect(selectionToAnswerMd('A', choices)).toBe('苏轼');
  });
  it('expands multi letters to newline-joined option texts in ascending order', () => {
    expect(selectionToAnswerMd('BC', choices)).toBe('苏洵\n苏辙');
    expect(selectionToAnswerMd('CB', choices)).toBe('苏洵\n苏辙'); // normalized order
  });
  it('empty / unparseable selection → empty string', () => {
    expect(selectionToAnswerMd('', choices)).toBe('');
    expect(selectionToAnswerMd(null, choices)).toBe('');
  });
});

describe('isNormalizedLabel (label vs option-text disambiguation)', () => {
  it('true for pure label strings (after NFKC + separator strip)', () => {
    expect(isNormalizedLabel('A')).toBe(true);
    expect(isNormalizedLabel('BC')).toBe(true);
    expect(isNormalizedLabel('b、c')).toBe(true);
  });
  it('false for CJK option text and Latin-bearing option text', () => {
    expect(isNormalizedLabel('苏洵')).toBe(false);
    expect(isNormalizedLabel('a + b')).toBe(false); // math expression, not a label
    expect(isNormalizedLabel('apple1')).toBe(false); // contains a digit
  });
  it('false for empty / nullish', () => {
    expect(isNormalizedLabel('')).toBe(false);
    expect(isNormalizedLabel(null)).toBe(false);
  });
});

describe('answerMdToSelection (submitted option text → letter string)', () => {
  const choices = ['苏轼', '苏洵', '苏辙', '欧阳修'];
  it('maps single submitted option text back to its letter', () => {
    expect(answerMdToSelection('苏洵', choices)).toBe('B');
  });
  it('maps multi-line submitted option text back to ascending letters', () => {
    expect(answerMdToSelection('苏洵\n苏辙', choices)).toBe('BC');
  });
  it('falls back to label parsing for legacy letter-string answers', () => {
    expect(answerMdToSelection('B', choices)).toBe('B');
  });
  it('returns empty when nothing matches', () => {
    expect(answerMdToSelection('王安石', choices)).toBe('');
    expect(answerMdToSelection('', choices)).toBe('');
  });
});

describe('deriveMultiSelect (no canonical single/multi flag at face level)', () => {
  const choices = ['甲', '乙', '丙', '丁'];
  it('single-select when reference is absent (answering mode)', () => {
    expect(deriveMultiSelect(null, choices)).toBe(false);
  });
  it('single-select for a single-letter / single-text reference', () => {
    expect(deriveMultiSelect('B', choices)).toBe(false);
    expect(deriveMultiSelect('乙', choices)).toBe(false);
  });
  it('multi-select when a label reference resolves to 2+ options', () => {
    expect(deriveMultiSelect('BC', choices)).toBe(true);
  });
});

describe('isReferenceChoice (feedback correctness)', () => {
  const choices = ['宾语前置', '定语后置', '状语后置', '判断句'];
  it('matches via letter-string reference', () => {
    expect(isReferenceChoice('A', 0, choices[0], 4)).toBe(true);
    expect(isReferenceChoice('A', 1, choices[1], 4)).toBe(false);
  });
  it('matches multi-letter reference as a set', () => {
    expect(isReferenceChoice('BC', 1, choices[1], 4)).toBe(true);
    expect(isReferenceChoice('BC', 0, choices[0], 4)).toBe(false);
  });
  it('matches via option-text reference (exact judge stores option text)', () => {
    expect(isReferenceChoice('宾语前置', 0, choices[0], 4)).toBe(true);
    expect(isReferenceChoice('宾语前置', 1, choices[1], 4)).toBe(false);
  });
  it('does NOT mis-parse Latin-bearing option-text references as labels', () => {
    // math/English subjects: reference is option text containing A-Z. Old code
    // ran parseSelection first and the letter branch wrongly won.
    const mathChoices = ['a + b', 'a - b', 'a * b', 'a / b'];
    expect(isReferenceChoice('a + b', 0, mathChoices[0], 4)).toBe(true);
    expect(isReferenceChoice('a + b', 1, mathChoices[1], 4)).toBe(false);
  });
  it('returns false for empty reference', () => {
    expect(isReferenceChoice(null, 0, choices[0], 4)).toBe(false);
    expect(isReferenceChoice('', 0, choices[0], 4)).toBe(false);
  });
});

describe('keyToIndex (scoped keyboard A-D / 1-9)', () => {
  it('maps letters (case-insensitive) within range', () => {
    expect(keyToIndex('a', 4)).toBe(0);
    expect(keyToIndex('D', 4)).toBe(3);
  });
  it('maps digits 1-9 (1 → index 0)', () => {
    expect(keyToIndex('1', 4)).toBe(0);
    expect(keyToIndex('4', 4)).toBe(3);
  });
  it('returns null for out-of-range or irrelevant keys', () => {
    expect(keyToIndex('E', 4)).toBeNull();
    expect(keyToIndex('5', 4)).toBeNull();
    expect(keyToIndex('Enter', 4)).toBeNull();
    expect(keyToIndex(' ', 4)).toBeNull();
  });
});
