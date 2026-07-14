import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeMathDelimiters, segmentMarkdown } from './markdown-segment';

// Pure no-DB unit. Reads PRE-CONVERTED pandoc output (tests/fixtures/docx/*.md,
// produced one-shot by docker pandoc from the self-authored docx) — the test
// itself never runs pandoc.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '../../../../../tests/fixtures/docx');

function md(name: string): string {
  return readFileSync(join(FIX, name), 'utf-8');
}

describe('segmentMarkdown — pandoc yuwen fixture', () => {
  const blocks = segmentMarkdown({ markdown: md('yuwen-text.md'), media: [] });

  it('cuts on escaped question numbers (1\\. / 2\\.)', () => {
    expect(blocks).toHaveLength(2);
    expect(blocks[0].structured.question_no).toBe('1');
    expect(blocks[1].structured.question_no).toBe('2');
  });

  it('stamps source=docx_text and role=standalone', () => {
    for (const b of blocks) {
      expect(b.structured.source).toBe('docx_text');
      expect(b.structured.role).toBe('standalone');
    }
  });

  it('collects A–D options on the first question', () => {
    const opts = blocks[0].structured.options ?? [];
    expect(opts.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(opts[0].text).toBe('锲而不舍');
  });

  it('attaches the inline <img> to the PRECEDING question (题干配图)', () => {
    // The fixture image sits between Q1's options and Q2, so it归 Q1.
    expect(blocks[0].imagePaths).toEqual(['media/image1.png']);
    expect(blocks[1].imagePaths).toEqual([]);
  });

  it('preserves the default blank (____) in the Q2 prompt', () => {
    // pandoc escapes the blank as \_\_\_\_; the prompt should still carry it.
    expect(blocks[1].structured.prompt_text).toMatch(/万物.*。/);
    expect(blocks[1].structured.prompt_text).toContain('_');
  });
});

describe('segmentMarkdown — bare question-number line (学科网: pandoc splits N. from its prompt)', () => {
  // Some 学科网 papers render a question number on its OWN line, with the prompt on
  // the next line ("8\\.\n第⑭段..."). The bare "N\\." line must still open a new
  // block — otherwise the question silently merges into its predecessor (observed
  // in a real 高中语文 paper: Q8/Q13/Q23 all merged upward).
  const markdown = [
    '7\\. 从细节描写的角度，赏析第⑤段画线句的表达效果。',
    '8\\.',
    '第⑭段画线句的对话描写，请赏析这种写法的表达效果。',
    '9\\. 分析文章以“沉默挂掉电话”来收尾的作用。',
  ].join('\n');
  const blocks = segmentMarkdown({ markdown, media: [] });

  it('opens a separate block for a bare "N\\." line', () => {
    expect(blocks.map((b) => b.structured.question_no)).toEqual(['7', '8', '9']);
  });

  it("takes the following line as the bare question's prompt (not leaked into the previous)", () => {
    const byNo = new Map(blocks.map((b) => [b.structured.question_no, b.structured.prompt_text]));
    expect(byNo.get('8')).toBe('第⑭段画线句的对话描写，请赏析这种写法的表达效果。');
    expect(byNo.get('7')).not.toContain('第⑭段');
  });

  it('keeps bare numbered outlines inside the current question', () => {
    const outlined = segmentMarkdown({
      markdown: [
        '7\\. 请从两个方面概括文章内容。',
        '1\\.',
        '第一个方面的作答提示',
        '2\\.',
        '第二个方面的作答提示',
        '8\\. 下一道顶层题。',
      ].join('\n'),
      media: [],
    });

    expect(outlined.map((block) => block.structured.question_no)).toEqual(['7', '8']);
    expect(outlined[0].structured.prompt_text).toContain('1\\.\n第一个方面的作答提示');
    expect(outlined[0].structured.prompt_text).toContain('2\\.\n第二个方面的作答提示');
  });

  it('prefers a later same-number top-level marker over a sequential-looking outline item', () => {
    const outlined = segmentMarkdown({
      markdown: [
        '1\\. 第一题题干。',
        '2\\.',
        '题干内部的第二点提示',
        '2\\. 第二道顶层题。',
        '3\\. 第三道顶层题。',
      ].join('\n'),
      media: [],
    });

    expect(outlined.map((block) => block.structured.question_no)).toEqual(['1', '2', '3']);
    expect(outlined[0].structured.prompt_text).toContain('2\\.\n题干内部的第二点提示');
    expect(outlined[1].structured.prompt_text).toBe('第二道顶层题。');
  });

  it('accepts a bare top-level question after a numbering gap', () => {
    const gapped = segmentMarkdown({
      markdown: [
        '12\\. 上一节最后一道题。',
        '15\\.',
        '下一节从第十五题继续。',
        '16\\. 第十六题。',
      ].join('\n'),
      media: [],
    });

    expect(gapped.map((block) => block.structured.question_no)).toEqual(['12', '15', '16']);
    expect(gapped[1].structured.prompt_text).toBe('下一节从第十五题继续。');
  });

  it('does not let a distant same-number line override the real bare boundary', () => {
    const repeatedInsidePrompt = segmentMarkdown({
      markdown: [
        '7\\. 第七题。',
        '8\\.',
        '第八题第一行题干。',
        '第八题第二行题干。',
        '8. 题干内部恰好重复了同号编号。',
        '9\\. 第九题。',
      ].join('\n'),
      media: [],
    });

    expect(repeatedInsidePrompt.map((block) => block.structured.question_no)).toEqual([
      '7',
      '8',
      '9',
    ]);
    expect(repeatedInsidePrompt[1].structured.prompt_text).toContain('第八题第一行题干。');
    expect(repeatedInsidePrompt[1].structured.prompt_text).toContain(
      '8. 题干内部恰好重复了同号编号。',
    );
  });
});

describe('segmentMarkdown — noise filter', () => {
  it('drops images appearing before the first question (header logo)', () => {
    const input = {
      markdown: ['![](media/logo.png)', '', '1\\. 第一题', 'A\\. 甲'].join('\n'),
      media: [{ path: 'media/logo.png' }],
    };
    const blocks = segmentMarkdown(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].imagePaths).toEqual([]);
  });

  it('filters tiny (<50px) media out of a block (decorative)', () => {
    const input = {
      markdown: ['1\\. 题', '![](media/tiny.png)', '![](media/big.png)'].join('\n'),
      media: [
        { path: 'media/tiny.png', width: 12, height: 12 },
        { path: 'media/big.png', width: 400, height: 300 },
      ],
    };
    const blocks = segmentMarkdown(input);
    expect(blocks[0].imagePaths).toEqual(['media/big.png']);
  });

  it('keeps dimensionless media (拿不准默认存)', () => {
    const input = {
      markdown: ['1\\. 题', '![](media/unknown.png)'].join('\n'),
      media: [{ path: 'media/unknown.png' }],
    };
    const blocks = segmentMarkdown(input);
    expect(blocks[0].imagePaths).toEqual(['media/unknown.png']);
  });
});

