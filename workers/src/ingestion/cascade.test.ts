import { describe, expect, it, vi } from 'vitest';
import { type CascadeDeps, runOCRCascade } from './cascade';

const env = {
  TENCENT_SECRET_ID: 'AKID',
  TENCENT_SECRET_KEY: 'SK',
  TENCENT_OCR_REGION: 'ap-guangzhou',
} as never;

const imageBytes = new ArrayBuffer(8);

function depsWith(overrides: Partial<CascadeDeps>): CascadeDeps {
  return {
    recognizeDocument: vi.fn(async () => ({ regions: [], raw_response: null })),
    runTaskFn: vi.fn(async () => ({ text: '{"blocks":[]}' })),
    imageDimensions: { width: 1000, height: 1000 },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('runOCRCascade — Tier 1 happy', () => {
  it('returns tier 1 when EduPaperOCR yields good regions', async () => {
    const recognize = vi.fn(async () => ({
      regions: [
        {
          bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
          text: '题目正文',
          type: 'question' as const,
          confidence: 0.92,
          page_index: 0,
        },
      ],
      raw_response: { ok: true },
    }));
    const runTaskFn = vi.fn();
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.final_status).toBe('extracted');
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].extracted_prompt_md).toBe('题目正文');
    expect(out.blocks[0].extraction_confidence).toBeCloseTo(0.92, 2);
    expect(out.tier_log).toHaveLength(1);
    expect(out.tier_log[0].tier).toBe(1);
    expect(out.tier_log[0].blocks_count).toBe(1);
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(
      (
        recognize.mock.calls[0] as unknown as [
          unknown,
          unknown,
          unknown,
          unknown,
          { action: string },
        ]
      )[4].action,
    ).toBe('EduPaperOCR');
  });
});

describe('runOCRCascade — escalations', () => {
  it('Tier 1 0-region edu → calls general → still 0 → escalate to Tier 2 haiku', async () => {
    const recognize = vi.fn(
      async (_b: unknown, _m: unknown, _p: unknown, _e: unknown, opts: { action?: string }) => ({
        regions: [], // both edu and general return empty
        raw_response: { action: opts.action },
      }),
    );
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        blocks: [
          {
            extracted_prompt_md: 'haiku found this',
            reference_md: null,
            wrong_answer_md: null,
            page_index: 0,
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            role: 'prompt',
            visual_complexity: 'low',
            extraction_confidence: 0.7,
            knowledge_hint: null,
          },
        ],
      }),
    }));
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.final_status).toBe('extracted');
    expect(out.blocks[0].extracted_prompt_md).toBe('haiku found this');
    expect(out.tier_log).toHaveLength(2);
    expect(out.tier_log[0].tier).toBe(1);
    expect(out.tier_log[0].blocks_count).toBe(0);
    expect(out.tier_log[1].tier).toBe(2);
    expect(recognize).toHaveBeenCalledTimes(2); // edu + general
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect((runTaskFn.mock.calls[0] as unknown as [string])[0]).toBe('VisionExtractTask');
  });

  it('Tier 1 below threshold escalates even with regions present', async () => {
    const recognize = vi.fn(async () => ({
      regions: [
        {
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          text: 'low conf garbage',
          type: 'question' as const,
          confidence: 0.4,
          page_index: 0,
        },
      ],
      raw_response: null,
    }));
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        blocks: [
          {
            extracted_prompt_md: 'haiku rescue',
            reference_md: null,
            wrong_answer_md: null,
            page_index: 0,
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            role: 'prompt',
            visual_complexity: 'low',
            extraction_confidence: 0.85,
            knowledge_hint: null,
          },
        ],
      }),
    }));
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.blocks[0].extracted_prompt_md).toBe('haiku rescue');
    expect(out.tier_log[0].tier).toBe(1);
    expect(out.tier_log[0].blocks_count).toBe(1); // edu had 1 region
    expect(out.tier_log[0].confidence_avg).toBeCloseTo(0.4, 2);
  });

  it('Tier 1 → Tier 2 (0) → Tier 3 (1) → extracted', async () => {
    const recognize = vi.fn(async () => ({ regions: [], raw_response: null }));
    let call = 0;
    const runTaskFn = vi.fn(async (kind: string) => {
      call += 1;
      if (kind === 'VisionExtractTask') return { text: JSON.stringify({ blocks: [] }) };
      // sonnet
      return {
        text: JSON.stringify({
          blocks: [
            {
              extracted_prompt_md: 'sonnet found',
              reference_md: null,
              wrong_answer_md: null,
              page_index: 0,
              bbox: { x: 0, y: 0, width: 1, height: 1 },
              role: 'prompt',
              visual_complexity: 'high',
              extraction_confidence: 0.9,
              knowledge_hint: null,
            },
          ],
        }),
      };
    });
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.blocks[0].extracted_prompt_md).toBe('sonnet found');
    expect(out.tier_log).toHaveLength(3);
    expect(out.tier_log[2].tier).toBe(3);
    expect(call).toBe(2);
  });

  it('all tiers fail → final_status=failed, blocks=[]', async () => {
    const recognize = vi.fn(async () => ({ regions: [], raw_response: null }));
    const runTaskFn = vi.fn(async () => {
      throw new Error('LLM is down');
    });
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.final_status).toBe('failed');
    expect(out.blocks).toEqual([]);
    expect(out.tier_log).toHaveLength(3);
    expect(out.tier_log[1].reason).toBe('LLM is down');
    expect(out.tier_log[2].reason).toBe('LLM is down');
  });

  it('Tier 1 throws → records reason, continues to Tier 2', async () => {
    const recognize = vi.fn(async () => {
      throw new Error('Tencent AuthFailure');
    });
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        blocks: [
          {
            extracted_prompt_md: 'haiku ok',
            reference_md: null,
            wrong_answer_md: null,
            page_index: 0,
            bbox: { x: 0, y: 0, width: 1, height: 1 },
            role: 'prompt',
            visual_complexity: 'low',
            extraction_confidence: 0.7,
            knowledge_hint: null,
          },
        ],
      }),
    }));
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.final_status).toBe('extracted');
    expect(out.tier_log[0].reason).toContain('Tencent AuthFailure');
    expect(out.tier_log[0].blocks_count).toBe(0);
    expect(out.blocks[0].extracted_prompt_md).toBe('haiku ok');
  });

  it('Tier 1 confidence exactly 0.6 → keeps tier 1 (>= threshold)', async () => {
    const recognize = vi.fn(async () => ({
      regions: [
        {
          bbox: { x: 0, y: 0, width: 1, height: 1 },
          text: 'borderline',
          type: 'question' as const,
          confidence: 0.6,
          page_index: 0,
        },
      ],
      raw_response: null,
    }));
    const runTaskFn = vi.fn();
    const out = await runOCRCascade({
      imageBytes,
      mimeType: 'image/png',
      pageIndex: 0,
      env,
      deps: depsWith({ recognizeDocument: recognize, runTaskFn }),
    });
    expect(out.final_status).toBe('extracted');
    expect(out.tier_log).toHaveLength(1);
    expect(out.tier_log[0].confidence_avg).toBeCloseTo(0.6, 5);
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});
