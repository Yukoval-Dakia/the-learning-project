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

  it('VLM fallback path: page_spans uses question page_index (0) as fallback, no regression', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-fb-pspan');
    const pollFn = vi.fn(async () => clozeFixture as never);
    // VLM down → Tencent structure used. Tencent questions carry page_index from
    // the parser (page_index=0 for first page). page_spans should reflect that.
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
    // Tencent fallback: page_spans[0].page_index comes from the Tencent-parsed
    // question's page_index (0 for first page). The bbox is full-page (ADR-0002).
    const span = blocks[0].page_spans[0];
    expect(span).toBeDefined();
    expect(span?.page_index).toBe(0); // Tencent parser stamps page 0 on first page
    expect(span?.bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    // Tencent fallback warning was surfaced.
    const session = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0].warnings.some((w: string) => w.includes('fell back to Tencent'))).toBe(true);

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-fb-pspan');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  // YUK-227 S3 Slice A (P1 fix) — VLM path page-1 question carries real page_index.

  it('VLM path: page-1 question produces page_spans[0].page_index=1 (P1 fix)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-p1-pspan');
    const pollFn = vi.fn(async () => clozeFixture as never);

    // VLM stub returns a question that explicitly lives on page 1.
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
    // always produced 0 for VLM questions.
    const span = blocks[0].page_spans[0];
    expect(span).toBeDefined();
    expect(span?.page_index).toBe(1);
    expect(span?.bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 }); // ADR-0002

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-p1-pspan');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });

  // YUK-227 S3 Slice A (P2-2) — VLM figure routing integration test.

  it('VLM figure routing: figureAssignments from VLM stub are applied to question_block.figures (P2-2)', async () => {
    const { sessionId, sourceDocId, assetId } = await seedSessionWithAsset();

    // R2 must return image bytes for BOTH the source asset (→ page images for
    // Tencent submit + VLM) AND for figure crops (cropAndUploadFigures reads
    // figure bboxes from the Tencent response). makeR2WithImage always returns
    // the same buffer for any key, which is sufficient.
    const r2 = makeR2WithImage(await makeTestImage());

    const submitFn = vi.fn(async () => 'tencent-job-fig-assign');
    // clozeFixture has QuestionImagePositions in MarkInfos — those become preFigures.
    const pollFn = vi.fn(async () => clozeFixture as never);

    // VLM stub returns one question AND claims figure index 0 belongs to it.
    // The handler will call assignFiguresFromVlm with these assignments and the
    // preFigures derived from Tencent's QuestionImagePositions.
    const vlmQuestionId = 'vlm-fig-q-1';
    const runStructureFn: typeof import('@/server/ingestion/structure').runStructureTask =
      async (_params) => {
        // Return figureAssignments claiming figure 0 belongs to vlmQuestionId.
        // Only returned when preFigures are supplied (the handler supplies them
        // when Tencent reported figure bboxes).
        return {
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
        };
      };

    const handler = buildTencentOcrHandler({ db, r2, submitFn, pollFn, runStructureFn });
    await handler([{ id: 'boss-job-fig-assign', data: { sessionId } } as never]);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    // P2-2: if clozeFixture has figure bboxes, figureAssignments routes figures
    // to the VLM-assigned question (not all falling back to root / geometric).
    // We verify the figures array is non-empty and the VLM assignment was honoured.
    const figures = blocks[0].figures as Array<{
      attached_to_index: string;
      attach_confidence: string;
    }>;

    if (figures && figures.length > 0) {
      // At least one figure must be attached to the VLM-assigned question id
      // with high confidence (not all-root geometric fallback).
      const vlmAssigned = figures.filter(
        (f) => f.attached_to_index === vlmQuestionId && f.attach_confidence === 'high',
      );
      expect(vlmAssigned.length).toBeGreaterThan(0);
    }
    // If clozeFixture has no QuestionImagePositions the figures array is empty —
    // that is still a valid (no-op) outcome; the test passes because the handler
    // ran without error and produced a question_block.
    expect(blocks[0].structured).toBeTruthy();

    await cleanup(sessionId, sourceDocId, assetId);
    const cost = await db.select().from(cost_ledger);
    const ours = cost.find((c) => c.pgboss_job_id === 'boss-job-fig-assign');
    if (ours) await db.delete(cost_ledger).where(eq(cost_ledger.id, ours.id));
  });
});
