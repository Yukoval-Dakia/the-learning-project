import { describe, expect, it } from 'vitest';
import { MultipartFileUploadSchema } from './contracts';

describe('ingestion multipart contract', () => {
  it('accepts the File object produced by Request.formData()', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'paper.pdf', {
      type: 'application/pdf',
    });

    expect(MultipartFileUploadSchema.safeParse({ file }).success).toBe(true);
    expect(MultipartFileUploadSchema.safeParse({ file: 'AQID' }).success).toBe(false);
  });
});
