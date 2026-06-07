// YUK-288 题库 UI — meta map unit tests (no DB; src/ui/** fast partition).

import { describe, expect, it } from 'vitest';
import {
  choiceKey,
  difficultyMeta,
  groundingTierMeta,
  kindMeta,
  lineageGlyph,
  sourceMeta,
} from './meta';

describe('kindMeta', () => {
  it('maps canonical QuestionKind values to 中文 + icon', () => {
    expect(kindMeta('choice').label).toBe('单选');
    expect(kindMeta('reading').label).toBe('阅读理解');
    expect(kindMeta('translation').icon).toBe('book');
  });

  it('falls back for unknown kinds (enum grows zero-DDL)', () => {
    expect(kindMeta('some_future_kind')).toEqual({ label: '题目', icon: 'quiz' });
  });
});

describe('sourceMeta', () => {
  it('maps canonical QuestionSource values to label + tone', () => {
    expect(sourceMeta('manual')).toEqual({ label: '手动录入', icon: 'pencil', tone: 'neutral' });
    expect(sourceMeta('quiz_gen').tone).toBe('coral');
    expect(sourceMeta('vision_paper').tone).toBe('info');
  });

  it('falls back for unknown sources', () => {
    expect(sourceMeta('brand_new_source')).toEqual({
      label: '其它来源',
      icon: 'layers',
      tone: 'neutral',
    });
  });
});

describe('difficultyMeta', () => {
  it('maps 1-5 to tone + 中文词', () => {
    expect(difficultyMeta(1)).toEqual({ tone: 'good', word: '易' });
    expect(difficultyMeta(3).tone).toBe('hard');
    expect(difficultyMeta(5)).toEqual({ tone: 'again', word: '难' });
  });

  it('falls back for out-of-range difficulty', () => {
    expect(difficultyMeta(0).word).toBe('中等');
    expect(difficultyMeta(9).tone).toBe('hard');
  });
});

describe('groundingTierMeta', () => {
  it('maps derived tier 1-4 to label + badge tone', () => {
    expect(groundingTierMeta(1)).toEqual({ label: '真题', tone: 'good' });
    expect(groundingTierMeta(4)).toEqual({ label: 'AI 生成', tone: 'coral' });
  });
});

describe('choiceKey', () => {
  it('derives A/B/C/D from a 0-based index', () => {
    expect(choiceKey(0)).toBe('A');
    expect(choiceKey(3)).toBe('D');
    expect(choiceKey(25)).toBe('Z');
  });

  it('wraps past 26 options defensively', () => {
    expect(choiceKey(26)).toBe('A1');
  });
});

describe('lineageGlyph', () => {
  it('marks a part row (parent_question_id set)', () => {
    expect(lineageGlyph({ parent_question_id: 'parent', root_question_id: null })).toEqual({
      glyph: '▫',
      cls: 'is-part',
      title: '小题',
    });
  });

  it('marks a variant (root_question_id set, no parent)', () => {
    expect(lineageGlyph({ parent_question_id: null, root_question_id: 'root' })).toEqual({
      glyph: '◇',
      cls: 'is-variant',
      title: 'AI 变体',
    });
  });

  it('marks a root/母题 (both null)', () => {
    expect(lineageGlyph({ parent_question_id: null, root_question_id: null })).toEqual({
      glyph: '◆',
      cls: '',
      title: '母题',
    });
  });
});
