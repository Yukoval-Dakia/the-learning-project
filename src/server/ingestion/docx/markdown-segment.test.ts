import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeMathDelimiters, segmentMarkdown } from './markdown-segment';

// Pure no-DB unit. Reads PRE-CONVERTED pandoc output (tests/fixtures/docx/*.md,
// produced one-shot by docker pandoc from the self-authored docx) — the test
// itself never runs pandoc.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, '../../../../tests/fixtures/docx');

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
