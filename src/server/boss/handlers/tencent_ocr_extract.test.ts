import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import type { StructureResult } from '@/server/ingestion/structure';
import { StructureTaskError } from '@/server/ingestion/structure';
import type { R2Client } from '@/server/r2';
import clozeFixture from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

// T-OC slice 2 (YUK-145, OC-1/OC-2): the VLM StructureTask owns structure. The
// handler injects `runStructureFn`; tests stub it so no real multimodal LLM
// call happens. This default stub returns a single standalone VLM-authored
// question — the structured tree of record.
function makeVlmStub(): typeof import('@/server/ingestion/structure').runStructureTask {
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
    }) satisfies StructureResult) as typeof import('@/server/ingestion/structure').runStructureTask;
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
}> {
  const sourceDocId = createId();
  const sessionId = createId();
  const assetId = createId();
  const now = new Date();

  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: [assetId],
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

  return { sessionId, sourceDocId, assetId };
}

async function cleanup(sessionId: string, sourceDocId: string, assetId: string) {
  await db.delete(event).where(eq(event.session_id, sessionId));
  await db.delete(job_events).where(eq(job_events.business_id, sessionId));
  await db.delete(question_block).where(eq(question_block.ingestion_session_id, sessionId));
  await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  await db.delete(source_asset).where(eq(source_asset.id, assetId));
  await db.delete(source_document).where(eq(source_document.id, sourceDocId));
}

/**
 * Seed a 2-page session (two source_asset rows). Used by F4 test to create a
 * session where the Tencent parser stamps real page_index=1 on the second page's
 * questions — the placeholder invariant test must assert those still produce
 * page_spans[0].page_index=0 (Tencent fallback path always forces 0).
 */
