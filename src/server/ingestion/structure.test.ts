import { describe, expect, it, vi } from 'vitest';

import {
  StructureTaskError,
  type TencentPageHint,
  renderTencentHint,
  runStructureTask,
} from './structure';

const IMG = { data: 'AAAA', mediaType: 'image/png' } as const;

function vlmJson(payload: unknown): string {
  // The runner returns raw assistant text; runStructureTask extracts the JSON
  // object. Wrap with chatter to prove extractJsonObject is doing its job.
  return `here is the structure:\n${JSON.stringify(payload)}\ndone.`;
}

describe('renderTencentHint', () => {
  it('prefixes each page and renders questions via structuredToPromptMarkdown', () => {
    const pages: TencentPageHint[] = [
      {
        page_index: 0,
        questions: [
          {
            id: 'q1',
            role: 'standalone',
            prompt_text: '1+1=?',
            question_no: '1',
            source: 'tencent_ocr',
          },
        ],
      },
      { page_index: 1, questions: [] },
    ];
    const hint = renderTencentHint(pages);
    expect(hint).toContain('=== page 0 ===');
    expect(hint).toContain('1. 1+1=?');
    expect(hint).toContain('=== page 1 ===');
    expect(hint).toContain('腾讯未识别出题目');
  });
});

describe('runStructureTask', () => {
  it('assembles a cross-page 大题 into one stem with subs (happy path)', async () => {
    const runTaskFn = vi.fn(
      async (
        _kind: string,
        _input: { text: string; images: Array<{ data: string; mediaType: string }> },
        _ctx: unknown,
      ) => ({
        text: vlmJson({
          layout_quality: 'structured',
          warnings: [],
          questions: [
            {
              role: 'stem',
              prompt_text: '阅读下面的文言文，完成下列小题。',
              page_index: 0,
              sub_questions: [
                { role: 'sub', question_no: '1', prompt_text: '解释加点词。', page_index: 0 },
                // second sub physically lives on page 1 — VLM assembled it into the
                // same stem (this is the YUK-144 cross-page fix the prompt drives).
                { role: 'sub', question_no: '2', prompt_text: '翻译句子。', page_index: 1 },
              ],
            },
          ],
        }),
      }),
    );

    const result = await runStructureTask({
      pageImages: [IMG, IMG],
      tencentHintMd: '=== page 0 ===\n...\n=== page 1 ===\n...',
      pageCount: 2,
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledOnce();
    // The task was called with both page images in one multimodal payload.
    const [, input] = runTaskFn.mock.calls[0];
    expect(input.images).toHaveLength(2);

    expect(result.layout_quality).toBe('structured');
    expect(result.questions).toHaveLength(1);
    const stem = result.questions[0];
    expect(stem.role).toBe('stem');
    expect(stem.source).toBe('vlm_structure');
    expect(stem.id).toBeTruthy(); // id assigned post-parse (VLM does not emit it)
    expect(stem.sub_questions).toHaveLength(2);
    expect(stem.sub_questions?.[1].prompt_text).toBe('翻译句子。');
    // every node gets an id + vlm_structure source
    for (const sub of stem.sub_questions ?? []) {
      expect(sub.id).toBeTruthy();
      expect(sub.source).toBe('vlm_structure');
    }
  });

  it('maps options / answers and omits empty arrays', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({
        layout_quality: 'structured',
        questions: [
          {
            role: 'standalone',
            prompt_text: '下列说法正确的是',
            options: [
              { label: 'A', text: '甲' },
              { label: 'B', text: '乙' },
            ],
            answers: ['A'],
            options_empty_test: [],
          },
        ],
      }),
    }));
    const result = await runStructureTask({
      pageImages: [IMG],
      tencentHintMd: '',
      pageCount: 1,
      runTaskFn,
    });
    const q = result.questions[0];
    expect(q.options).toHaveLength(2);
    expect(q.answers).toEqual(['A']);
    expect(q.sub_questions).toBeUndefined();
  });

  it('throws StructureTaskError on unparseable output (handler falls back)', async () => {
    const runTaskFn = vi.fn(async () => ({ text: 'no json here at all' }));
    await expect(
      runStructureTask({ pageImages: [IMG], tencentHintMd: '', pageCount: 1, runTaskFn }),
    ).rejects.toBeInstanceOf(StructureTaskError);
  });

  it('throws StructureTaskError when output fails schema validation', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({ layout_quality: 'nonsense', questions: [] }),
    }));
    await expect(
      runStructureTask({ pageImages: [IMG], tencentHintMd: '', pageCount: 1, runTaskFn }),
    ).rejects.toBeInstanceOf(StructureTaskError);
  });

  it('throws StructureTaskError when the VLM returns 0 questions', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({ layout_quality: 'text_only', warnings: ['blank'], questions: [] }),
    }));
    await expect(
      runStructureTask({ pageImages: [IMG], tencentHintMd: '', pageCount: 1, runTaskFn }),
    ).rejects.toBeInstanceOf(StructureTaskError);
  });

  it('throws StructureTaskError when the LLM call itself fails', async () => {
    const runTaskFn = vi.fn(async () => {
      throw new Error('provider 503');
    });
    await expect(
      runStructureTask({ pageImages: [IMG], tencentHintMd: '', pageCount: 1, runTaskFn }),
    ).rejects.toBeInstanceOf(StructureTaskError);
  });

  it('throws when no page images are provided', async () => {
    await expect(
      runStructureTask({ pageImages: [], tencentHintMd: '', pageCount: 0 }),
    ).rejects.toBeInstanceOf(StructureTaskError);
  });
});
