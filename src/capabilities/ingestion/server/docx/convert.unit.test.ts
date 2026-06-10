import { afterEach, describe, expect, it } from 'vitest';

import {
  CONVERT_TIMEOUT_MS,
  type DocxConverter,
  getDocxConverter,
  setDocxConverterForTests,
} from './convert';

// Pure no-DB unit. The converter is exercised ONLY through an injected mock — NO
// real spawn / docker run happens in the test partition (plan §2: 禁真转换进测试).
// This guards the seam contract (getter returns the injected converter, shape is
// stable) and the timeout bound constant.

afterEach(() => {
  // Always restore the default resolver so one test's mock can't leak.
  setDocxConverterForTests(null);
});

function fakeConverter(): DocxConverter & {
  markdownCalls: number;
  pdfCalls: number;
} {
  const state = { markdownCalls: 0, pdfCalls: 0 };
  return {
    ...state,
    async docxToMarkdown(input: Uint8Array) {
      state.markdownCalls += 1;
      // Echo the input length so the test can assert the bytes were threaded.
      return {
        markdown: `1\\. 题 (${input.byteLength} bytes)`,
        media: [{ path: 'media/image1.png', bytes: new Uint8Array([1, 2, 3]) }],
      };
    },
    async docxToPdf(input: Uint8Array) {
      state.pdfCalls += 1;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46, input.byteLength & 0xff]);
    },
    get markdownCalls() {
      return state.markdownCalls;
    },
    get pdfCalls() {
      return state.pdfCalls;
    },
  };
}

describe('converter seam (mock injection)', () => {
  it('getDocxConverter returns the injected mock', () => {
    const mock = fakeConverter();
    setDocxConverterForTests(mock);
    expect(getDocxConverter()).toBe(mock);
  });

  it('docxToMarkdown returns { markdown, media[] } and threads the input', async () => {
    const mock = fakeConverter();
    setDocxConverterForTests(mock);
    const conv = getDocxConverter();
    const result = await conv.docxToMarkdown(new Uint8Array(42));
    expect(result.markdown).toContain('42 bytes');
    expect(result.media).toHaveLength(1);
    expect(result.media[0].path).toBe('media/image1.png');
    expect(mock.markdownCalls).toBe(1);
  });

  it('docxToPdf returns PDF bytes', async () => {
    const mock = fakeConverter();
    setDocxConverterForTests(mock);
    const conv = getDocxConverter();
    const pdf = await conv.docxToPdf(new Uint8Array(7));
    // %PDF magic from the mock.
    expect(Array.from(pdf.subarray(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(mock.pdfCalls).toBe(1);
  });

  it('passing null restores the default (non-mock) resolver', () => {
    const mock = fakeConverter();
    setDocxConverterForTests(mock);
    expect(getDocxConverter()).toBe(mock);
    setDocxConverterForTests(null);
    expect(getDocxConverter()).not.toBe(mock);
  });

  it('a converter that throws ApiError(400) surfaces (timeout-equivalent path)', async () => {
    const { ApiError } = await import('@/server/http/errors');
    setDocxConverterForTests({
      async docxToMarkdown() {
        throw new ApiError('validation_error', 'DOCX 转换超时（60s）', 400);
      },
      async docxToPdf() {
        throw new ApiError('validation_error', 'DOCX 转换超时（60s）', 400);
      },
    });
    const conv = getDocxConverter();
    await expect(conv.docxToMarkdown(new Uint8Array(1))).rejects.toMatchObject({ status: 400 });
  });

  it('exposes a finite conversion timeout bound (60s, wider than PDF 30s)', () => {
    expect(CONVERT_TIMEOUT_MS).toBe(60_000);
  });

  it('default converter is constructed lazily — no conversion runs at getter call', () => {
    // getDocxConverter() must NOT spawn/probe — it only returns an object whose
    // methods would (when called) do the work. Calling the getter without
    // invoking a method must not touch the process: a real spawn here would hang
    // the no-DB partition. We assert the returned value is a usable converter with
    // both methods, and that merely getting it did not throw / block.
    const conv = getDocxConverter();
    expect(typeof conv.docxToMarkdown).toBe('function');
    expect(typeof conv.docxToPdf).toBe('function');
  });
});
