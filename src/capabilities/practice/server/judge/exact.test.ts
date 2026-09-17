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

describe('judgeExact — parenthesized references + explanation tails (YUK-1003)', () => {
  // Real production shape (web_sourced/jyeoo): reference_md stores
  // "（C）<选项原文>\n\n解析：<解题过程>". Before the fix the leading-letter
  // parser required a bare letter at position 0, so the parenthesized head
  // never resolved to a choice index and the 解析 tail poisoned text compare —
  // a learner picking the verbatim-correct option was judged incorrect.
  const choices = [
    'F_max(x)=F_X(x)+F_Y(x)',
    'F_max(x)=F_X(x)F_Y(x)−F_X(x)F_Y(x)',
    'F_max(x)=F_X(x)F_Y(x)',
    'F_max(x)=1−F_X(x)F_Y(x)',
  ];
  const reference =
    '（C）F_max(x)=F_X(x)F_Y(x)\n\n解析：设 Z=max{X,Y}，则 {Z≤x}={X≤x,Y≤x}，由独立性得 F_Z(x)=F_X(x)F_Y(x)。';

  it('full-width "（C）选项+解析" reference vs letter answer "C" → correct', () => {
    const r = judgeExact({ reference, choices_md: choices }, { content: 'C' });
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
    expect(r.evidence_json.match_type).toBe('choice_index');
    expect(r.evidence_json.reference_choice_indices).toEqual([2]);
    // stripped tail is recorded so the verdict is auditable (head is
    // NFKC-normalized: full-width parens fold to ASCII)
    expect(r.evidence_json.reference_answer_head).toBe('(C)F_max(x)=F_X(x)F_Y(x)');
  });

  it('full-width parenthesized reference vs option-text answer → correct', () => {
    const r = judgeExact({ reference, choices_md: choices }, { content: 'F_max(x)=F_X(x)F_Y(x)' });
    expect(r.verdict).toBe('correct');
  });

  it('ASCII "(C) option" reference resolves to the same index', () => {
    const r = judgeExact(
      { reference: '(C) F_max(x)=F_X(x)F_Y(x)', choices_md: choices },
      { content: 'C' },
    );
    expect(r.verdict).toBe('correct');
    expect(r.evidence_json.reference_choice_indices).toEqual([2]);
  });

  it('bare parenthesized letter reference "（B）text" resolves by index', () => {
    expect(
      judgeExact(
        { reference: '（B）主谓倒装', choices_md: ['宾语前置', '主谓倒装', '定语后置'] },
        { content: 'B' },
      ).verdict,
    ).toBe('correct');
    expect(
      judgeExact(
        { reference: '（B）主谓倒装', choices_md: ['宾语前置', '主谓倒装', '定语后置'] },
        { content: 'A' },
      ).verdict,
    ).toBe('incorrect');
  });

  it('multi-select parenthesized "（BC）" resolves both indices', () => {
    const cs = ['甲', '乙', '丙', '丁'];
    expect(
      judgeExact({ reference: '（BC）乙、丙均正确', choices_md: cs }, { content: 'BC' }).verdict,
    ).toBe('correct');
    expect(
      judgeExact({ reference: '（BC）乙、丙均正确', choices_md: cs }, { content: 'B' }).verdict,
    ).toBe('incorrect');
  });

  it('non-choice: "answer\\n\\n解析：…" reference vs bare answer → correct', () => {
    const r = judgeExact(
      { reference: 'E(X)=2.7，Var(X)=0.81\n\n解析：由分布列逐项求和即得（推导略）。' },
      { content: 'E(X)=2.7，Var(X)=0.81' },
    );
    expect(r.verdict).toBe('correct');
    expect(r.evidence_json.match_type).toBe('text');
    expect(r.evidence_json.reference_answer_head).toBe('E(X)=2.7,Var(X)=0.81');
  });

  it('answer-side "答：X" marker and trailing self-explanation still match', () => {
    expect(judgeExact({ reference: '42' }, { content: '答：42' }).verdict).toBe('correct');
    expect(
      judgeExact({ reference: '42' }, { content: '42\n\n解析：先算期望再算方差' }).verdict,
    ).toBe('correct');
  });

  it('pure worked-solution reference (no bare head) falls back to full-string compare', () => {
    const ref = '解：设 Z=max{X,Y}。由独立性，F_Z(x)=F_X(x)F_Y(x)。';
    expect(judgeExact({ reference: ref }, { content: ref }).verdict).toBe('correct');
    expect(judgeExact({ reference: ref }, { content: 'C' }).verdict).toBe('incorrect');
  });

  it('existing prefix formats (C。… / C. …) still resolve — no regression', () => {
    const cs = ['宾语前置', '主谓倒装', '定语后置', '状语后置'];
    expect(
      judgeExact({ reference: 'C。定语后置的判定依据', choices_md: cs }, { content: 'C' }).verdict,
    ).toBe('correct');
    expect(judgeExact({ reference: 'C. 定语后置', choices_md: cs }, { content: 'C' }).verdict).toBe(
      'correct',
    );
  });
});
