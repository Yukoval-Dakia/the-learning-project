import { describe, expect, it } from 'vitest';
import {
  defaultJudgeKindForQuestion,
  extractAnswerHead,
  isExactCapableReference,
  nonEmptyStrings,
  stripTrailingJunk,
} from './judge-routing';

describe('nonEmptyStrings', () => {
  it('trims and drops blank entries', () => {
    expect(nonEmptyStrings(['  a ', '', '  ', 'b'])).toEqual(['a', 'b']);
  });

  it('returns [] for undefined', () => {
    expect(nonEmptyStrings(undefined)).toEqual([]);
  });
});

describe('defaultJudgeKindForQuestion', () => {
  it('honours an explicit judge_kind_override', () => {
    expect(
      defaultJudgeKindForQuestion({ kind: 'short_answer', judge_kind_override: 'rubric' }),
    ).toBe('rubric');
  });

  it('routes choice / true_false to exact', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'choice' })).toBe('exact');
    expect(defaultJudgeKindForQuestion({ kind: 'true_false' })).toBe('exact');
  });

  it('routes fill_blank to keyword only when keywords are present', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'fill_blank' })).toBe('exact');
    expect(
      defaultJudgeKindForQuestion({
        kind: 'fill_blank',
        rubric_json: { criteria: [], keywords: ['甲'] },
      }),
    ).toBe('keyword');
  });

  it('routes computation to keyword when keywords present, else semantic', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'computation' })).toBe('semantic');
    expect(
      defaultJudgeKindForQuestion({
        kind: 'computation',
        rubric_json: { criteria: [], keywords: ['x'] },
      }),
    ).toBe('keyword');
  });

  it('routes derivation to semantic (never exact)', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'derivation' })).toBe('semantic');
  });

  it('routes prose kinds to semantic', () => {
    // The retired PROSE_KINDS set, enumerated literally (YUK-391 deleted the
    // export; the family now derives from the answer-class axis).
    for (const kind of ['short_answer', 'reading', 'translation', 'essay'] as const) {
      expect(defaultJudgeKindForQuestion({ kind })).toBe('semantic');
    }
  });

  it('routes prose-listed essay to semantic (not exact)', () => {
    // essay is in PROSE_KINDS → semantic; anything not prose/derivation/etc → exact.
    expect(defaultJudgeKindForQuestion({ kind: 'essay' })).toBe('semantic');
  });
});

describe('extractAnswerHead (YUK-1003)', () => {
  it('cuts a blank-line-separated 解析 tail', () => {
    expect(extractAnswerHead('(C)F_max=F_X·F_Y\n\n解析：设 Z=max{X,Y}，由独立性…')).toBe(
      '(C)F_max=F_X·F_Y',
    );
  });

  it('handles all explanation markers: 解析/详解/解答/证明/分析', () => {
    for (const marker of ['解析', '详解', '解答', '证明', '分析', '点评', '点拨']) {
      expect(extractAnswerHead(`42\n\n${marker}：步骤略`)).toBe('42');
    }
  });

  it('strips a leading 答：/解：/答案： marker', () => {
    expect(extractAnswerHead('答：42')).toBe('42');
    expect(extractAnswerHead('答案：宾语前置')).toBe('宾语前置');
    expect(extractAnswerHead('解：42')).toBe('42');
  });

  it('strips trailing sentence punctuation', () => {
    expect(extractAnswerHead('42。')).toBe('42');
    expect(extractAnswerHead('宾语前置．')).toBe('宾语前置');
  });

  it('NFKC-normalizes (full-width parens/letters fold to ASCII)', () => {
    expect(extractAnswerHead('（Ｃ）选项')).toBe('(C)选项');
  });

  it('returns the normalized input when stripping would leave nothing', () => {
    const pure = '解：设 Z=max{X,Y}，由独立性得 F_Z=F_X·F_Y';
    expect(extractAnswerHead(pure)).toBe('设 Z=max{X,Y},由独立性得 F_Z=F_X·F_Y');
  });

  it('does not cut inline 解析 without a paragraph break', () => {
    // "答案是42，解析见下" — no leading marker match (答案是… not 答：) and no
    // paragraph-break tail; the head stays the whole normalized string.
    expect(extractAnswerHead('答案是42，解析见下')).toBe('答案是42,解析见下');
  });
});