describe('normalizeMathDelimiters', () => {
  it('normalizes GitLab inline $`...`$ → $...$', () => {
    expect(normalizeMathDelimiters('设 $`x^2 + 1`$ 为正数')).toBe('设 $x^2 + 1$ 为正数');
  });

  it('normalizes ```math fence → $$...$$', () => {
    const src = '```math\n\\int_0^1 x\\,dx\n```';
    expect(normalizeMathDelimiters(src)).toBe('$$\\int_0^1 x\\,dx$$');
  });

  it('is applied during segmentation (math-delimiters fixture)', () => {
    const blocks = segmentMarkdown({ markdown: md('math-delimiters.md'), media: [] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].structured.prompt_text).toContain('$x^2 + 1$');
    expect(blocks[0].structured.prompt_text).toContain('$$\\int_0^1 x\\,dx = \\frac{1}{2}$$');
    // GitLab inline form must be gone.
    expect(blocks[0].structured.prompt_text).not.toContain('$`');
    const opts = blocks[0].structured.options ?? [];
    expect(opts.map((o) => o.text)).toEqual(['$a$', '$b$']);
  });

  it('leaves already-standard delimiters untouched (idempotent)', () => {
    const std = '已是 $x$ 和 $$y$$ 标准形';
    expect(normalizeMathDelimiters(std)).toBe(std);
  });
});
