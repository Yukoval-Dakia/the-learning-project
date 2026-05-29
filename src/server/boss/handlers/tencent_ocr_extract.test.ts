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
});
