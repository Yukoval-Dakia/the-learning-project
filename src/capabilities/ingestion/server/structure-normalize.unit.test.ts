// Printed question numbers and section headers must survive in their own
// fields — a number or section line left inside prompt_text loses the printed
// numbering / contaminates the stem (data-preservation class, invariant #1).

import { describe, expect, it } from 'vitest';

import { runStructureTask } from './structure';

const pageImages = [{ data: 'aGk=', mediaType: 'image/png' }];

function fakeRunTask(output: unknown) {
  return async () => ({ text: JSON.stringify(output), task_run_id: 'run-1' });
}

function baseOutput(questions: unknown[]) {
  return {
    layout_quality: 'structured',
    extraction_confidence: 0.9,
    warnings: [],
    questions,
  };
}

describe('runStructureTask prompt normalization', () => {
  // @invariant data: the printed question number must live in question_no, not inside the stem text
  // @fails-if normalization stops stripping the printed number head or drops question_no
  it('moves a printed number left in prompt_text into question_no', async () => {
    const result = await runStructureTask({
      pageImages,
      tencentHintMd: '',
      pageCount: 1,
      runTaskFn: fakeRunTask(
        baseOutput([
          { role: 'standalone', prompt_text: '6. 计算 3+4 的值。' },
          { role: 'standalone', prompt_text: '第7题 解方程 x-1=0。' },
          { role: 'standalone', prompt_text: '（8）判断对错。' },
        ]),
      ),
    });
    expect(result.task_run_id).toBe('run-1');
    expect(result.questions.map((q) => q.question_no)).toEqual(['6', '7', '8']);
    expect(result.questions.map((q) => q.prompt_text)).toEqual([
      '计算 3+4 的值。',
      '解方程 x-1=0。',
      '判断对错。',
    ]);
  });

  // @invariant data: a printed section header like 一、选择题 must be preserved in section, not the stem
  // @fails-if normalization drops the section field or leaves the header line inside prompt_text
  it('moves a standalone section header line into section, never the stem', async () => {
    const result = await runStructureTask({
      pageImages,
      tencentHintMd: '',
      pageCount: 1,
      runTaskFn: fakeRunTask(
        baseOutput([
          {
            role: 'standalone',
            question_no: '7',
            prompt_text: '三、解答题\n计算定积分。',
          },
          {
            role: 'standalone',
            question_no: '9',
            section: '三、解答题',
            prompt_text: '证明恒等式。',
          },
        ]),
      ),
    });
    expect(result.questions[0].section).toBe('三、解答题');
    expect(result.questions[0].prompt_text).toBe('计算定积分。');
    expect(result.questions[1].section).toBe('三、解答题');
    expect(result.questions[1].prompt_text).toBe('证明恒等式。');
  });

  // @invariant data: ambiguous leading text must stay in the stem rather than be silently dropped
  // @fails-if normalization strips a head that is not provably a number or section header
  it('keeps an ambiguous head inside prompt_text (conservative direction)', async () => {
    const result = await runStructureTask({
      pageImages,
      tencentHintMd: '',
      pageCount: 1,
      runTaskFn: fakeRunTask(
        baseOutput([
          // No section word, same-line prose — not provably a section header.
          { role: 'standalone', prompt_text: '一、小明同学做了以下实验并记录。' },
          // Own number conflicts with the head token — do not strip content.
          { role: 'standalone', question_no: '5', prompt_text: '3. 另一个数列的项。' },
        ]),
      ),
    });
    expect(result.questions[0].section).toBeUndefined();
    expect(result.questions[0].prompt_text).toBe('一、小明同学做了以下实验并记录。');
    expect(result.questions[1].question_no).toBe('5');
    expect(result.questions[1].prompt_text).toBe('3. 另一个数列的项。');
  });
});
