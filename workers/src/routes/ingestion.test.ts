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

// =================== POST /api/ingestion/:id/import ===================

type SessionRow = {
  id: string;
  source_document_id: string | null;
  source_asset_ids: string;
  status: string;
  entrypoint: string;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  version: number;
};

type QuestionBlockRow = {
  id: string;
  ingestion_session_id: string;
  source_document_id: string | null;
  source_asset_ids: string;
  page_spans: string;
  extracted_prompt_md: string;
  reference_md: string | null;
  wrong_answer_md: string | null;
  image_refs: string;
  crop_refs: string;
  visual_complexity: string;
  extraction_confidence: number;
  status: string;
  knowledge_hint: string | null;
  merged_from_block_ids: string;
  imported_question_id: string | null;
  imported_mistake_id: string | null;
  created_at: number;
  updated_at: number;
  version: number;
};

function mockImportEnv(opts: {
  session?: SessionRow | null;
  questionBlocks?: Map<string, QuestionBlockRow>;
  knowledgeIds?: string[];
} = {}) {
  const session = opts.session !== undefined ? opts.session : null;
  const blocks = opts.questionBlocks ?? new Map<string, QuestionBlockRow>();
  const knowledgeSet = new Set(opts.knowledgeIds ?? []);
  const calls: Array<{ sql: string; binds: unknown[] }> = [];

  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/select \* from ingestion_session where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return session && session.id === id ? session : null;
          }
          if (/select \* from question_block where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return blocks.get(id) ?? null;
          }
          if (/select id from knowledge where id = \? and archived_at is null/i.test(sql)) {
            const id = binds[0] as string;
            return knowledgeSet.has(id) ? { id } : null;
          }
          return null;
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        all: async () => {
          if (/select id, name, domain, parent_id, archived_at from knowledge/i.test(sql)) {
            const rows = Array.from(knowledgeSet).map((id) => ({
              id,
              name: `K-${id}`,
              domain: 'wenyan',
              parent_id: null,
              archived_at: null,
            }));
            return { results: rows };
          }
          return { results: [] };
        },
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
    waitUntil: (p: Promise<unknown>) => {
      waitUntilFns.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  const IMAGES = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => null),
  } as unknown as R2Bucket;

  return {
    Bindings: { DB: db, IMAGES, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
    executionCtx,
    calls,
    waitUntilFns,
  };
}

function makeBlockRow(overrides: Partial<QuestionBlockRow>): QuestionBlockRow {
  return {
    id: overrides.id ?? 'block_a',
    ingestion_session_id: overrides.ingestion_session_id ?? 'sess_1',
    source_document_id: overrides.source_document_id ?? 'doc_1',
    source_asset_ids: overrides.source_asset_ids ?? '["asset_1"]',
    page_spans: overrides.page_spans ?? '[{"page_index":0,"bbox":{"x":0,"y":0,"width":1,"height":1},"role":"prompt"}]',
    extracted_prompt_md: overrides.extracted_prompt_md ?? 'Q text',
    reference_md: overrides.reference_md ?? null,
    wrong_answer_md: overrides.wrong_answer_md ?? null,
    image_refs: overrides.image_refs ?? '["asset_1"]',
    crop_refs: overrides.crop_refs ?? '[]',
    visual_complexity: overrides.visual_complexity ?? 'low',
    extraction_confidence: overrides.extraction_confidence ?? 0.9,
    status: overrides.status ?? 'draft',
    knowledge_hint: overrides.knowledge_hint ?? null,
    merged_from_block_ids: overrides.merged_from_block_ids ?? '[]',
    imported_question_id: overrides.imported_question_id ?? null,
    imported_mistake_id: overrides.imported_mistake_id ?? null,
    created_at: overrides.created_at ?? 1700000000,
    updated_at: overrides.updated_at ?? 1700000000,
    version: overrides.version ?? 0,
  };
}

function makeSessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: overrides.id ?? 'sess_1',
    source_document_id: overrides.source_document_id ?? 'doc_1',
    source_asset_ids: overrides.source_asset_ids ?? '["asset_1"]',
    status: overrides.status ?? 'extracted',
    entrypoint: overrides.entrypoint ?? 'vision_single',
    error_message: overrides.error_message ?? null,
    created_at: overrides.created_at ?? 1700000000,
    updated_at: overrides.updated_at ?? 1700000000,
    version: overrides.version ?? 0,
  };
}

