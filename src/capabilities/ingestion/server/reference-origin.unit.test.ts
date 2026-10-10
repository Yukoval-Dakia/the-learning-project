import { describe, expect, it } from 'vitest';
import { StructuredQuestion, type StructuredQuestionT } from '@/core/schema/structured_question';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import type { StructureNodeT } from '../tasks/structure';
import { runStructureTask } from './structure';
import { parseMarkAgentResponse } from './tencent_mark_parser';
import { runVisionExtract, visionBlockToStructured } from './vision';

// Grading invariant: extraction observations must not become an answer key.
function normalize(structured: StructuredQuestionT) {
  return normalizeQuestionRowToContract({
    id: 'captured-question',
    kind: 'choice',
    prompt_md: structured.prompt_text,
    reference_md: null,
    rubric_json: null,
    choices_md: null,
    judge_kind_override: null,
    structured: StructuredQuestion.parse(structured),
    source: 'ocr',
  });
}

async function extract(nodes: StructureNodeT[]) {
  return runStructureTask({
    pageImages: [{ data: 'fixture', mediaType: 'image/png' }],
    pageCount: 1,
    tencentHintMd: 'OCR is a hint, not an answer key',
    runTaskFn: async () => ({
      text: JSON.stringify({
        layout_quality: 'structured',
        extraction_confidence: 0.98,
        warnings: [],
        questions: nodes,
      }),
    }),
  });
}

const leaf: StructureNodeT = {
  role: 'sub',
  kind: 'choice',
  prompt_text: '已知 x + 1 = 3，选择 x 的值。',
  options: [
    { label: 'A', text: '2' },
    { label: 'B', text: '4' },
  ],
  answers: ['B'],
  analysis: '学生写下 x = 3 + 1 = 4，但移项符号有误。',
  page_index: 0,
  student_answer_present: true,
};

describe('captured reference origin', () => {
  it.each([
    { reference_origin: 'student_work', reference_page_index: 0 },
    { reference_origin: 'unknown', reference_page_index: 0 },
    {},
    { reference_origin: 'printed' },
    { reference_origin: 'printed', reference_page_index: 1 },
  ] satisfies Partial<StructureNodeT>[])('does not publish a key from %j', async (origin) => {
    const result = await extract([
      {
        role: 'stem',
        prompt_text: '计算并核对两边是否相等。',
        sub_questions: [{ ...leaf, ...origin }],
      },
    ]);
    const root = result.questions[0];
    const child = root.sub_questions?.[0];
    expect(child?.answers).toBeUndefined();
    expect(child?.analysis).toBeUndefined();
    expect(child?.student_answer_present).toBe(true);
    expect(child?.options).toEqual(leaf.options);
    expect(normalize(root).conversion_issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_reference', partId: child?.id }),
      ]),
    );
  });

  it('retains a separately printed reference even when the page also has student work', async () => {
    const result = await extract([
      {
        ...leaf,
        role: 'standalone',
        answers: ['A'],
        analysis: '印刷解析：x = 3 - 1 = 2。',
        reference_origin: 'printed',
        reference_page_index: 0,
      },
    ]);
    const question = StructuredQuestion.parse(result.questions[0]);
    expect(question.answers).toEqual(['A']);
    expect(question.extraction_evidence?.reference_extraction).toEqual({
      origin: 'printed',
      page_index: 0,
    });
    expect(normalize(question).conversion_issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'missing_reference' })]),
    );
  });

  it('preserves Tencent grading evidence without promoting its suggestion into a key', () => {
    const result = parseMarkAgentResponse(
      {
        JobStatus: 'DONE',
        MarkInfos: [
          {
            MarkItemTitle: '计算题组',
            MarkInfos: [
              {
                MarkItemTitle: '1. x + 1 = 3\nA. 2\nB. 4',
                AnswerInfos: [
                  {
                    RightAnswer: 'B',
                    AnswerAnalysis: '批改服务给出的建议',
                    IsCorrect: true,
                    HandwriteInfo: 'x = 3 + 1 = 4',
                  },
                ],
              },
            ],
          },
        ],
      },
      { pageWidth: 1000, pageHeight: 1000 },
    );
    const root = StructuredQuestion.parse(result.questions[0]);
    const child = root.sub_questions?.[0];
    expect(child?.answers).toBeUndefined();
    expect(child?.analysis).toBeUndefined();
    expect(child?.extraction_evidence?.tencent_grading?.RightAnswer).toBe('B');
    expect(child?.extraction_evidence?.handwriting?.[0].text).toBe('x = 3 + 1 = 4');
    expect(normalize(root).conversion_issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_reference', partId: child?.id }),
      ]),
    );
  });
});

describe('manual rescue reference origin', () => {
  it.each(['student_work', 'unknown', undefined, 'printed'] as const)(
    'preserves learner evidence and binds %s reference to the supplied page',
    async (reference_origin) => {
      const result = await runVisionExtract({
        assetId: 'page-three',
        mimeType: 'image/png',
        imageBytes: new ArrayBuffer(0),
        pageIndex: 2,
        runTaskFn: async () => ({
          text: JSON.stringify({
            blocks: [
              {
                extracted_prompt_md: 'x + 1 = 3，求 x。',
                reference_md: reference_origin === 'printed' ? '2' : '4',
                reference_origin,
                wrong_answer_md: 'x = 3 + 1 = 4',
                page_index: 99,
                bbox: { x: 0, y: 0, width: 1, height: 1 },
                role: 'prompt',
                visual_complexity: 'low',
                extraction_confidence: 0.99,
                knowledge_hint: null,
              },
            ],
          }),
        }),
      });
      const structured = StructuredQuestion.parse(visionBlockToStructured(result.blocks[0]));
      expect(structured.page_index).toBe(2);
      expect(structured.extraction_evidence?.reference_extraction).toEqual({
        origin: reference_origin ?? 'unknown',
        page_index: 2,
      });
      expect(structured.extraction_evidence?.handwriting?.[0].text).toBe('x = 3 + 1 = 4');
      if (reference_origin === 'printed') {
        expect(structured.answers).toEqual(['2']);
      } else {
        expect(structured.answers).toBeUndefined();
        expect(normalize(structured).conversion_issues).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'missing_reference' })]),
        );
      }
    },
  );
});
