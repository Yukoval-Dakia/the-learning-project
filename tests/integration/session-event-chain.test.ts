import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { db } from '@/db/client';
import { event, job_events, learning_session, source_asset } from '@/db/schema';
import { Ingestion } from '@/server/session';
import { resetDb } from '../helpers/db';

// Full ingestion lifecycle integration test (Phase 1c.1 Step 5):
//   initiateUpload → enqueueExtraction → markExtractionStarted → applyExtractionResult
// Asserts:
//   (a) learning_session status walks the state machine
//   (b) exactly ONE extract event(success) is written, chained via session_id
//   (c) job_events rows are also emitted (Sub 0c plumbing untouched)

const STEM_FIXTURE: StructuredQuestionT = {
  id: 'q-1',
  role: 'standalone',
  prompt_text: 'integration q',
};

function mockBoss() {
  return {
    send: vi.fn(async () => 'mock-job-id'),
  } as unknown as Parameters<typeof Ingestion.enqueueExtraction>[0]['boss'];
}

async function insertAsset(id: string) {
  await db.insert(source_asset).values({
    id,
    kind: 'image',
    storage_key: `sk-${id}`,
    mime_type: 'image/png',
    byte_size: 8,
    sha256: '0'.repeat(64),
    created_at: new Date(),
  });
}

describe('ingestion lifecycle → event chain', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('full happy-path emits one extract event(success) chained via session_id, plus job_events', async () => {
    await insertAsset('a_1');

    // 1. initiateUpload
    const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
      assetIds: ['a_1'],
      entrypoint: 'vision_single',
    });
    let session = (
      await db.select().from(learning_session).where(eq(learning_session.id, sessionId))
    )[0];
    expect(session.status).toBe('uploaded');
    expect(session.type).toBe('ingestion');

    // 2. enqueueExtraction → status='queued'
    await Ingestion.enqueueExtraction({ db, boss: mockBoss(), sessionId });
    session = (
      await db.select().from(learning_session).where(eq(learning_session.id, sessionId))
    )[0];
    expect(session.status).toBe('queued');

    // 3. markExtractionStarted → status='extracting'
    await db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));
    session = (
      await db.select().from(learning_session).where(eq(learning_session.id, sessionId))
    )[0];
    expect(session.status).toBe('extracting');

    // 4. applyExtractionResult → status='extracted' + 1 question_block + 1 event(extract, success)
    await db.transaction((tx) =>
      Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId,
        blocks: [
          {
            structured: STEM_FIXTURE,
            figures: [],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
            source_asset_ids: ['a_1'],
            image_refs: ['a_1'],
          },
        ],
        layoutQuality: 'structured',
        warnings: [],
      }),
    );
    session = (
      await db.select().from(learning_session).where(eq(learning_session.id, sessionId))
    )[0];
    expect(session.status).toBe('extracted');

    // ----- Assertions -----

    // (b) exactly 1 extract event, chained via session_id, ExtractSourceDocument shape
    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(1);
    const ex = events[0];
    expect(ex.action).toBe('extract');
    expect(ex.subject_kind).toBe('source_document');
    expect(ex.subject_id).toBe(sourceDocumentId);
    expect(ex.actor_kind).toBe('agent');
    expect(ex.actor_ref).toBe('tencent_ocr');
    expect(ex.outcome).toBe('success');
    const payload = ex.payload as { structured_block_ids: string[]; layout_quality: string };
    expect(payload.structured_block_ids).toHaveLength(1);
    expect(payload.layout_quality).toBe('structured');

    // (c) job_events plumbing covers each transition (ingestion.uploaded/queued/extracting/extraction_completed)
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    const jtypes = jevents.map((e) => e.event_type).sort();
    expect(jtypes).toContain('ingestion.uploaded');
    expect(jtypes).toContain('ingestion.queued');
    expect(jtypes).toContain('ingestion.extracting');
    expect(jtypes).toContain('ingestion.extraction_completed');
  });

  it('failure path emits one extract event(failure) chained via session_id', async () => {
    await insertAsset('a_2');
    const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
      assetIds: ['a_2'],
      entrypoint: 'vision_single',
    });
    await Ingestion.enqueueExtraction({ db, boss: mockBoss(), sessionId });
    await db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));
    await db.transaction((tx) =>
      Ingestion.markExtractionFailed(tx, sessionId, 'Tencent OCR returned FAIL'),
    );

    const session = (
      await db.select().from(learning_session).where(eq(learning_session.id, sessionId))
    )[0];
    expect(session.status).toBe('failed');
    expect(session.error_message).toBe('Tencent OCR returned FAIL');

    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    const ex = events.find((e) => e.action === 'extract');
    expect(ex).toBeTruthy();
    expect(ex?.outcome).toBe('failure');
    expect(ex?.subject_id).toBe(sourceDocumentId);
    expect((ex?.payload as { warnings: string[] }).warnings).toEqual(['Tencent OCR returned FAIL']);
  });

  it('rescue after partial emits a second extract event(success, vision_rescue) chained to the same session', async () => {
    await insertAsset('a_3');
    const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
      assetIds: ['a_3'],
      entrypoint: 'vision_single',
    });
    await Ingestion.enqueueExtraction({ db, boss: mockBoss(), sessionId });
    await db.transaction((tx) => Ingestion.markExtractionStarted(tx, sessionId));
    await db.transaction((tx) =>
      Ingestion.applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId,
        blocks: [
          {
            structured: STEM_FIXTURE,
            figures: [],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
            source_asset_ids: ['a_3'],
            image_refs: ['a_3'],
          },
        ],
        layoutQuality: 'partial',
        warnings: ['layout messy'],
      }),
    );
    // First extract event already exists; now rescue
    const blockId = (await db.execute(sql`SELECT id FROM question_block LIMIT 1`)) as unknown as {
      id: string;
    }[];
    await db.transaction((tx) =>
      Ingestion.applyRescue(tx, {
        sessionId,
        blockId: blockId[0].id,
        structured: { ...STEM_FIXTURE, prompt_text: 'rescued' },
        figures: [],
      }),
    );

    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(2);
    const initial = events.find((e) => e.actor_ref === 'tencent_ocr');
    const rescued = events.find((e) => e.actor_ref === 'vision_rescue');
    expect(initial?.outcome).toBe('partial');
    expect(rescued?.outcome).toBe('success');
    expect((rescued?.payload as { structured_block_ids: string[] }).structured_block_ids).toEqual([
      blockId[0].id,
    ]);
  });
});