function makeImportRequest(body: unknown) {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

describe('POST /api/ingestion/:id/import', () => {
  beforeEach(() => {
    setIngestionRunTaskForTests(async () => ({ text: '{}' }));
  });

  it('unchanged card happy path: cause=null → 2 waitUntils, inserts 1 question + 1 mistake, UPDATE block + session', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q final',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(1);
    expect(body.mistake_ids).toHaveLength(1);

    expect(calls.filter((c) => /insert into question \(/i.test(c.sql))).toHaveLength(1);
    expect(calls.filter((c) => /insert into mistake/i.test(c.sql))).toHaveLength(1);
    expect(calls.filter((c) => /update question_block/i.test(c.sql)).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => /update ingestion_session/i.test(c.sql))).toHaveLength(1);

    expect(waitUntilFns).toHaveLength(2);
  });

  it('cause provided → only propose waitUntil (1)', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: { primary_category: 'concept', user_notes: 'n' },
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    expect(waitUntilFns).toHaveLength(1);
  });

  it('knowledge_ids missing/archived → 400, NO inserts, no waitUntils', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'], // k_missing not in set
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k_missing'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /insert into mistake/i.test(c.sql))).toBe(false);
    expect(waitUntilFns).toHaveLength(0);
  });

  it('session not found → 404', async () => {
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: null,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/missing_sess/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(404);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
  });

  it('source_block_ids contains block from another session → 400, NO inserts', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a', ingestion_session_id: 'OTHER_SESSION' }));
    const { Bindings, executionCtx, calls, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /insert into mistake/i.test(c.sql))).toBe(false);
    expect(waitUntilFns).toHaveLength(0);
  });

  it('merged virtual card: INSERT new question_block with merged_from_block_ids, UPDATE source blocks to ignored', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    blocks.set('block_b', makeBlockRow({ id: 'block_b' }));
    const { Bindings, executionCtx, calls, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({ source_asset_ids: '["asset_1","asset_2"]' }),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            // No block_id → virtual merged card
            source_block_ids: ['block_a', 'block_b'],
            page_spans: [
              { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
              { page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 0.5 }, role: 'continuation' },
            ],
            image_refs: ['asset_1', 'asset_2'],
            final_prompt_md: 'Merged Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(1);
    expect(body.mistake_ids).toHaveLength(1);

    // Should INSERT 1 NEW question_block (the virtual merged card)
    const insertBlockCalls = calls.filter((c) => /insert into question_block/i.test(c.sql));
    expect(insertBlockCalls).toHaveLength(1);
    // Verify the merged_from_block_ids bind for the new block
    const newBlockBinds = insertBlockCalls[0].binds as unknown[];
    const mergedFromIdsBind = newBlockBinds.find(
      (b) => typeof b === 'string' && b.includes('block_a') && b.includes('block_b'),
    );
    expect(mergedFromIdsBind).toBeDefined();
    expect(JSON.parse(mergedFromIdsBind as string)).toEqual(['block_a', 'block_b']);

    // Source blocks block_a + block_b should be UPDATEd to status='ignored'
    const updateBlockCalls = calls.filter((c) => /update question_block/i.test(c.sql));
    const ignoreUpdates = updateBlockCalls.filter((c) =>
      c.binds.some((b) => b === 'ignored'),
    );
    expect(ignoreUpdates).toHaveLength(2);
    const ignoredIds = ignoreUpdates.map((c) => c.binds[c.binds.length - 1] as string).sort();
    expect(ignoredIds).toEqual(['block_a', 'block_b']);

    // Should INSERT 1 question + 1 mistake; queue 2 waitUntils (cause=null)
    expect(calls.filter((c) => /insert into question \(/i.test(c.sql))).toHaveLength(1);
    expect(calls.filter((c) => /insert into mistake/i.test(c.sql))).toHaveLength(1);
    expect(waitUntilFns).toHaveLength(2);
  });

  it('split: 2 virtual cards sharing source_block_id → 2 new question_blocks, source UPDATEd ignored once, 2 questions + 2 mistakes', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            // No block_id, source_block_ids contains shared source
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 0.5, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q1 split',
            final_reference_md: null,
            final_wrong_answer_md: 'WA1',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
          {
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0.5, y: 0, width: 0.5, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q2 split',
            final_reference_md: null,
            final_wrong_answer_md: 'WA2',
            knowledge_ids: ['k1'],
            cause: { primary_category: 'concept', user_notes: null },
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(2);
    expect(body.mistake_ids).toHaveLength(2);

    // 2 NEW question_block inserts
    expect(calls.filter((c) => /insert into question_block/i.test(c.sql))).toHaveLength(2);
    // 2 question + 2 mistake INSERTs
    expect(calls.filter((c) => /insert into question \(/i.test(c.sql))).toHaveLength(2);
    expect(calls.filter((c) => /insert into mistake/i.test(c.sql))).toHaveLength(2);

    // Source block 'block_a' should be UPDATEd to ignored exactly once
    const ignoreUpdates = calls.filter(
      (c) => /update question_block/i.test(c.sql) && c.binds.some((b) => b === 'ignored'),
    );
    expect(ignoreUpdates).toHaveLength(1);
    expect(ignoreUpdates[0].binds[ignoreUpdates[0].binds.length - 1]).toBe('block_a');
  });

  it('unchanged card whose block_id is also in another card source_block_ids → NOT marked ignored', async () => {
    // Card 1: unchanged for block_a (block_id=block_a)
    // Card 2: virtual using block_a as source
    // block_a should NOT be marked ignored (the unchanged import wins)
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q unchanged',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: { primary_category: 'concept', user_notes: null },
            difficulty: 3,
            question_kind: 'short_answer',
          },
          {
            // Virtual card sharing block_a as source
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 0.5, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q virtual',
            final_reference_md: null,
            final_wrong_answer_md: 'WA2',
            knowledge_ids: ['k1'],
            cause: { primary_category: 'concept', user_notes: null },
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);

    // block_a should NOT be UPDATEd to 'ignored' (unchanged import wins)
    const ignoreUpdates = calls.filter(
      (c) => /update question_block/i.test(c.sql) && c.binds.some((b) => b === 'ignored'),
    );
    expect(ignoreUpdates).toHaveLength(0);
  });

  it('rejects image_ref not in session.source_asset_ids → 400, NO inserts', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({ source_asset_ids: '["asset_1"]' }),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_FOREIGN'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/image_ref asset_FOREIGN/);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /insert into mistake/i.test(c.sql))).toBe(false);
    expect(waitUntilFns).toHaveLength(0);
  });

  it('rejects block_id not in source_block_ids → 400, NO inserts', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    blocks.set('block_b', makeBlockRow({ id: 'block_b' }));
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_b'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
  });

  it('rejects unknown source_block_id (no row at all) → 400', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    // No block_a row in session — DB returns null
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({}),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            source_block_ids: ['block_NEVER_EXISTED'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
  });

  it('rejects page_index out of session asset range → 400', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({ source_asset_ids: '["asset_1"]' }),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            // session has 1 asset → page_index 5 is out of range
            page_spans: [{ page_index: 5, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/page_index 5 out of range/);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
  });

  it('rejects re-import: session already in status=imported → 409', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls, waitUntilFns } = mockImportEnv({
      session: makeSessionRow({ status: 'imported' }),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
            image_refs: ['asset_1'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(409);
    expect(calls.some((c) => /insert into question \(/i.test(c.sql))).toBe(false);
    expect(calls.some((c) => /insert into mistake/i.test(c.sql))).toBe(false);
    expect(waitUntilFns).toHaveLength(0);
  });

  it('preserves high visual_complexity when merging from any high source block', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_low', makeBlockRow({ id: 'block_low', visual_complexity: 'low' }));
    blocks.set('block_high', makeBlockRow({ id: 'block_high', visual_complexity: 'high' }));
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({ source_asset_ids: '["asset_1","asset_2"]' }),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            // virtual merged card
            source_block_ids: ['block_low', 'block_high'],
            page_spans: [
              { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
              { page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 0.5 }, role: 'continuation' },
            ],
            image_refs: ['asset_1', 'asset_2'],
            final_prompt_md: 'Merged Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: null,
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const insertBlock = calls.find((c) => /insert into question_block/i.test(c.sql));
    expect(insertBlock).toBeDefined();
    expect((insertBlock!.binds as unknown[]).includes('high')).toBe(true);
  });

  it('wrong_answer_image_refs derived from page_spans where role=answer_area', async () => {
    const blocks = new Map<string, QuestionBlockRow>();
    blocks.set('block_a', makeBlockRow({ id: 'block_a' }));
    const { Bindings, executionCtx, calls } = mockImportEnv({
      session: makeSessionRow({ source_asset_ids: '["asset_p","asset_a"]' }),
      questionBlocks: blocks,
      knowledgeIds: ['k1'],
    });

    const res = await ingestion.request(
      '/sess_1/import',
      makeImportRequest({
        blocks: [
          {
            block_id: 'block_a',
            source_block_ids: ['block_a'],
            page_spans: [
              { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
              { page_index: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'answer_area' },
            ],
            image_refs: ['asset_p', 'asset_a'],
            final_prompt_md: 'Q',
            final_reference_md: null,
            final_wrong_answer_md: 'WA',
            knowledge_ids: ['k1'],
            cause: { primary_category: 'concept', user_notes: null },
            difficulty: 3,
            question_kind: 'short_answer',
          },
        ],
      }),
      Bindings,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const insertMistake = calls.find((c) => /insert into mistake/i.test(c.sql));
    expect(insertMistake).toBeDefined();
    const wrongRefsBind = (insertMistake!.binds as unknown[]).find(
      (b) => typeof b === 'string' && b.startsWith('[') && b.includes('asset_a') && !b.includes('asset_p'),
    );
    expect(wrongRefsBind).toBeDefined();
    expect(JSON.parse(wrongRefsBind as string)).toEqual(['asset_a']);
  });
});