describe('isExactCapableReference (YUK-1003)', () => {
  it('accepts bare answers and letter-prefixed choice heads', () => {
    expect(isExactCapableReference('42')).toBe(true);
    expect(isExactCapableReference('(C)F_max=F_X·F_Y')).toBe(true);
    expect(isExactCapableReference('x=3')).toBe(true);
  });

  it('accepts "answer + 解析 tail" — the head extracts to a bare answer', () => {
    expect(
      isExactCapableReference('E(X)=2.7\n\n解析：由分布列逐项求和即得，过程省略若干步骤说明。'),
    ).toBe(true);
    // the jyeoo choice shape is exact-capable on its head
    expect(isExactCapableReference('（C）选项原文\n\n解析：逐项分析可知只有 C 满足条件。')).toBe(
      true,
    );
  });

  it('rejects a head that still carries solution markers (inline 解析, no paragraph break)', () => {
    expect(isExactCapableReference('42 解析：先求期望再求方差即可')).toBe(false);
    expect(isExactCapableReference('【解析】直接由公式得 42')).toBe(false);
  });

  it('rejects multi-paragraph references (no single bare head)', () => {
    expect(isExactCapableReference('第一段\n\n第二段\n\n第三段')).toBe(false);
  });

  it('rejects overlong heads', () => {
    expect(isExactCapableReference(`x${'y'.repeat(400)}`)).toBe(false);
  });

  it('single-paragraph process prose still extracts a head (structural guard, not semantic)', () => {
    // '解：设 Z=…' strips the marker and yields a matchable head — verbatim
    // equality is technically possible so the row stays exact. This is the
    // guard's documented boundary: it catches structurally unwinnable rows,
    // not stylistic process prose.
    expect(isExactCapableReference('解：设 Z=max{X,Y}，由独立性得 F_Z=F_X·F_Y')).toBe(true);
  });
});

// ── YUK-1224 (SCF-141) — trailing-junk stripper: semantics pinned to the retired regex ──
// The retired expression is kept ONLY as an oracle here. It is exponential on the
// adversarial input handled by judge-routing-dos.test.ts (which runs that case in a
// hard-timeout child), so this corpus is deliberately capped at 14 chars: long
// enough to hit every alternative/overlap shape, short enough that the oracle is cheap.
const RETIRED_TRAILING_JUNK_RE =
  /(?:[\s。．.，,；;：:、*]|\s*[（(]\s*(?:选项|正确答案)\s*[A-Z]{0,4}\s*[)）]?)+$/;

describe('stripTrailingJunk (YUK-1224 / SCF-141)', () => {
  it('is byte-for-byte the retired expression on a curated + fuzzed corpus', () => {
    const curated = [
      '',
      ' ',
      '。',
      '**',
      'x',
      '42。',
      '宾语前置',
      '宾语前置．',
      '解析完。',
      'C.0.950 **',
      '答案 D（选项 D）',
      '答案 D （选项 D）',
      '答案D（选项D）',
      'X（正确答案 AB）',
      'X (正确答案 AB)',
      'C。原文依据（选项 C）',
      '（选项A',
      '(选项A',
      '(选项)',
      '（选项）',
      '（选项 A）',
      '（选项AB）',
      '（选项ABCD）',
      '（选项ABCDE）',
      '(正确答案)',
      '（正确答案）',
      '(选项AB)。',
      '（选项A）x',
      '答案（选项A',
      'A. (选项A',
      'D\u3000（选项 D）',
      '(选项（选项AB）',
      '（选项（选项AB）',
      '答案 D／（选项 D）',
      '( 选项 A )',
      '(选项 AB',
      '*（选项A）*',
      '解析完。（选项 A）',
      '主语（选项）',
      '待定(选项 A )(选项 B)',
      '（）',
      '( )',
      '(x)',
      '(选项x)',
      '(选项 x)',
    ];
    // Deterministic LCG fuzz over the token alphabet.
    const alphabet = [
      '(',
      '（',
      ')',
      '）',
      '选',
      '项',
      '正',
      '确',
      '答',
      '案',
      'A',
      'Z',
      ' ',
      '。',
      '*',
      'x',
      '、',
    ];
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const fuzzed: string[] = [];
    for (let n = 0; n < 400; n += 1) {
      const len = Math.floor(next() * 15);
      let s = '';
      for (let k = 0; k < len; k += 1) s += alphabet[Math.floor(next() * alphabet.length)];
      fuzzed.push(s);
    }

    const mismatches: string[] = [];
    for (const s of [...curated, ...fuzzed]) {
      const expected = s.replace(RETIRED_TRAILING_JUNK_RE, '');
      const actual = stripTrailingJunk(s);
      if (actual !== expected) {
        mismatches.push(
          `${JSON.stringify(s)}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it.each([
    ['答案 D（选项 D）', '答案 D'],
    ['答案 D （选项 D）', '答案 D'],
    ['解析完。', '解析完'],
    ['C.0.950 **', 'C.0.950'],
    ['X（正确答案 AB）', 'X'],
    ['宾语前置', '宾语前置'],
  ])('extractAnswerHead(%j) → %j (legal oracle cases)', (input, expected) => {
    expect(extractAnswerHead(input)).toBe(expected);
  });
});