async function seedTwoPageSession(): Promise<{
  sessionId: string;
  sourceDocId: string;
  assetId0: string;
  assetId1: string;
}> {
  const sourceDocId = createId();
  const sessionId = createId();
  const assetId0 = createId();
  const assetId1 = createId();
  const now = new Date();

  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: [assetId0, assetId1],
    body_md: null,
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  for (const [idx, assetId] of [
    [0, assetId0],
    [1, assetId1],
  ] as const) {
    await db.insert(source_asset).values({
      id: assetId,
      kind: 'image',
      storage_key: `test-key-${assetId}`,
      mime_type: 'image/png',
      byte_size: 1000,
      sha256: `fake-${idx}`,
      width: 500,
      height: 700,
      provenance: {},
      created_at: now,
    });
  }

  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocId,
    source_asset_ids: [assetId0, assetId1],
    status: 'queued',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  return { sessionId, sourceDocId, assetId0, assetId1 };
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

describe('tencent_ocr_extract handler', () => {
  it('queued → extracted with VLM-owned question_block + cost_ledger success', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const pageImage = await makeTestImage();
    const r2 = makeR2WithImage(pageImage);

    const submitFn = vi.fn(async () => 'tencent-job-id');
    const pollFn = vi.fn(async () => clozeFixture as never);
    const runStructureFn = makeVlmStub();

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-1', data: { sessionId } } as never]);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('extracted'); // VLM layout_quality='structured'

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0].structured).toBeTruthy();
    expect(blocks[0].layout_quality).toBe('structured');
    // OC-1/OC-2: the structure of record is the VLM tree, not Tencent's.
    expect(blocks[0].structured?.source).toBe('vlm_structure');
    // Tencent OCR was still run (text + figure bbox layer).
    expect(submitFn).toHaveBeenCalledOnce();

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-1');
    expect(ours).toBeTruthy();
    expect(ours?.outcome).toBe('success');

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('VLM StructureTask failure → falls back to Tencent structure + warning', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-fallback');
    const pollFn = vi.fn(async () => clozeFixture as never);
    // VLM down → handler must degrade to the Tencent-parsed structure.
    const runStructureFn = (async () => {
      throw new StructureTaskError('provider unavailable');
    }) as typeof import('@/server/ingestion/structure').runStructureTask;

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-fb', data: { sessionId } } as never]);

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('extracted');
    // fallback warning surfaced on the session.
    expect(session[0].warnings.some((w) => w.includes('fell back to Tencent'))).toBe(true);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // structure of record is the Tencent tree on the fallback path.
    expect(blocks[0].structured?.source).toBe('tencent_ocr');

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-fb');
    expect(ours?.outcome).toBe('success');

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('Tencent JobStatus=FAIL → markExtractionFailed + cost outcome=failed_retryable + rethrow', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-2');
    const pollFn = vi.fn(async () => ({ JobStatus: 'FAIL', JobErrorMsg: 'OCR failed' }) as never);

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn });
    await expect(handler([{ id: 'boss-job-2', data: { sessionId } } as never])).rejects.toThrow(
      /Tencent OCR job .* FAIL/,
    );

    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].status).toBe('failed');
    expect(session[0].error_message).toContain('FAIL');

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-2');
    expect(ours?.outcome).toBe('failed_retryable');

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('asset missing from R2 → PermanentError + failed_permanent', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2: R2Client = {
      get: vi.fn(async () => null),
      put: vi.fn(),
      delete: vi.fn(),
    };

    const submitFn = vi.fn();
    const pollFn = vi.fn();

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn });
    await expect(handler([{ id: 'boss-job-3', data: { sessionId } } as never])).rejects.toThrow(
      /R2 object missing/,
    );
    expect(submitFn).not.toHaveBeenCalled();

    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-3');
    expect(ours?.outcome).toBe('failed_permanent');

    await cleanup(sessionId, sourceDocId, assetId);
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  it('session missing → PermanentError thrown (no DB state change)', async () => {
    const handler = buildTencentOcrHandler({
      db,
      r2: makeR2WithImage(await makeTestImage()),
      submitFn: vi.fn(),
      pollFn: vi.fn(),
    });
    await expect(
      handler([{ id: 'boss-job-4', data: { sessionId: 'never-existed' } } as never]),
    ).rejects.toThrow(/session never-existed not found/);
  });

  // YUK-227 S3 Slice A — VLM path writes real page_index in page_spans.

  it('VLM path: question_block page_spans carries real page_index from VLM tree', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const pageImage = await makeTestImage();
    const r2 = makeR2WithImage(pageImage);

    const submitFn = vi.fn(async () => 'tencent-job-pspan');
    const pollFn = vi.fn(async () => clozeFixture as never);

    // VLM stub returns a question with page_index=0 (single page doc).
    const runStructureFn: typeof import('@/server/ingestion/structure').runStructureTask =
      async () => ({
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

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-pspan', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    // YUK-227 S3 Slice A: page_spans must carry the VLM-reported page_index (0),
    // not a hardcoded placeholder. bbox remains full-page (ADR-0002).
    const span = blocks[0].page_spans[0];
    expect(span).toBeDefined();
    expect(span?.page_index).toBe(0); // real page_index from VLM tree
    expect(span?.bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 }); // full-page bbox (ADR-0002)

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-pspan');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  // F4 fix: multi-page session so Tencent parser stamps real page_index=1 on the
  // second page's questions. The single-page version could not distinguish
  // "placeholder 0" from "real page 0" — both implementations pass. The two-page
  // fixture makes the invariant meaningful: even though Tencent stamped page_index=1
  // on second-page questions, the Tencent fallback path MUST force page_spans to 0
  // (plan §2 step 4) so isAllPlaceholderPageIndex remains true for block-assembly.
  it('Tencent fallback path: page_spans forced to placeholder 0 even when Tencent stamps real page_index=1 (F4 multi-page)', async () => {
    const { sessionId, sourceDocId, assetId0, assetId1 } = await seedTwoPageSession();
    const r2 = makeR2WithImage(await makeTestImage());

    // Two Tencent OCR calls (one per page). clozeFixture is fine for both pages —
    // the parser will stamp page_index=0 for the first call and page_index=1 for
    // the second call (the handler passes pageIndex=1 for the second asset).
    let callCount = 0;
    const submitFn = vi.fn(async () => `tencent-job-fb-pspan-${++callCount}`);
    const pollFn = vi.fn(async () => clozeFixture as never);

    // VLM down → Tencent structure used (two pages → two sets of questions,
    // second set will have page_index=1 from the parser).
    const runStructureFn = (async () => {
      throw new StructureTaskError('provider unavailable');
    }) as typeof import('@/server/ingestion/structure').runStructureTask;

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-fb-pspan', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    // F4 core assertion: ALL blocks on the Tencent fallback path must have
    // page_spans[0].page_index===0 (placeholder), regardless of the real
    // page_index the Tencent parser stamped. This locks the "腾讯回落路径保持
    // placeholder" invariant against a multi-page doc where ambiguity exists.
    for (const block of blocks) {
      const span = block.page_spans[0];
      expect(span).toBeDefined();
      expect(span?.page_index).toBe(0); // forced placeholder — NOT the Tencent-stamped real value
      expect(span?.bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 }); // ADR-0002
    }

    // Tencent fallback warning was surfaced.
    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].warnings.some((w: string) => w.includes('fell back to Tencent'))).toBe(true);

    // Cleanup both assets.
    await db.delete(event).where(eq(event.session_id, sessionId));
    await db.delete(job_events).where(eq(job_events.business_id, sessionId));
    await db.delete(question_block).where(eq(question_block.ingestion_session_id, sessionId));
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
    await db.delete(source_asset).where(eq(source_asset.id, assetId0));
    await db.delete(source_asset).where(eq(source_asset.id, assetId1));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
    const cost = await db.select().from(cost_ledger);
    const ours = cost.filter((c) => c.pgboss_job_id?.startsWith('boss-job-fb-pspan'));
    for (const c of ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, c.id));
  });

  // YUK-227 S3 Slice A (P1 fix) — VLM path page-1 question carries real page_index.
  // Uses a 2-page session so page_index=1 is in-range (F3 clamp won't fire).

  it('VLM path: page-1 question produces page_spans[0].page_index=1 (P1 fix, 2-page session)', async () => {
    const { sessionId, sourceDocId, assetId0, assetId1 } = await seedTwoPageSession();
    const r2 = makeR2WithImage(await makeTestImage());

    let callCount = 0;
    const submitFn = vi.fn(async () => `tencent-job-p1-pspan-${++callCount}`);
    const pollFn = vi.fn(async () => clozeFixture as never);

    // VLM stub returns a question that lives on page 1 (valid in a 2-page doc).
    // pageCount=2, page_index=1 → in-range, F3 clamp does NOT fire.
    const runStructureFn: typeof import('@/server/ingestion/structure').runStructureTask =
      async () => ({
        questions: [
          {
            id: 'vlm-q-page1',
            role: 'standalone' as const,
            prompt_text: 'VLM question page 1',
            source: 'vlm_structure' as const,
            page_index: 1,
          },
        ],
        layout_quality: 'structured' as const,
        warnings: [],
      });

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-p1-pspan', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    // P1 fix: VLM question with page_index=1 must produce page_spans[0].page_index=1,
    // not 0. Before the P1 fix, nodeToStructured never copied page_index so ?? 0
    // always produced 0 for VLM questions. With F3 clamp in place, page_index=1 is
    // accepted because pageCount=2 (1 < 2).
    const span = blocks[0].page_spans[0];
    expect(span).toBeDefined();
    expect(span?.page_index).toBe(1);
    expect(span?.bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 }); // ADR-0002

    // Cleanup both assets.
    await db.delete(event).where(eq(event.session_id, sessionId));
    await db.delete(job_events).where(eq(job_events.business_id, sessionId));
    await db.delete(question_block).where(eq(question_block.ingestion_session_id, sessionId));
    await db.delete(learning_session).where(eq(learning_session.id, sessionId));
    await db.delete(source_asset).where(eq(source_asset.id, assetId0));
    await db.delete(source_asset).where(eq(source_asset.id, assetId1));
    await db.delete(source_document).where(eq(source_document.id, sourceDocId));
    const cost = await db.select().from(cost_ledger);
    const ours = cost.filter((c) => c.pgboss_job_id?.startsWith('boss-job-p1-pspan'));
    for (const c of ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, c.id));
  });

  // YUK-227 S3 Slice A (F3) — VLM out-of-range page_index clamped to placeholder 0.

  it('F3: VLM page_index >= pageCount is clamped to 0 with a warning (single-page doc)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-f3-clamp');
    const pollFn = vi.fn(async () => clozeFixture as never);

    // VLM hallucinates page_index=5 on a single-page (pageCount=1) session.
    // F3 clamp: 5 >= 1 → rawPageIndex forced to 0 + console.warn.
    const runStructureFn: typeof import('@/server/ingestion/structure').runStructureTask =
      async () => ({
        questions: [
          {
            id: 'vlm-q-oob',
            role: 'standalone' as const,
            prompt_text: 'VLM question with out-of-range page_index',
            source: 'vlm_structure' as const,
            page_index: 5, // hallucinated — out of range for a 1-page doc
          },
        ],
        layout_quality: 'structured' as const,
        warnings: [],
      });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-f3-clamp', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    // F3: out-of-range page_index must be clamped to 0 (placeholder).
    const span = blocks[0].page_spans[0];
    expect(span).toBeDefined();
    expect(span?.page_index).toBe(0);
    // The clamp must have fired a console.warn with the anomaly details.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('out-of-range page_index=5'));

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-f3-clamp');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  // YUK-227 S3 Slice A (P2-2) — VLM figure routing integration test.

  it('VLM figure routing: figureAssignments from VLM stub are applied to question_block.figures (P2-2)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();

    // R2 must return image bytes for both the source asset (page images for
    // Tencent submit + VLM) and for figure crops (cropAndUploadFigures reads
    // figure bboxes from Tencent and crops them). makeR2WithImage returns the
    // same buffer for every key — sufficient for the crop path.
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-fig-assign');

    // Build a Tencent response with one QuestionImagePositions entry so that
    // cropAndUploadFigures produces allPreFigures.length > 0 and the VLM path
    // receives preFigures. The polygon uses pixel coords for a 500×700 image
    // (TL→TR→BR→BL order, flat-8 format required by collectFigures).
    // x: 50–200, y: 100–300 → normalized x:0.1, y:≈0.143, w:0.3, h:≈0.286.
    const figurePolygon = [50, 100, 200, 100, 200, 300, 50, 300];
    const tencentWithFigure = {
      ...clozeFixture,
      MarkInfos: [
        {
          ...clozeFixture.MarkInfos[0],
          QuestionImagePositions: [figurePolygon],
        },
      ],
    };
    const pollFn = vi.fn(async () => tencentWithFigure as never);

    // VLM stub claims figure index 0 belongs to vlmQuestionId.
    // assignFiguresFromVlm will route it with high confidence to that question
    // rather than falling back to the geometric heuristic.
    const vlmQuestionId = 'vlm-fig-q-1';
    const runStructureFn: typeof import('@/server/ingestion/structure').runStructureTask =
      async () => ({
        questions: [
          {
            id: vlmQuestionId,
            role: 'standalone' as const,
            prompt_text: 'VLM question with figure',
            source: 'vlm_structure' as const,
            page_index: 0,
          },
        ],
        layout_quality: 'structured' as const,
        warnings: [],
        figureAssignments: [
          {
            figure_index: 0,
            attached_to_question_id: vlmQuestionId,
            confidence: 'high' as const,
          },
        ],
      });

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-fig-assign', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    // P2-2 core assertion (no if-guard): the Tencent response above has exactly
    // one QuestionImagePositions entry, so allPreFigures.length === 1 and
    // assignFiguresFromVlm is called. The VLM assignment must route figure 0
    // to vlmQuestionId with high confidence — not to some other question or root.
    const figures = blocks[0].figures as Array<{
      attached_to_index: string;
      attach_confidence: string;
    }>;
    expect(figures.length).toBeGreaterThan(0);
    const vlmAssigned = figures.filter(
      (f) => f.attached_to_index === vlmQuestionId && f.attach_confidence === 'high',
    );
    expect(vlmAssigned.length).toBeGreaterThan(0);

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-fig-assign');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });
});
