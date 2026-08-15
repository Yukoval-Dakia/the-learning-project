// YUK-230 (PR #1063 review, thread 2) — source-grounding verifier runner test.
//
// runSourceGroundingVerify is pure-logic once runTaskFn + imageFetchFn are stubbed
// (mirrors multimodal-direct-judge.test.ts). A throwaway Db cast suffices — the runner
// only forwards db to the stubs. No real R2 / model / DB is touched.

import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it } from 'vitest';
import { parseSourceGroundingResult, runSourceGroundingVerify } from './source-grounding-verify';

const mockDb = {} as Db;
const yuwenProfile = resolveSubjectProfile('yuwen');
const oneImage = async () => [{ data: 'AAA', mediaType: 'image/png' }];

function llmResponse(grounded: boolean, confidence = 0.8) {
  return {
    text: JSON.stringify({
      grounded,
      confidence,
      observed_md: '图片中可见题面对应内容',
      reason_md: grounded ? '题面出现在图片中' : '图片与题面无关',
    }),
  };
}

describe('runSourceGroundingVerify — verdict mapping', () => {
  it('grounded=true → status "grounded" (carries confidence + reason)', async () => {
    const result = await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: '「之」在「学而时习之」中作？',
      reference_md: '代词',
      sourceAssetId: 'asset-1',
      subjectProfile: yuwenProfile,
      runTaskFn: async () => llmResponse(true, 0.9),
      imageFetchFn: oneImage,
    });
    expect(result).toEqual({
      status: 'grounded',
      confidence: 0.9,
      observed_md: '图片中可见题面对应内容',
      reason_md: '题面出现在图片中',
    });
  });

  it('grounded=false (image unrelated → hallucination) → status "not_grounded"', async () => {
    const result = await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: '一道与图片无关的题',
      reference_md: null,
      sourceAssetId: 'asset-2',
      subjectProfile: yuwenProfile,
      runTaskFn: async () => llmResponse(false),
      imageFetchFn: oneImage,
    });
    expect(result.status).toBe('not_grounded');
  });

  it('passes the source asset id to the image fetcher and image_present:true to the LLM', async () => {
    let fetchedIds: string[] | undefined;
    let sentPayload: string | undefined;
    await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: 'p',
      reference_md: 'r',
      sourceAssetId: 'asset-src-x',
      subjectProfile: yuwenProfile,
      imageFetchFn: async (ids) => {
        fetchedIds = ids;
        return [{ data: 'AAA', mediaType: 'image/png' }];
      },
      runTaskFn: async (_kind, input) => {
        sentPayload = (input as { text: string }).text;
        return llmResponse(true);
      },
    });
    expect(fetchedIds).toEqual(['asset-src-x']);
    expect(sentPayload).toContain('"image_present":true');
    expect(sentPayload).toContain('"prompt_md":"p"');
  });
});

describe('runSourceGroundingVerify — transient bucket (NOT a content verdict)', () => {
  it('image fetch throws → transient_error', async () => {
    const result = await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: 'p',
      reference_md: null,
      sourceAssetId: 'asset-3',
      subjectProfile: yuwenProfile,
      imageFetchFn: async () => {
        throw new Error('R2 unavailable');
      },
      runTaskFn: async () => llmResponse(true),
    });
    expect(result.status).toBe('transient_error');
    if (result.status === 'transient_error') expect(result.message).toContain('R2 unavailable');
  });

  it('empty image set (asset resolves to no bytes) → transient_error, LLM never called', async () => {
    let called = false;
    const result = await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: 'p',
      reference_md: null,
      sourceAssetId: 'asset-missing',
      subjectProfile: yuwenProfile,
      imageFetchFn: async () => [],
      runTaskFn: async () => {
        called = true;
        return llmResponse(true);
      },
    });
    expect(result.status).toBe('transient_error');
    expect(called).toBe(false);
  });

  it('LLM call throws → transient_error', async () => {
    const result = await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: 'p',
      reference_md: null,
      sourceAssetId: 'asset-4',
      subjectProfile: yuwenProfile,
      imageFetchFn: oneImage,
      runTaskFn: async () => {
        throw new Error('vision model 503');
      },
    });
    expect(result.status).toBe('transient_error');
    if (result.status === 'transient_error') expect(result.message).toContain('vision model 503');
  });

  it('unparseable LLM output → transient_error (never a silent grounded/not_grounded)', async () => {
    const result = await runSourceGroundingVerify({
      db: mockDb,
      prompt_md: 'p',
      reference_md: null,
      sourceAssetId: 'asset-5',
      subjectProfile: yuwenProfile,
      imageFetchFn: oneImage,
      runTaskFn: async () => ({ text: 'not json at all' }),
    });
    expect(result.status).toBe('transient_error');
  });
});

describe('parseSourceGroundingResult — structured/text dispatch', () => {
  it('prefers structured_output when present (Zod-validated)', () => {
    const parsed = parseSourceGroundingResult({
      text: '{}',
      structured_output: {
        grounded: false,
        confidence: 0.3,
        observed_md: 'x',
        reason_md: 'unrelated',
      },
    });
    expect(parsed.grounded).toBe(false);
    expect(parsed.confidence).toBe(0.3);
  });

  it('falls back to char-scan text when structured_output is absent', () => {
    const parsed = parseSourceGroundingResult({
      text: 'prefix {"grounded":true,"confidence":0.7,"observed_md":"y","reason_md":"ok"} suffix',
    });
    expect(parsed.grounded).toBe(true);
    expect(parsed.reason_md).toBe('ok');
  });

  it('throws on a shape-invalid structured_output (constraint enforcement kept)', () => {
    expect(() =>
      parseSourceGroundingResult({
        text: '{}',
        // confidence out of [0,1] → Zod throws → caller maps to transient_error.
        structured_output: { grounded: true, confidence: 2, observed_md: 'x', reason_md: 'r' },
      }),
    ).toThrow();
  });

  it('throws on an empty observed_md (thread 6 — .min(1) matches the prompt contract)', () => {
    expect(() =>
      parseSourceGroundingResult({
        text: '{}',
        structured_output: { grounded: true, confidence: 0.8, observed_md: '', reason_md: 'r' },
      }),
    ).toThrow();
  });
});
