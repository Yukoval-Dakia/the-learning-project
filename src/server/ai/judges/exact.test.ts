import { describe, expect, it } from 'vitest';
import { judgeExact } from './exact';

describe('judgeExact', () => {
  it('returns correct verdict on exact match', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '宾语前置' });
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('returns incorrect on mismatch', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '主谓倒装' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('trims whitespace before comparing', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '  宾语前置  ' });
    expect(r.verdict).toBe('correct');
  });

  it('case-insensitive for ASCII text', () => {
    const r = judgeExact({ reference: 'Yes' }, { content: 'yes' });
    expect(r.verdict).toBe('correct');
  });
});

describe('judgeExact — choice-aware judging (YUK-260)', () => {
  const choices = ['宾语前置', '主谓倒装', '定语后置', '状语后置'];

  it('① letter answer vs option-text reference → correct', () => {
    const r = judgeExact({ reference: '宾语前置', choices_md: choices }, { content: 'A' });
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('② option-text answer vs letter reference → correct', () => {
    const r = judgeExact({ reference: 'A', choices_md: choices }, { content: '宾语前置' });
    expect(r.verdict).toBe('correct');
  });

  it('③ multi-select BC matches B、C / CB / full-width comma', () => {
    const cs = ['甲', '乙', '丙', '丁'];
    expect(judgeExact({ reference: 'BC', choices_md: cs }, { content: 'B、C' }).verdict).toBe(
      'correct',
    );
    expect(judgeExact({ reference: 'BC', choices_md: cs }, { content: 'CB' }).verdict).toBe(
      'correct',
    );
    expect(judgeExact({ reference: 'BC', choices_md: cs }, { content: 'B，C' }).verdict).toBe(
      'correct',
    );
  });

  it('④ wrong letter D vs A → incorrect', () => {
    const r = judgeExact({ reference: 'A', choices_md: choices }, { content: 'D' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('⑤ out-of-range letter (E with 4 options) falls back to text → incorrect', () => {
    const r = judgeExact({ reference: 'A', choices_md: choices }, { content: 'E' });
    expect(r.verdict).toBe('incorrect');
  });

  it('⑥ no choices_md → plain text equality (no regression)', () => {
    expect(judgeExact({ reference: '宾语前置' }, { content: 'A' }).verdict).toBe('incorrect');
    expect(judgeExact({ reference: '宾语前置' }, { content: '宾语前置' }).verdict).toBe('correct');
  });

  it('⑦ NFKC: full-width letter Ａ resolves to index 0', () => {
    const r = judgeExact(
      { reference: '宾语前置', choices_md: ['宾语前置', '主谓倒装'] },
      { content: 'Ａ' },
    );
    expect(r.verdict).toBe('correct');
  });

  it('⑧ empty answer string → no match, no crash', () => {
    const r = judgeExact({ reference: 'A', choices_md: ['宾语前置', '主谓倒装'] }, { content: '' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });
});

describe('judgeExact — bot-review hardening parity (YUK-260)', () => {
  // C1: option text is pure Latin letters — letter-string parse must not shadow
  // the option-text equality. Mirrors the V2 capability judge.
  it('C1 True/False options: letter answer "A" matches reference "True"', () => {
    const choices_md = ['True', 'False'];
    expect(judgeExact({ reference: 'True', choices_md }, { content: 'A' }).verdict).toBe('correct');
    expect(judgeExact({ reference: 'True', choices_md }, { content: 'B' }).verdict).toBe(
      'incorrect',
    );
    expect(judgeExact({ reference: 'A', choices_md }, { content: 'True' }).verdict).toBe('correct');
    expect(judgeExact({ reference: 'True', choices_md }, { content: 'E' }).verdict).toBe(
      'incorrect',
    );
  });

  // C2: reading-comprehension reference_md is "正确项字母 + 依据" ("C。…"); choices
  // may carry a label prefix ("A. …"). A bare-letter answer must match.
  it('C2 reading-comprehension: answer "C" matches reference "C。原文依据…"', () => {
    const choices_md = [
      'A. 修八尺有余　　修：长，这里指身高',
      'B. 朝服衣冠　　　服：穿戴',
      'C. 窥镜　　　　　窥：偷看',
      'D. 忌不自信　　　信：相信',
    ];
    const reference = 'C。「窥镜」的「窥」此处是「照（镜子）」之意，并非「偷看」。';
    expect(judgeExact({ reference, choices_md }, { content: 'C' }).verdict).toBe('correct');
    expect(judgeExact({ reference, choices_md }, { content: 'A' }).verdict).toBe('incorrect');
    expect(
      judgeExact({ reference, choices_md }, { content: 'C. 窥镜　　　　　窥：偷看' }).verdict,
    ).toBe('correct');
  });

  // C3: DB / JudgeQuestionRow shape forwards choices_md: null for non-choice
  // questions. Must normalise to plain text equality, not crash.
  it('C3 choices_md: null → plain text equality', () => {
    expect(
      judgeExact({ reference: '宾语前置', choices_md: null }, { content: '宾语前置' }).verdict,
    ).toBe('correct');
    expect(
      judgeExact({ reference: '宾语前置', choices_md: null }, { content: '主谓倒装' }).verdict,
    ).toBe('incorrect');
    expect(judgeExact({ reference: '宾语前置', choices_md: null }, { content: 'A' }).verdict).toBe(
      'incorrect',
    );
  });

  // OCR-1 parity: evidence records match_type + resolved indices.
  it('evidence_json carries match_type + resolved choice indices', () => {
    const choices_md = ['宾语前置', '主谓倒装', '定语后置', '状语后置'];
    const r = judgeExact({ reference: '宾语前置', choices_md }, { content: 'A' });
    expect(r.evidence_json.match_type).toBe('choice_index');
    expect(r.evidence_json.answer_choice_indices).toEqual([0]);
    expect(r.evidence_json.reference_choice_indices).toEqual([0]);
    const plain = judgeExact({ reference: '宾语前置' }, { content: '宾语前置' });
    expect(plain.evidence_json.match_type).toBe('text');
  });
});
