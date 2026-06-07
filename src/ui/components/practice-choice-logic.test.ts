// YUK-261 — unit tests for the practice choice selection pure logic.
// No-DB unit partition (no imports of db/postgres/drizzle).

import { describe, expect, it } from 'vitest';
import {
  indexToLetter,
  isReferenceChoice,
  keyToIndex,
  letterToIndex,
  parseSelection,
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
