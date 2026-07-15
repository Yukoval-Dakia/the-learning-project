import { describe, expect, it } from 'vitest';
import {
  CreateMistakeBodySchema,
  MistakeListQuerySchema,
  MultipartFileUploadSchema,
} from './contracts';

describe('ingestion multipart contract', () => {
  it('accepts the File object produced by Request.formData()', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'paper.pdf', {
      type: 'application/pdf',
    });

    expect(MultipartFileUploadSchema.safeParse({ file }).success).toBe(true);
    expect(MultipartFileUploadSchema.safeParse({ file: 'AQID' }).success).toBe(false);
  });
});

describe('mistake route contracts', () => {
  it('applies the same optional image-ref defaults as the handler', () => {
    const body = CreateMistakeBodySchema.parse({
      prompt_md: '题目',
      reference_md: null,
      wrong_answer_md: '错答',
      knowledge_ids: ['k1'],
      cause: null,
      difficulty: 3,
      question_kind: 'short_answer',
    });

    expect(body.prompt_image_refs).toEqual([]);
    expect(body.wrong_answer_image_refs).toEqual([]);
  });

  it('keeps query validation aligned with URLSearchParams strings', () => {
    expect(MistakeListQuerySchema.safeParse({ limit: '50' }).success).toBe(true);
    expect(MistakeListQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
    expect(MistakeListQuerySchema.safeParse({ since: 'not-a-date' }).success).toBe(false);
  });
});
