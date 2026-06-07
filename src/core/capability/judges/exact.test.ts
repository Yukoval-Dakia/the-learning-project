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
