// Tencent MarkItemTitle head parsing: the leading printed number moves only
// when provably a number — a decimal or inline enumeration cut into
// question_no loses stem text irreversibly once stored (deterministic parse:
// same input, same fields).

import { describe, expect, it } from 'vitest';

import { parseSubMarkItemTitle } from './tencent_mark_parser';

describe('parseSubMarkItemTitle', () => {
  // @invariant data: same title input yields the same question_no/prompt_text — an uncertain head must stay in the stem, never cut into a number
  // @fails-if the fallback title parser relocates a decimal/enumeration/unmovable head or stops moving a provable printed number
  it('keeps uncertain heads inside prompt_text while provable numbers still move', () => {
    const cases = [
      { in: '0.75 化成分数是____', no: null, prompt: '0.75 化成分数是____' },
      { in: '0. 75 化成分数是____', no: null, prompt: '0. 75 化成分数是____' },
      { in: '3.14×2 等于多少？', no: null, prompt: '3.14×2 等于多少？' },
      {
        in: '12.5 米的绳子剪去 3 米，还剩多少米？',
        no: null,
        prompt: '12.5 米的绳子剪去 3 米，还剩多少米？',
      },
      { in: '3. 5倍的绳子剪去一段……', no: null, prompt: '3. 5倍的绳子剪去一段……' },
      { in: '3、5 两数之和', no: null, prompt: '3、5 两数之和' },
      { in: '３.５ 化成分数是____', no: null, prompt: '３.５ 化成分数是____' },
      {
        in: '（1）求 x 的值；（2）求 y 的值',
        no: null,
        prompt: '（1）求 x 的值；（2）求 y 的值',
      },
      { in: '（1）…（2）…', no: null, prompt: '（1）…（2）…' },
      { in: '（1）求x（2）求y', no: null, prompt: '（1）求x（2）求y' },
      { in: '（1）由（2）式可得 x', no: null, prompt: '（1）由（2）式可得 x' },
      { in: '第三题 计算下列各式。', no: null, prompt: '第三题 计算下列各式。' },
      { in: '第1234题 计算下列各式。', no: null, prompt: '第1234题 计算下列各式。' },
      { in: '1234. 计算下列各式。', no: null, prompt: '1234. 计算下列各式。' },
      { in: '12.', no: null, prompt: '12.' },
      { in: '１２. 求 x 的值', no: null, prompt: '１２. 求 x 的值' },
      { in: '（1）\n求 x 的值', no: null, prompt: '（1）\n求 x 的值' },
      { in: '……接上题最后一问。', no: null, prompt: '……接上题最后一问。' },
      { in: '3. 计算下列各式。', no: '3', prompt: '计算下列各式。' },
      { in: '第3题 计算下列各式。', no: '3', prompt: '计算下列各式。' },
      { in: '（2）求 y 的值', no: '2', prompt: '求 y 的值' },
      { in: '（1）求 f(2) 的值', no: '1', prompt: '求 f(2) 的值' },
      { in: '1) 求 x 的值', no: '1', prompt: '求 x 的值' },
      { in: '1、求 x 的值', no: '1', prompt: '求 x 的值' },
      { in: '07. 计算下列各式。', no: '7', prompt: '计算下列各式。' },
    ];
    for (const row of cases) {
      const parsed = parseSubMarkItemTitle(row.in);
      expect(parsed.question_no ?? null).toBe(row.no);
      expect(parsed.prompt_text).toBe(row.prompt);
    }
  });

  // @invariant data: option lines after the head must keep their label/text split whichever way the head resolves
  // @fails-if the head change swallows, shifts, or rewrites A./B. option lines
  it('keeps option lines attached through either head outcome', () => {
    const moved = parseSubMarkItemTitle(
      '1. ______\nA. decision\nB. reason\nC. difference\nD. choice',
    );
    expect(moved.question_no).toBe('1');
    expect(moved.prompt_text).toBe('______');
    expect(moved.options).toEqual([
      { label: 'A', text: 'decision' },
      { label: 'B', text: 'reason' },
      { label: 'C', text: 'difference' },
      { label: 'D', text: 'choice' },
    ]);

    const kept = parseSubMarkItemTitle('0.75 化成分数是____\nA. 3/4\nB. 4/5');
    expect(kept.question_no).toBeUndefined();
    expect(kept.prompt_text).toBe('0.75 化成分数是____');
    expect(kept.options).toEqual([
      { label: 'A', text: '3/4' },
      { label: 'B', text: '4/5' },
    ]);
  });
});
