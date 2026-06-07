import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import mathPage1 from '../../../tests/fixtures/glm-ocr/math-page1.json';
import { type GlmLayoutResponse, runGlmLayoutParsing } from './glm_ocr';

// YUK-253 — GLM-OCR layout_parsing client. Pure no-DB unit: global `fetch` is
// mocked so NO live API is ever hit. Covers data-URI assembly, the JSON body +
// bearer header, the missing-key fail-fast, error normalization (1214 / 401 /
// 429 / 5xx / abort), and usage passthrough.

const ORIGINAL_KEY = process.env.ZHIPU_API_KEY;

function mockFetchOnce(init: {
  ok?: boolean;
  status?: number;
  json: () => unknown;
}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => init.json(),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  process.env.ZHIPU_API_KEY = 'test-zhipu-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.ZHIPU_API_KEY = ORIGINAL_KEY;
});

describe('runGlmLayoutParsing', () => {
  it('builds a data URI + JSON body + bearer header, returns parsed usage', async () => {
    const fetchFn = mockFetchOnce({ json: () => mathPage1 });

    const resp = await runGlmLayoutParsing({
      imageBase64: 'QUJD', // "ABC"
      mediaType: 'image/png',
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/layout_parsing');
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer test-zhipu-key');

    const body = JSON.parse(opts.body as string) as { model: string; file: string };
    expect(body.model).toBe('glm-ocr');
    // JSON-only data URI (multipart / bare base64 are rejected by GLM).
    expect(body.file).toBe('data:image/png;base64,QUJD');

    // usage passthrough — the handler bills off these numbers.
    expect(resp.usage.prompt_tokens).toBe(1128);
    expect(resp.usage.completion_tokens).toBe(440);
    expect(resp.layout_details.length).toBe(1);
  });

  it('uses the caller mediaType in the data: prefix', async () => {
    const fetchFn = mockFetchOnce({ json: () => mathPage1 });
    await runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/jpeg' });
    const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { file: string };
    expect(body.file.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('throws PermanentError before any fetch when ZHIPU_API_KEY is missing', async () => {
    process.env.ZHIPU_API_KEY = '';
    const fetchFn = mockFetchOnce({ json: () => mathPage1 });

    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toThrow(/ZHIPU_API_KEY/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('maps GLM error code 1214 (bad data URI) → PermanentError', async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: () => ({ error: { code: '1214', message: '格式错误' } }),
    });
    await expect(
      runGlmLayoutParsing({ imageBase64: 'bad', mediaType: 'image/png' }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('maps HTTP 401 → PermanentError (auth never self-heals)', async () => {
    mockFetchOnce({ ok: false, status: 401, json: () => ({ error: { message: 'unauthorized' } }) });
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it('maps HTTP 429 → RetryableError (pg-boss retries)', async () => {
    mockFetchOnce({ ok: false, status: 429, json: () => ({ error: { message: 'rate limited' } }) });
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('maps HTTP 500 → RetryableError', async () => {
    mockFetchOnce({ ok: false, status: 500, json: () => ({ error: { message: 'server error' } }) });
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('maps an aborted/timed-out fetch → RetryableError', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abortErr;
      }),
    );
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png', timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('maps a network error → RetryableError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('throws PermanentError when a 2xx body is missing layout_details', async () => {
    mockFetchOnce({ json: () => ({ id: 'x', usage: {} }) as unknown as GlmLayoutResponse });
    await expect(
      runGlmLayoutParsing({ imageBase64: 'QUJD', mediaType: 'image/png' }),
    ).rejects.toThrow(/no layout_details/);
  });
});
