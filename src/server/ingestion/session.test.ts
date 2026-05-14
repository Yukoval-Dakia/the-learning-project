import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { ingestion_session, job_events, question_block, source_document } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import {
  applyExtractionResult,
  applyRescue,
  enqueueExtraction,
  markExtractionFailed,
  markExtractionStarted,
  markReviewed,
} from './session';
import type { StructuredQuestionT } from '@/core/schema/structured_question';

// Mock pg-boss boss instance for enqueueExtraction tests
function mockBoss() {
  return {
    send: vi.fn(async () => 'mock-job-id'),
  } as unknown as Parameters<typeof enqueueExtraction>[0]['boss'];
}

async function makeSession(
  status: string,
  warnings: string[] = [],
): Promise<{ sessionId: string; sourceDocId: string }> {
  const sourceDocId = createId();
  const sessionId = createId();
  const now = new Date();
  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: [],
    body_md: null,
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(ingestion_session).values({
    id: sessionId,
    source_document_id: sourceDocId,
    source_asset_ids: ['asset_a'],
    status,
    entrypoint: 'vision_single',
    error_message: null,
    warnings,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return { sessionId, sourceDocId };
}

async function cleanup(sessionId: string, sourceDocId: string): Promise<void> {
  await db.delete(question_block).where(eq(question_block.ingestion_session_id, sessionId));
  await db.delete(ingestion_session).where(eq(ingestion_session.id, sessionId));
  await db.delete(source_document).where(eq(source_document.id, sourceDocId));
}

const STEM_FIXTURE: StructuredQuestionT = {
  id: 'q-stem',
  role: 'stem',
  prompt_text: 'passage',
  sub_questions: [
    { id: 'q-sub-1', role: 'sub', question_no: '1', prompt_text: '___' },
  ],
};

describe('IngestionSession.enqueueExtraction', () => {
  it('uploaded → queued + boss.send called', async () => {
    const { sessionId, sourceDocId } = await makeSession('uploaded');
    const boss = mockBoss();
    const { jobId } = await enqueueExtraction({ db, boss, sessionId });
    expect(jobId).toBe('mock-job-id');
    expect(boss.send).toHaveBeenCalledWith('tencent_ocr_extract', { sessionId });

    const rows = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(rows[0].status).toBe('queued');
    await cleanup(sessionId, sourceDocId);
  });

  it('failed → queued (retry)', async () => {
    const { sessionId, sourceDocId } = await makeSession('failed');
    await enqueueExtraction({ db, boss: mockBoss(), sessionId });
    const rows = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(rows[0].status).toBe('queued');
    await cleanup(sessionId, sourceDocId);
  });

  it('rejects from extracting (409)', async () => {
    const { sessionId, sourceDocId } = await makeSession('extracting');
    await expect(
      enqueueExtraction({ db, boss: mockBoss(), sessionId }),
    ).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId, sourceDocId);
  });

  it('404 when session not found', async () => {
    await expect(
      enqueueExtraction({ db, boss: mockBoss(), sessionId: 'never-existed' }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('IngestionSession.markExtractionStarted', () => {
  it('queued → extracting', async () => {
    const { sessionId, sourceDocId } = await makeSession('queued');
    await db.transaction(async (tx) => markExtractionStarted(tx, sessionId));
    const rows = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(rows[0].status).toBe('extracting');
    await cleanup(sessionId, sourceDocId);
  });

  it('rejects from uploaded (409)', async () => {
    const { sessionId, sourceDocId } = await makeSession('uploaded');
    await expect(
      db.transaction((tx) => markExtractionStarted(tx, sessionId)),
    ).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId, sourceDocId);
  });
});

describe('IngestionSession.applyExtractionResult', () => {
  it('extracting + structured → extracted + N question_block rows', async () => {
    const { sessionId, sourceDocId } = await makeSession('extracting');
    await db.transaction((tx) =>
      applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId: sourceDocId,
        blocks: [
          {
            structured: STEM_FIXTURE,
            figures: [],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
            source_asset_ids: ['asset_a'],
            image_refs: ['asset_a'],
          },
        ],
        layoutQuality: 'structured',
        warnings: [],
      }),
    );
    const session = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(session[0].status).toBe('extracted');
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].layout_quality).toBe('structured');
    await cleanup(sessionId, sourceDocId);
  });

  it('extracting + partial layout → partial + warnings appended', async () => {
    const { sessionId, sourceDocId } = await makeSession('extracting', ['existing warn']);
    await db.transaction((tx) =>
      applyExtractionResult(tx, {
        sessionId,
        sourceDocumentId: sourceDocId,
        blocks: [
          {
            structured: STEM_FIXTURE,
            figures: [],
            page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
            source_asset_ids: ['asset_a'],
            image_refs: ['asset_a'],
          },
        ],
        layoutQuality: 'partial',
        warnings: ['partial: 7 blanks 5 subs'],
      }),
    );
    const session = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(session[0].status).toBe('partial');
    expect(session[0].warnings).toEqual(['existing warn', 'partial: 7 blanks 5 subs']);
    await cleanup(sessionId, sourceDocId);
  });

  it('rejects empty blocks (must use markExtractionFailed instead)', async () => {
    const { sessionId, sourceDocId } = await makeSession('extracting');
    await expect(
      db.transaction((tx) =>
        applyExtractionResult(tx, {
          sessionId,
          sourceDocumentId: sourceDocId,
          blocks: [],
          layoutQuality: 'text_only',
          warnings: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await cleanup(sessionId, sourceDocId);
  });

  it('rejects from non-extracting state (409)', async () => {
    const { sessionId, sourceDocId } = await makeSession('uploaded');
    await expect(
      db.transaction((tx) =>
        applyExtractionResult(tx, {
          sessionId,
          sourceDocumentId: sourceDocId,
          blocks: [
            {
              structured: STEM_FIXTURE,
              figures: [],
              page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
              source_asset_ids: ['asset_a'],
              image_refs: ['asset_a'],
            },
          ],
          layoutQuality: 'structured',
          warnings: [],
        }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId, sourceDocId);
  });
});

describe('IngestionSession.markExtractionFailed', () => {
  it('extracting → failed + error_message stored + job_event emitted', async () => {
    const { sessionId, sourceDocId } = await makeSession('extracting');
    await db.transaction((tx) => markExtractionFailed(tx, sessionId, 'Tencent API down'));
    const session = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(session[0].status).toBe('failed');
    expect(session[0].error_message).toBe('Tencent API down');

    const events = await db
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, sessionId));
    const fail = events.find((e) => e.event_type === 'ingestion.extraction_failed');
    expect(fail).toBeTruthy();
    expect((fail?.payload as { error_message?: string })?.error_message).toBe('Tencent API down');

    await cleanup(sessionId, sourceDocId);
    await db.delete(job_events).where(eq(job_events.business_id, sessionId));
  });
});

describe('IngestionSession.applyRescue', () => {
  it('updates the block structured + figures, bumps version, session stays partial', async () => {
    const { sessionId, sourceDocId } = await makeSession('partial');
    const now = new Date();
    const blockId = createId();
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: sessionId,
      source_document_id: sourceDocId,
      source_asset_ids: ['asset_a'],
      page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
      structured: { stale: true } as unknown as Record<string, unknown>,
      figures: [],
      layout_quality: 'partial',
      image_refs: ['asset_a'],
      crop_refs: [],
      visual_complexity: 'medium',
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_mistake_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await db.transaction((tx) =>
      applyRescue(tx, { sessionId, blockId, structured: STEM_FIXTURE, figures: [] }),
    );

    const after = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect((after[0].structured as { role?: string })?.role).toBe('stem');
    expect(after[0].version).toBe(1);

    const session = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(session[0].status).toBe('partial');

    await cleanup(sessionId, sourceDocId);
  });

  it('rejects from queued state (only partial / extracted ok)', async () => {
    const { sessionId, sourceDocId } = await makeSession('queued');
    await expect(
      db.transaction((tx) =>
        applyRescue(tx, {
          sessionId,
          blockId: 'fake',
          structured: STEM_FIXTURE,
          figures: [],
        }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId, sourceDocId);
  });
});

describe('IngestionSession.markReviewed', () => {
  it('extracted → reviewed', async () => {
    const { sessionId, sourceDocId } = await makeSession('extracted');
    await markReviewed(db, sessionId);
    const session = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(session[0].status).toBe('reviewed');
    await cleanup(sessionId, sourceDocId);
  });

  it('partial → reviewed', async () => {
    const { sessionId, sourceDocId } = await makeSession('partial');
    await markReviewed(db, sessionId);
    const session = await db.select().from(ingestion_session).where(eq(ingestion_session.id, sessionId));
    expect(session[0].status).toBe('reviewed');
    await cleanup(sessionId, sourceDocId);
  });

  it('rejects from uploaded (409)', async () => {
    const { sessionId, sourceDocId } = await makeSession('uploaded');
    await expect(markReviewed(db, sessionId)).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId, sourceDocId);
  });
});
