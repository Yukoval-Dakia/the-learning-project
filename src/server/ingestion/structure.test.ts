import { describe, expect, it, vi } from 'vitest';

import {
  StructureTaskError,
  type TencentPageHint,
  renderTencentHint,
  runStructureTask,
} from './structure';

// YUK-227 S3 Slice A test helpers
import type { FigureAssignment } from './structure';

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

// ---------- YUK-227 S3 Slice A — figureAssignments mapping ----------

describe('runStructureTask — figureAssignments (YUK-227 S3 Slice A)', () => {
  it('maps figure_ids on nodes to figureAssignments with question ids', async () => {
    // VLM reports figure index 0 belongs to the stem, index 1 belongs to sub1.
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({
        layout_quality: 'structured',
        warnings: [],
        questions: [
          {
            role: 'stem',
            prompt_text: '阅读材料，完成下列题目',
            page_index: 0,
            figure_ids: [0], // stem claims figure 0
            sub_questions: [
              {
                role: 'sub',
                question_no: '1',
                prompt_text: '分析电路图。',
                page_index: 0,
                figure_ids: [1], // sub claims figure 1
              },
              {
                role: 'sub',
                question_no: '2',
                prompt_text: '根据上图回答。',
                page_index: 1,
                // no figure_ids on this sub
              },
            ],
          },
        ],
      }),
    }));

    const result = await runStructureTask({
      pageImages: [IMG, IMG],
      tencentHintMd: '',
      pageCount: 2,
      preFigures: [
        { index: 0, page_index: 0 },
        { index: 1, page_index: 0 },
      ],
      runTaskFn,
    });

    // figureAssignments should be present
    expect(result.figureAssignments).toBeDefined();
    const assignments = result.figureAssignments as FigureAssignment[];
    expect(assignments).toHaveLength(2);

    // Verify figure 0 is attached to the stem (first top-level question)
    const stemId = result.questions[0].id;
    const a0 = assignments.find((a) => a.figure_index === 0);
    expect(a0).toBeDefined();
    expect(a0?.attached_to_question_id).toBe(stemId);
    expect(a0?.confidence).toBe('high');

    // Verify figure 1 is attached to sub1 (first sub_question)
    const sub1Id = result.questions[0].sub_questions?.[0]?.id;
    expect(sub1Id).toBeTruthy();
    const a1 = assignments.find((a) => a.figure_index === 1);
    expect(a1).toBeDefined();
    expect(a1?.attached_to_question_id).toBe(sub1Id);
    expect(a1?.confidence).toBe('high');
  });

  it('returns no figureAssignments when preFigures is absent', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({
        layout_quality: 'structured',
        warnings: [],
        questions: [
          {
            role: 'standalone',
            prompt_text: '题目',
            page_index: 0,
            figure_ids: [0], // VLM reports this but we have no preFigures
          },
        ],
      }),
    }));

    const result = await runStructureTask({
      pageImages: [IMG],
      tencentHintMd: '',
      pageCount: 1,
      // preFigures intentionally omitted
      runTaskFn,
    });

    // Without preFigures, figureAssignments should not be populated
    expect(result.figureAssignments).toBeUndefined();
  });

  it('returns undefined figureAssignments when VLM emits no figure_ids', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({
        layout_quality: 'structured',
        warnings: [],
        questions: [{ role: 'standalone', prompt_text: '题目', page_index: 0 }],
      }),
    }));

    const result = await runStructureTask({
      pageImages: [IMG],
      tencentHintMd: '',
      pageCount: 1,
      preFigures: [{ index: 0, page_index: 0 }],
      runTaskFn,
    });

    // preFigures supplied but VLM emitted no figure_ids → no assignments
    expect(result.figureAssignments).toBeUndefined();
  });

  it('includes figures metadata in the text payload when preFigures provided', async () => {
    const runTaskFn = vi.fn(async (_kind: string, input: { text: string; images: unknown[] }) => {
      const payload = JSON.parse(input.text);
      expect(payload.figures).toEqual([{ index: 0, page_index: 1 }]);
      return {
        text: vlmJson({
          layout_quality: 'structured',
          warnings: [],
          questions: [{ role: 'standalone', prompt_text: 'q', figure_ids: [0] }],
        }),
      };
    });

    await runStructureTask({
      pageImages: [IMG, IMG],
      tencentHintMd: '',
      pageCount: 2,
      preFigures: [{ index: 0, page_index: 1 }],
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledOnce();
  });

  it('does NOT include figures key in payload when preFigures is empty', async () => {
    const runTaskFn = vi.fn(async (_kind: string, input: { text: string; images: unknown[] }) => {
      const payload = JSON.parse(input.text);
      expect(payload.figures).toBeUndefined();
      return {
        text: vlmJson({
          layout_quality: 'structured',
          warnings: [],
          questions: [{ role: 'standalone', prompt_text: 'q' }],
        }),
      };
    });

    await runStructureTask({
      pageImages: [IMG],
      tencentHintMd: '',
      pageCount: 1,
      preFigures: [],
      runTaskFn,
    });

    expect(runTaskFn).toHaveBeenCalledOnce();
  });
});

// ---------- YUK-227 S3 Slice A (P1 fix) — page_index propagation ----------

describe('runStructureTask — page_index propagation (YUK-227 S3 Slice A P1)', () => {
  it('copies VLM node page_index to StructuredQuestionT (P1 fix)', async () => {
    // VLM reports a multi-page stem: stem on page 0, second sub on page 1.
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({
        layout_quality: 'structured',
        warnings: [],
        questions: [
          {
            role: 'stem',
            prompt_text: 'Stem on page 0',
            page_index: 0,
            sub_questions: [
              { role: 'sub', question_no: '1', prompt_text: 'Sub on page 0', page_index: 0 },
              { role: 'sub', question_no: '2', prompt_text: 'Sub on page 1', page_index: 1 },
            ],
          },
          {
            role: 'standalone',
            prompt_text: 'Standalone on page 1',
            page_index: 1,
          },
        ],
      }),
    }));

    const result = await runStructureTask({
      pageImages: [IMG, IMG],
      tencentHintMd: '',
      pageCount: 2,
      runTaskFn,
    });

    expect(result.questions).toHaveLength(2);

    // P1 fix: stem page_index must be copied from the VLM node
    expect(result.questions[0].page_index).toBe(0);

    // Sub questions also carry page_index
    const subs = result.questions[0].sub_questions ?? [];
    expect(subs[0].page_index).toBe(0);
    expect(subs[1].page_index).toBe(1);

    // Standalone on page 1
    expect(result.questions[1].page_index).toBe(1);
  });

  it('omits page_index when VLM node does not report it', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: vlmJson({
        layout_quality: 'structured',
        warnings: [],
        questions: [{ role: 'standalone', prompt_text: 'No page_index reported' }],
      }),
    }));

    const result = await runStructureTask({
      pageImages: [IMG],
      tencentHintMd: '',
      pageCount: 1,
      runTaskFn,
    });

    // VLM omitted page_index → StructuredQuestionT should not carry it
    expect(result.questions[0].page_index).toBeUndefined();
  });
});
