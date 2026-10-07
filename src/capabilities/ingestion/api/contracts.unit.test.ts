import { describe, expect, it } from 'vitest';
import {
  CreateMistakeBodySchema,
  MistakeListQuerySchema,
  MistakeProjectionSchema,
  MistakePromptMaterialSchema,
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
  const publicText = {
    material_id: 'reading',
    kind: 'passage',
    caption: '阅读材料',
    alt_text: '含公式、嵌套列表与表格',
    content_md: '逐字冻结：$v = \\sqrt{2gh}$\n\n|坡度|流速|\n|5°|0.4|\n'.repeat(90),
  };

  it('preserves full inline material text without a downloadable asset', () => {
    const material = { ...publicText, availability: 'inline' };
    expect(MistakePromptMaterialSchema.parse(material)).toEqual(material);
    expect(MistakePromptMaterialSchema.safeParse({ ...material, asset_id: 'txt_id' }).success).toBe(
      false,
    );
    expect(
      MistakePromptMaterialSchema.safeParse({ ...material, content_md: undefined }).success,
    ).toBe(false);
    expect(MistakePromptMaterialSchema.safeParse({ ...material, kind: 'figure' }).success).toBe(
      false,
    );
  });

  it.each(['figure', 'passage', 'table', 'audio', 'video', 'pdf', 'plaintext'])(
    'accepts available %s metadata and distinguishes missing from unavailable without asset IDs',
    (kind) => {
      const material = { ...publicText, kind };
      expect(
        MistakePromptMaterialSchema.parse({
          ...material,
          availability: 'available',
          asset_id: 'frozen',
        }),
      ).toMatchObject({ asset_id: 'frozen' });
      expect(
        MistakePromptMaterialSchema.safeParse({ ...material, availability: 'available' }).success,
      ).toBe(false);
      for (const availability of ['missing', 'unavailable']) {
        const unavailable = { ...material, availability };
        expect(MistakePromptMaterialSchema.parse(unavailable)).toEqual(unavailable);
        expect(
          MistakePromptMaterialSchema.safeParse({ ...unavailable, asset_id: 'mutable' }).success,
        ).toBe(false);
      }
    },
  );

  it.each(['storage_key', 'storage_url', 'visibility', 'rubric', 'solution', 'provenance'])(
    'rejects undeclared material field %s',
    (field) => {
      expect(
        MistakePromptMaterialSchema.safeParse({
          ...publicText,
          availability: 'inline',
          [field]: 'PRIVATE',
        }).success,
      ).toBe(false);
    },
  );

  it('defaults the new public read field to [] for older payloads', () => {
    expect(MistakeProjectionSchema.shape.prompt_materials.parse(undefined)).toEqual([]);
  });

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
