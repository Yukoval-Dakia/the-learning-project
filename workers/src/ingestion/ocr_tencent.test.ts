import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recognizeDocument } from './ocr_tencent';

const env = {
  TENCENT_SECRET_ID: 'AKID0000',
  TENCENT_SECRET_KEY: 'TEST_SECRET',
  TENCENT_OCR_REGION: 'ap-guangzhou',
};

const fakeImageBytes = new TextEncoder().encode('IMG_BYTES_PNG').buffer as ArrayBuffer;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000); // 2023-11-14 UTC
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recognizeDocument — EduPaperOCR happy path', () => {
  it('signs request, parses Response, normalizes regions', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          Response: {
            QuestionBlockInfos: [
              {
                QuestionArr: [
                  {
                    Position: { X: 100, Y: 200, Width: 400, Height: 50 },
                    ResultList: [{ Question: { Text: 'Q1: 解释"之"的用法。', Confidence: 95 } }],
                  },
                ],
              },
            ],
            RequestId: 'req-123',
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await recognizeDocument(fakeImageBytes, 'image/png', 0, env, {
      action: 'EduPaperOCR',
      imageDimensions: { width: 1000, height: 1000 },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = call[0];
    const init = call[1];
    expect(url).toBe('https://ocr.tencentcloudapi.com/');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('EduPaperOCR');
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
    expect(headers['authorization']).toMatch(/^TC3-HMAC-SHA256 Credential=AKID0000\//);

    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].text).toBe('Q1: 解释"之"的用法。');
    expect(out.regions[0].confidence).toBeCloseTo(0.95, 2);
    expect(out.regions[0].bbox.x).toBeCloseTo(0.1, 5);
    expect(out.regions[0].bbox.y).toBeCloseTo(0.2, 5);
    expect(out.regions[0].bbox.width).toBeCloseTo(0.4, 5);
    expect(out.regions[0].bbox.height).toBeCloseTo(0.05, 5);
    expect(out.regions[0].page_index).toBe(0);
    expect(out.regions[0].type).toBe('question');
    expect(out.raw_response).toBeDefined();
  });
});

describe('recognizeDocument — error paths', () => {
  it('throws on Tencent error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            Response: { Error: { Code: 'AuthFailure', Message: 'invalid secret' } },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      recognizeDocument(fakeImageBytes, 'image/png', 0, env, {
        action: 'EduPaperOCR',
        imageDimensions: { width: 100, height: 100 },
      }),
    ).rejects.toThrow(/AuthFailure/);
  });

  it('throws on non-200 HTTP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(
      recognizeDocument(fakeImageBytes, 'image/png', 0, env, {
        action: 'EduPaperOCR',
        imageDimensions: { width: 100, height: 100 },
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('GeneralAccurateOCR action normalizes TextDetections', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            Response: {
              TextDetections: [
                {
                  DetectedText: 'foo bar',
                  Confidence: 88,
                  ItemPolygon: { X: 50, Y: 50, Width: 100, Height: 20 },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const out = await recognizeDocument(fakeImageBytes, 'image/png', 2, env, {
      action: 'GeneralAccurateOCR',
      imageDimensions: { width: 1000, height: 200 },
    });
    expect(out.regions).toHaveLength(1);
    expect(out.regions[0].text).toBe('foo bar');
    expect(out.regions[0].type).toBe('text');
    expect(out.regions[0].page_index).toBe(2);
    expect(out.regions[0].bbox.x).toBeCloseTo(0.05, 5);
    expect(out.regions[0].bbox.height).toBeCloseTo(0.1, 5);
  });

  it('returns empty regions when EduPaperOCR has 0 blocks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ Response: { QuestionBlockInfos: [] } }), { status: 200 }),
      ),
    );
    const out = await recognizeDocument(fakeImageBytes, 'image/png', 0, env, {
      action: 'EduPaperOCR',
      imageDimensions: { width: 100, height: 100 },
    });
    expect(out.regions).toEqual([]);
  });
});
