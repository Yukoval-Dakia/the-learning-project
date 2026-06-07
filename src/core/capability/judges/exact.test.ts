import { JudgeResultV2 } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';

import { exactJudgeCapability } from './exact';

const run = async (question: Record<string, unknown>, content: string) =>
  await exactJudgeCapability.run({ question, answer: { content } });

describe('exactJudgeCapability — manifest', () => {
  it('declares choices_md in input_schema', () => {
    expect(exactJudgeCapability.manifest.input_schema).toContain('choices_md');
  });
});

describe('exactJudgeCapability — choice-aware judging (YUK-260)', () => {
  it('① letter answer vs option-text reference → correct (owner scenario)', async () => {
    const r = await run(
      { reference: '宾语前置', choices_md: ['宾语前置', '主谓倒装', '定语后置', '状语后置'] },
      'A',
    );
    expect(r.coarse_outcome).toBe('correct');
    expect(r.score).toBe(1);
    expect(JudgeResultV2.safeParse(r).success).toBe(true);
  });

  it('② option-text answer vs letter reference → correct', async () => {
    const r = await run(
      { reference: 'A', choices_md: ['宾语前置', '主谓倒装', '定语后置', '状语后置'] },
      '宾语前置',
    );
    expect(r.coarse_outcome).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('③ multi-select: reference "BC" matches "B、C" and out-of-order "CB"', async () => {
    const choices_md = ['甲', '乙', '丙', '丁'];
    expect((await run({ reference: 'BC', choices_md }, 'B、C')).coarse_outcome).toBe('correct');
    expect((await run({ reference: 'BC', choices_md }, 'CB')).coarse_outcome).toBe('correct');
    // full-width comma separator
    expect((await run({ reference: 'BC', choices_md }, 'B，C')).coarse_outcome).toBe('correct');
  });

  it('④ wrong letter D vs A → incorrect', async () => {
    const r = await run(
      { reference: 'A', choices_md: ['宾语前置', '主谓倒装', '定语后置', '状语后置'] },
      'D',
    );
    expect(r.coarse_outcome).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('⑤ out-of-range letter (E with 4 options) falls back to text equality → incorrect', async () => {
    const r = await run(
      { reference: 'A', choices_md: ['宾语前置', '主谓倒装', '定语后置', '状语后置'] },
      'E',
    );
    // 'E' is not a resolvable index and not equal to reference 'A' → incorrect,
    // but importantly the judge does not crash on the out-of-range letter.
    expect(r.coarse_outcome).toBe('incorrect');
  });

  it('⑥ no choices_md → plain text equality (no regression)', async () => {
    expect((await run({ reference: '宾语前置' }, '宾语前置')).coarse_outcome).toBe('correct');
    expect((await run({ reference: '宾语前置' }, '主谓倒装')).coarse_outcome).toBe('incorrect');
    // a bare letter with no choices stays literal text — 'A' !== '宾语前置'
    expect((await run({ reference: '宾语前置' }, 'A')).coarse_outcome).toBe('incorrect');
  });

  it('⑦ NFKC: full-width letter Ａ resolves to index 0', async () => {
    const r = await run({ reference: '宾语前置', choices_md: ['宾语前置', '主谓倒装'] }, 'Ａ');
    expect(r.coarse_outcome).toBe('correct');
  });

  it('⑧ empty answer string → no match, no crash', async () => {
    const r = await run({ reference: 'A', choices_md: ['宾语前置', '主谓倒装'] }, '');
    expect(r.coarse_outcome).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('empty reference → unsupported (schema requires non-empty reference)', async () => {
    const r = await run({ reference: '', choices_md: ['宾语前置'] }, 'A');
    expect(r.coarse_outcome).toBe('unsupported');
  });
});

describe('exactJudgeCapability — bot-review hardening (YUK-260)', () => {
  // C1: option text is pure Latin letters. Letter-string parse must not shadow
  // the option-text equality — letter answer 'A' should resolve to the option.
  it('C1 True/False options: letter answer "A" matches reference "True"', async () => {
    const choices_md = ['True', 'False'];
    expect((await run({ reference: 'True', choices_md }, 'A')).coarse_outcome).toBe('correct');
    expect((await run({ reference: 'True', choices_md }, 'B')).coarse_outcome).toBe('incorrect');
    // option-text answer still matches a letter reference
    expect((await run({ reference: 'A', choices_md }, 'True')).coarse_outcome).toBe('correct');
    // out-of-range letter ('E' with 2 options) does not crash, stays incorrect
    expect((await run({ reference: 'True', choices_md }, 'E')).coarse_outcome).toBe('incorrect');
  });

  // C2: reading-comprehension reference_md is "正确项字母 + 依据" ("C。…"); choices
  // may carry a label prefix ("A. …"). A bare-letter student answer must match.
  it('C2 reading-comprehension: answer "C" matches reference "C。原文依据…"', async () => {
    const choices_md = [
      'A. 修八尺有余　　修：长，这里指身高',
      'B. 朝服衣冠　　　服：穿戴',
      'C. 窥镜　　　　　窥：偷看',
      'D. 忌不自信　　　信：相信',
    ];
    const reference = 'C。「窥镜」的「窥」此处是「照（镜子）」之意，并非「偷看」。';
    expect((await run({ reference, choices_md }, 'C')).coarse_outcome).toBe('correct');
    expect((await run({ reference, choices_md }, 'A')).coarse_outcome).toBe('incorrect');
    // full option text on the answer side also matches
    expect((await run({ reference, choices_md }, 'C. 窥镜　　　　　窥：偷看')).coarse_outcome).toBe(
      'correct',
    );
  });

  // C2 math: options containing Latin letters ('a + b') match by text, and the
  // letter-prefixed reference ('B. a − b') resolves to its index.
  it('C2 math options with Latin letters resolve by text + prefix', async () => {
    const choices_md = ['A. a + b', 'B. a − b', 'C. a × b'];
    expect((await run({ reference: 'B. a − b', choices_md }, 'B')).coarse_outcome).toBe('correct');
    expect((await run({ reference: 'B. a − b', choices_md }, 'A. a + b')).coarse_outcome).toBe(
      'incorrect',
    );
  });

  // C3: DB / JudgeQuestionRow shape forwards choices_md: null for non-choice
  // questions. Must normalise to plain exact judging, not "unsupported".
  it('C3 choices_md: null → plain text equality (not unsupported)', async () => {
    expect(
      (await run({ reference: '宾语前置', choices_md: null }, '宾语前置')).coarse_outcome,
    ).toBe('correct');
    expect(
      (await run({ reference: '宾语前置', choices_md: null }, '主谓倒装')).coarse_outcome,
    ).toBe('incorrect');
    // a bare letter with null choices stays literal — 'A' !== '宾语前置'
    expect((await run({ reference: '宾语前置', choices_md: null }, 'A')).coarse_outcome).toBe(
      'incorrect',
    );
  });

  // OCR-1: evidence_json must record HOW the match was decided + resolved indices
  // so a choice_index verdict (normalized text legitimately differs) is not
  // self-contradictory.
  it('OCR-1 evidence carries match_type + resolved choice indices', async () => {
    const choices_md = ['宾语前置', '主谓倒装', '定语后置', '状语后置'];
    const r = await run({ reference: '宾语前置', choices_md }, 'A');
    expect(r.evidence_json?.match_type).toBe('choice_index');
    expect(r.evidence_json?.answer_choice_indices).toEqual([0]);
    expect(r.evidence_json?.reference_choice_indices).toEqual([0]);
    // plain text path reports match_type 'text' with null indices
    const plain = await run({ reference: '宾语前置' }, '宾语前置');
    expect(plain.evidence_json?.match_type).toBe('text');
    expect(plain.evidence_json?.answer_choice_indices).toBeNull();
  });
});
