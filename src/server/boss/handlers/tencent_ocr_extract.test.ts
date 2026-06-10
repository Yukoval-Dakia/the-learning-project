import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermanentError } from '@/core/schema/structured_question';
import { db } from '@/db/client';
import {
  cost_ledger,
  event,
  job_events,
  learning_session,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import type { GlmLayoutResponse, runGlmLayoutParsing } from '@/capabilities/ingestion/server/glm_ocr';
import type { StructureResult, runStructureTask } from '@/capabilities/ingestion/server/structure';
import { StructureTaskError } from '@/capabilities/ingestion/server/structure';
import type { R2Client } from '@/server/r2';
import clozeFixture from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import { resetDb } from '../../../../tests/helpers/db';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

type GlmOcrFn = typeof runGlmLayoutParsing;
type RunStructureFn = typeof runStructureTask;

// YUK-253 — GLM-OCR is now the DEFAULT extraction engine. The handler injects
// `glmOcrFn`; tests stub it so no real GLM HTTP call happens. The layered
// semantics are unchanged (OC-1/OC-2): the VLM StructureTask owns structure; the
// GLM hint is demoted text. One Tencent-path test (engine:'tencent') keeps the
// retained rollback engine alive.

// A minimal single-page GLM layout_parsing response. The handler calls glmOcr
// once per page, each returning a single-page response. usage drives the
// cost_ledger (0.2 元/M, input=output).
function makeGlmResponse(opts?: {
  text?: string;
  promptTokens?: number;
  completionTokens?: number;
  withImageBlock?: boolean;
}): GlmLayoutResponse {
  const blocks: GlmLayoutResponse['layout_details'][number] = [
    {
      index: 1,
      label: 'text',
      native_label: 'paragraph',
      bbox_2d: [10, 10, 200, 60],
      content: opts?.text ?? 'GLM OCR hint text',
      width: 500,
      height: 700,
    },
  ];
  if (opts?.withImageBlock) {
    // image-label block OMITS content (matches the real GLM contract).
    blocks.unshift({
      index: 0,
      label: 'image',
      native_label: 'image',
      bbox_2d: [50, 100, 200, 300],
      width: 500,
      height: 700,
    } as GlmLayoutResponse['layout_details'][number][number]);
  }
  const promptTokens = opts?.promptTokens ?? 1000;
  const completionTokens = opts?.completionTokens ?? 200;
  return {
    id: 'glm-id',
    request_id: 'glm-req',
    data_info: { num_pages: 1, pages: [{ width: 500, height: 700 }] },
    layout_details: [blocks],
    md_results: opts?.text ?? 'GLM OCR hint text',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function makeGlmStub(resp?: GlmLayoutResponse): GlmOcrFn {
  return (async () => resp ?? makeGlmResponse()) as GlmOcrFn;
}

// Default VLM stub — returns a single standalone VLM-authored question (the
// structured tree of record).
function makeVlmStub(): RunStructureFn {
  return (async () =>
    ({
      questions: [
        {
          id: 'vlm-q-1',
          role: 'standalone',
          prompt_text: 'VLM structured prompt',
          source: 'vlm_structure',
        },
      ],
      layout_quality: 'structured',
      warnings: [],
    }) satisfies StructureResult) as RunStructureFn;
}

async function makeTestImage(): Promise<Buffer> {
  return sharp({
    create: { width: 500, height: 700, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .png()
    .toBuffer();
}

async function seedSessionWithAsset(): Promise<{
  sessionId: string;
  sourceDocId: string;
  assetId: string;
  assetIds: string[];
}> {
  const sourceDocId = createId();
  const sessionId = createId();
  const assetIds = [createId()];
  const assetId = assetIds[0];
  const now = new Date();

  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: assetIds,
    body_md: null,
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  await db.insert(source_asset).values({
    id: assetId,
    kind: 'image',
    storage_key: `test-key-${assetId}`,
    mime_type: 'image/png',
    byte_size: 1000,
    sha256: 'fake',
    width: 500,
    height: 700,
    provenance: {},
    created_at: now,
  });

  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocId,
    source_asset_ids: [assetId],
    status: 'queued',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  return { sessionId, sourceDocId, assetId, assetIds };
}

async function seedSessionWithAssets(assetCount: number): Promise<{
  sessionId: string;
  sourceDocId: string;
  assetIds: string[];
}> {
  const sourceDocId = createId();
  const sessionId = createId();
  const assetIds = Array.from({ length: assetCount }, () => createId());
  const now = new Date();

  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: assetIds,
    body_md: null,
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  await db.insert(source_asset).values(
    assetIds.map((assetId, index) => ({
      id: assetId,
      kind: 'image' as const,
      storage_key: `test-key-${assetId}`,
      mime_type: 'image/png',
      byte_size: 1000,
      sha256: `fake-${index}`,
      width: 500,
      height: 700,
      provenance: {},
      created_at: now,
    })),
  );

  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocId,
    source_asset_ids: assetIds,
    status: 'queued',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  return { sessionId, sourceDocId, assetIds };
}

async function cleanup(sessionId: string, sourceDocId: string, assetId: string | string[]) {
  const assetIds = Array.isArray(assetId) ? assetId : [assetId];
  await db.delete(event).where(eq(event.session_id, sessionId));
  await db.delete(job_events).where(eq(job_events.business_id, sessionId));
  await db.delete(question_block).where(eq(question_block.ingestion_session_id, sessionId));
  await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  for (const id of assetIds) {
    await db.delete(source_asset).where(eq(source_asset.id, id));
  }
  await db.delete(source_document).where(eq(source_document.id, sourceDocId));
}

function makeR2WithImage(image: Buffer): R2Client & { puts: { key: string; body: Uint8Array }[] } {
  const puts: { key: string; body: Uint8Array }[] = [];
  return {
    puts,
    async get() {
      return new Uint8Array(image);
    },
    async put(key, body) {
      puts.push({ key, body: new Uint8Array(body) });
    },
    async delete() {},
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetDb();
});

describe('tencent_ocr_extract handler (GLM default engine)', () => {
  it('GLM happy path: queued → extracted with VLM-owned block + GLM cost_ledger', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi.fn(
      makeGlmStub(makeGlmResponse({ promptTokens: 1128, completionTokens: 440 })),
    );
    const runStructureFn = makeVlmStub();

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn, runStructureFn });
    await handler([{ id: 'boss-job-1', data: { sessionId } } as never]);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('extracted');

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0].structured?.source).toBe('vlm_structure');
    // GLM OCR was the text + figure layer.
    expect(glmOcrFn).toHaveBeenCalledOnce();

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-1');
    expect(ours).toBeTruthy();
    expect(ours?.outcome).toBe('success');
    // YUK-253 cost accounting: provider 'glm', model 'glm-ocr', tokens passthrough,
    // cost = (1128+440)/1e6 * 0.2.
    expect(ours?.provider).toBe('glm');
    expect(ours?.model).toBe('glm-ocr');
    expect(ours?.tokens_in).toBe(1128);
    expect(ours?.tokens_out).toBe(440);
    expect(ours?.cost).toBeCloseTo(((1128 + 440) / 1_000_000) * 0.2, 10);

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('GLM path preserves per-page parser warnings before aggregate warnings', async () => {
    const { sessionId, sourceDocId, assetIds } = await seedSessionWithAssets(2);
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi
      .fn()
      .mockResolvedValueOnce(makeGlmResponse({ text: '   ' }))
      .mockResolvedValueOnce(makeGlmResponse({ text: 'second page text' })) as GlmOcrFn;
    const runStructureFn = makeVlmStub();

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn, runStructureFn });
    let costLedgerId: string | null = null;
    try {
      await handler([{ id: 'boss-job-glm-warnings', data: { sessionId } } as never]);

      const session = await db
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, sessionId));
      const warnings = session[0].warnings;
      const perPageIdx = warnings.indexOf('GLM returned no text blocks on any page');
      const aggregateIdx = warnings.indexOf('GLM: at least one page has only image/empty blocks');
      expect(perPageIdx).toBeGreaterThanOrEqual(0);
      expect(aggregateIdx).toBeGreaterThan(perPageIdx);

      const cost = await db.select().from(cost_ledger);
      const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-glm-warnings');
      costLedgerId = ours?.id ?? null;
    } finally {
      await cleanup(sessionId, sourceDocId, assetIds);
      if (costLedgerId) await db.delete(cost_ledger).where(eq(cost_ledger.id, costLedgerId));
    }
  });

  it('emits incremental extraction_progress job_events per page + a final structure event (Bug A)', async () => {
    const { sessionId, sourceDocId, assetIds } = await seedSessionWithAssets(2);
    const r2 = makeR2WithImage(await makeTestImage());
    const glmOcrFn = vi.fn().mockResolvedValue(makeGlmResponse({})) as GlmOcrFn;
    const runStructureFn = makeVlmStub();

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn, runStructureFn });
    let costLedgerId: string | null = null;
    try {
      await handler([{ id: 'boss-job-progress', data: { sessionId } } as never]);

      const jobEvents = await db
        .select()
        .from(job_events)
        .where(eq(job_events.business_id, sessionId))
        .orderBy(job_events.id);
      const progress = jobEvents.filter((e) => e.event_type === 'ingestion.extraction_progress');
      const ocr = progress.filter((e) => (e.payload as { stage?: string }).stage === 'ocr');
      const structure = progress.filter(
        (e) => (e.payload as { stage?: string }).stage === 'structure',
      );
      // One OCR progress per page (done 1..N over total=2), then one full-width
      // structure event right before the single slow VLM StructureTask.
      expect(ocr.map((e) => (e.payload as { done: number }).done)).toEqual([1, 2]);
      expect(ocr.every((e) => (e.payload as { total: number }).total === 2)).toBe(true);
      expect(structure).toHaveLength(1);
      expect((structure[0]?.payload as { done: number }).done).toBe(2);
      expect((structure[0]?.payload as { total: number }).total).toBe(2);

      const cost = await db.select().from(cost_ledger);
      costLedgerId = cost.find((c) => c.pgboss_job_id === 'boss-job-progress')?.id ?? null;
    } finally {
      await cleanup(sessionId, sourceDocId, assetIds);
      if (costLedgerId) await db.delete(cost_ledger).where(eq(cost_ledger.id, costLedgerId));
    }
  });

  it('GLM VLM-fail → page-level GLM fallback questions + cost_ledger still written', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi.fn(makeGlmStub(makeGlmResponse({ text: 'fallback page text' })));
    // VLM down → handler degrades to the GLM page-level standalone structure.
    const runStructureFn = (async () => {
      throw new StructureTaskError('provider unavailable');
    }) as RunStructureFn;

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn, runStructureFn });
    await handler([{ id: 'boss-job-fb', data: { sessionId } } as never]);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('extracted');
    expect(session[0].warnings.some((w) => w.includes('fell back to GLM'))).toBe(true);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // structure of record is the GLM fallback tree on the fallback path.
    expect(blocks[0].structured?.source).toBe('glm_ocr');
    expect(blocks[0].structured?.prompt_text).toContain('fallback page text');

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-fb');
    expect(ours?.outcome).toBe('success');
    expect(ours?.provider).toBe('glm');

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('GLM VLM-fail on multiple pages preserves fallback page_spans page_index', async () => {
    const { sessionId, sourceDocId, assetIds } = await seedSessionWithAssets(2);
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi
      .fn()
      .mockResolvedValueOnce(makeGlmResponse({ text: 'fallback page zero' }))
      .mockResolvedValueOnce(makeGlmResponse({ text: 'fallback page one' })) as unknown as GlmOcrFn;
    const runStructureFn = (async () => {
      throw new StructureTaskError('provider unavailable');
    }) as RunStructureFn;

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn, runStructureFn });
    await handler([{ id: 'boss-job-fb-pages', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    const pageByPrompt = new Map(
      blocks.map((block) => [block.structured?.prompt_text, block.page_spans[0]?.page_index]),
    );
    expect(pageByPrompt.get('fallback page zero')).toBe(0);
    expect(pageByPrompt.get('fallback page one')).toBe(1);

    await cleanup(sessionId, sourceDocId, assetIds);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-fb-pages');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('GLM client throws Permanent → markExtractionFailed + failed_permanent (provider glm)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi.fn(async () => {
      throw new PermanentError('GLM OCR error [http 400 code 1214]: 格式错误');
    }) as unknown as GlmOcrFn;

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn });
    await expect(handler([{ id: 'boss-job-perm', data: { sessionId } } as never])).rejects.toThrow(
      /1214/,
    );

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('failed');

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-perm');
    expect(ours?.outcome).toBe('failed_permanent');
    expect(ours?.provider).toBe('glm');
    expect(ours?.cost).toBe(0);

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('GLM failure after a successful page records already-consumed tokens', async () => {
    const { sessionId, sourceDocId, assetIds } = await seedSessionWithAssets(2);
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi
      .fn()
      .mockResolvedValueOnce(makeGlmResponse({ promptTokens: 3000, completionTokens: 700 }))
      .mockRejectedValueOnce(new PermanentError('second page failed')) as unknown as GlmOcrFn;

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn });
    await expect(
      handler([{ id: 'boss-job-page2-fail', data: { sessionId } } as never]),
    ).rejects.toThrow(/second page failed/);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('failed');

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-page2-fail');
    expect(ours?.outcome).toBe('failed_permanent');
    expect(ours?.provider).toBe('glm');
    expect(ours?.tokens_in).toBe(3000);
    expect(ours?.tokens_out).toBe(700);
    expect(ours?.cost).toBeCloseTo(((3000 + 700) / 1_000_000) * 0.2, 10);

    await cleanup(sessionId, sourceDocId, assetIds);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('asset missing from R2 → PermanentError + failed_permanent (GLM not called)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2: R2Client = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const glmOcrFn = vi.fn();

    const handler = buildTencentOcrHandler({
      db,
      r2,
      glmOcrFn: glmOcrFn as never,
    });
    await expect(handler([{ id: 'boss-job-3', data: { sessionId } } as never])).rejects.toThrow(
      /R2 object missing/,
    );
    expect(glmOcrFn).not.toHaveBeenCalled();

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-3');
    expect(ours?.outcome).toBe('failed_permanent');
    expect(ours?.provider).toBe('glm');

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('session missing → PermanentError thrown (no DB state change)', async () => {
    const handler = buildTencentOcrHandler({
      db,
      r2: makeR2WithImage(await makeTestImage()),
      glmOcrFn: makeGlmStub(),
    });
    await expect(
      handler([{ id: 'boss-job-4', data: { sessionId: 'never-existed' } } as never]),
    ).rejects.toThrow(/session never-existed not found/);
  });

  it('GLM path: question_block page_spans carries full-page bbox (ADR-0002)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = makeGlmStub();
    const runStructureFn: RunStructureFn = async () => ({
      questions: [
        {
          id: 'vlm-q-pspan',
          role: 'standalone' as const,
          prompt_text: 'VLM question page 0',
          source: 'vlm_structure' as const,
          page_index: 0,
        },
      ],
      layout_quality: 'structured' as const,
      warnings: [],
    });

    const handler = buildTencentOcrHandler({ db, r2, glmOcrFn, runStructureFn });
    await handler([{ id: 'boss-job-pspan', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const span = blocks[0].page_spans[0];
    expect(span?.page_index).toBe(0);
    expect(span?.bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 }); // ADR-0002 unchanged

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-pspan');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  // YUK-253 — retained Tencent rollback engine. engine:'tencent' must fall
  // through to the submitFn/pollFn path (keep ≥1 Tencent-path test alive).

  it("engine='tencent' rollback: uses Tencent submit/poll + tencent cost_ledger", async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const glmOcrFn = vi.fn(); // must NOT be called on the tencent path
    const submitFn = vi.fn(async () => 'tencent-job-id');
    const pollFn = vi.fn(async () => clozeFixture as never);
    const runStructureFn = makeVlmStub();

    const handler = buildTencentOcrHandler({
      db,
      r2,
      engine: 'tencent',
      glmOcrFn: glmOcrFn as never,
      submitFn,
      pollFn,
      runStructureFn,
    });
    await handler([{ id: 'boss-job-tencent', data: { sessionId } } as never]);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('extracted');
    expect(submitFn).toHaveBeenCalledOnce();
    expect(glmOcrFn).not.toHaveBeenCalled();

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks[0].structured?.source).toBe('vlm_structure');

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-tencent');
    expect(ours?.outcome).toBe('success');
    // Tencent path bills 0 / provider 'tencent'.
    expect(ours?.provider).toBe('tencent');
    expect(ours?.model).toBe('QuestionMarkAgent');
    expect(ours?.cost).toBe(0);

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it("engine='tencent' fallback: VLM-fail → Tencent structure (source tencent_ocr)", async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-fb');
    const pollFn = vi.fn(async () => clozeFixture as never);
    const runStructureFn = (async () => {
      throw new StructureTaskError('provider unavailable');
    }) as RunStructureFn;

    const handler = buildTencentOcrHandler({
      db,
      r2,
      engine: 'tencent',
      submitFn,
      pollFn,
      runStructureFn,
    });
    await handler([{ id: 'boss-job-tencent-fb', data: { sessionId } } as never]);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('extracted');
    expect(session[0].warnings.some((w) => w.includes('fell back to Tencent'))).toBe(true);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks[0].structured?.source).toBe('tencent_ocr');

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-tencent-fb');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });
});
