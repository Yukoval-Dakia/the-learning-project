import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { ingestion, setIngestionRunTaskForTests } from './ingestion';

type SourceAssetRow = { id: string; storage_key: string; mime_type: string };

function makeVisionBlock(pageIndex: number, seed = 'a') {
  return {
    extracted_prompt_md: `Q ${seed}`,
    reference_md: null,
    wrong_answer_md: null,
    page_index: pageIndex,
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    role: 'prompt',
    visual_complexity: 'low',
    extraction_confidence: 0.9,
    knowledge_hint: null,
    _input_page_index: pageIndex,
  };
}

function makeVisionOutput(pageIndex: number, seed = 'a') {
  return JSON.stringify({ blocks: [makeVisionBlock(pageIndex, seed)] });
}

function mockEnv(opts: {
  sourceAssetRows?: Map<string, SourceAssetRow>;
  r2Missing?: Set<string>;
} = {}) {
  const assetRows = opts.sourceAssetRows ?? new Map();
  const r2Missing = opts.r2Missing ?? new Set();
  const calls: Array<{ sql: string; binds: unknown[] }> = [];

  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/select id, storage_key, mime_type from source_asset where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return assetRows.get(id) ?? null;
          }
          return null;
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
      };
    },
  }));

  const db = {
    prepare,
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      const results: unknown[] = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;

  const waitUntilFns: Array<Promise<unknown>> = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => { waitUntilFns.push(p); },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const IMAGES = {
    get: vi.fn(async (storageKey: string) => {
      if (r2Missing.has(storageKey)) return null;
      return { arrayBuffer: async () => new ArrayBuffer(8) };
    }),
    put: vi.fn(async () => null),
  } as unknown as R2Bucket;

  return {
    Bindings: { DB: db, IMAGES, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
    executionCtx,
    calls,
    waitUntilFns,
  };
}

function makeRequest(body: unknown) {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

describe('POST /api/ingestion', () => {
  const visionCallArgs: Array<{ kind: string; input: unknown }> = [];

  beforeEach(() => {
    visionCallArgs.length = 0;
    setIngestionRunTaskForTests(async (kind, input) => {
      visionCallArgs.push({ kind, input });
      const inp = input as { text: string };
      const match = inp.text.match(/page_index=(\d+)/);
      const pageIndex = match ? parseInt(match[1], 10) : 0;
      return { text: makeVisionOutput(pageIndex, String(pageIndex)) };
    });
  });

  it('happy path 2 assets: inserts session + doc + 2 blocks, returns extracted status', async () => {
    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_1', { id: 'asset_1', storage_key: 'sk_1', mime_type: 'image/png' }],
      ['asset_2', { id: 'asset_2', storage_key: 'sk_2', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx, calls } = mockEnv({ sourceAssetRows: assetRows });

    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { id: string; source_document_id: string; status: string; source_asset_ids: string[]; entrypoint: string };
      blocks: Array<{ block_id: string; source_block_ids: string[] }>;
    };

    expect(body.session.status).toBe('extracted');
    expect(body.session.entrypoint).toBe('vision_single');
    expect(body.session.source_asset_ids).toEqual(['asset_1', 'asset_2']);
    expect(body.blocks).toHaveLength(2);
    for (const block of body.blocks) {
      expect(block.block_id).toBeTruthy();
      expect(block.source_block_ids).toEqual([block.block_id]);
    }

    expect(calls.some((c) => /insert into source_document/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /insert into ingestion_session/i.test(c.sql))).toBe(true);
    expect(calls.filter((c) => /insert into question_block/i.test(c.sql))).toHaveLength(2);
    expect(visionCallArgs).toHaveLength(2);
  });

  it('unknown asset_id returns 400 with the missing id, no R2 reads no vision calls no session insert', async () => {
    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_real', { id: 'asset_real', storage_key: 'sk_r', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx, calls } = mockEnv({ sourceAssetRows: assetRows });

    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_real', 'asset_missing'] }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/asset_missing/);
    expect(calls.some((c) => /insert into/i.test(c.sql))).toBe(false);
    expect(visionCallArgs).toHaveLength(0);
  });

  it('one R2 object missing: returns 200, blocks from second asset only, status extracted', async () => {
    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_1', { id: 'asset_1', storage_key: 'sk_1', mime_type: 'image/png' }],
      ['asset_2', { id: 'asset_2', storage_key: 'sk_2', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx } = mockEnv({
      sourceAssetRows: assetRows,
      r2Missing: new Set(['sk_1']),
    });

    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('extracted');
    expect(body.blocks).toHaveLength(1);
    expect(visionCallArgs).toHaveLength(1);
  });

  it('all R2 missing: returns 200, blocks=[], status=failed', async () => {
    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_1', { id: 'asset_1', storage_key: 'sk_1', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx } = mockEnv({
      sourceAssetRows: assetRows,
      r2Missing: new Set(['sk_1']),
    });

    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_1'] }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('failed');
    expect(body.blocks).toHaveLength(0);
  });

  it('all vision throw: returns 200, blocks=[], status=failed', async () => {
    setIngestionRunTaskForTests(async () => { throw new Error('ai exploded'); });

    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_1', { id: 'asset_1', storage_key: 'sk_1', mime_type: 'image/png' }],
      ['asset_2', { id: 'asset_2', storage_key: 'sk_2', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx } = mockEnv({ sourceAssetRows: assetRows });

    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('failed');
    expect(body.blocks).toHaveLength(0);
  });

  it('vision throws for first, succeeds for second: status=extracted, blocks from second', async () => {
    let callCount = 0;
    setIngestionRunTaskForTests(async (_kind, input) => {
      callCount++;
      if (callCount === 1) throw new Error('first asset exploded');
      const inp = input as { text: string };
      const match = inp.text.match(/page_index=(\d+)/);
      const pageIndex = match ? parseInt(match[1], 10) : 0;
      return { text: makeVisionOutput(pageIndex, String(pageIndex)) };
    });

    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_1', { id: 'asset_1', storage_key: 'sk_1', mime_type: 'image/png' }],
      ['asset_2', { id: 'asset_2', storage_key: 'sk_2', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx } = mockEnv({ sourceAssetRows: assetRows });

    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { status: string }; blocks: unknown[] };
    expect(body.session.status).toBe('extracted');
    expect(body.blocks).toHaveLength(1);
  });

  it('page_index injection: first asset gets pageIndex=0, second gets pageIndex=1', async () => {
    const capturedInputs: Array<{ text: string }> = [];
    setIngestionRunTaskForTests(async (_kind, input) => {
      const inp = input as { text: string };
      capturedInputs.push(inp);
      const match = inp.text.match(/page_index=(\d+)/);
      const pageIndex = match ? parseInt(match[1], 10) : 0;
      return { text: makeVisionOutput(pageIndex, String(pageIndex)) };
    });

    const assetRows = new Map<string, SourceAssetRow>([
      ['asset_1', { id: 'asset_1', storage_key: 'sk_1', mime_type: 'image/png' }],
      ['asset_2', { id: 'asset_2', storage_key: 'sk_2', mime_type: 'image/png' }],
    ]);
    const { Bindings, executionCtx } = mockEnv({ sourceAssetRows: assetRows });

    await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['asset_1', 'asset_2'] }),
      Bindings,
      executionCtx,
    );

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[0].text).toMatch(/page_index=0/);
    expect(capturedInputs[1].text).toMatch(/page_index=1/);
  });

  it('body validation: empty asset_ids → 400', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: [] }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
  });

  it('body validation: asset_ids over max (6) → 400', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'vision_single', asset_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
  });

  it('body validation: invalid entrypoint → 400', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await ingestion.request(
      '/',
      makeRequest({ entrypoint: 'not_valid', asset_ids: ['a'] }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
  });
});
