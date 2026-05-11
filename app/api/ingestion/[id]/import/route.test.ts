/**
 * Tests for POST /api/ingestion/[id]/import
 *
 * Strategy:
 * - Use testDb() / resetDb() for actual Postgres integration
 * - Mock @/server/knowledge/propose and attribute to avoid real AI calls
 * - Mock @/server/ai/runner
 */

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ingestion_session,
  knowledge,
  mistake,
  question,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { memR2 } from '../../../../../tests/helpers/r2';

const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    task_run_id: 'x',
    text: '{}',
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  })),
}));

const mockRunProposeAndWrite = vi.fn(async () => {});
vi.mock('@/server/knowledge/propose', () => ({
  runProposeAndWrite: (...args: unknown[]) => mockRunProposeAndWrite(...(args as [])),
}));

const mockRunAttributionAndWrite = vi.fn(async () => {});
vi.mock('@/server/knowledge/attribute', () => ({
  runAttributionAndWrite: (...args: unknown[]) => mockRunAttributionAndWrite(...(args as [])),
  parseAttributionOutput: vi.fn(),
}));

vi.mock('@/server/knowledge/tree', () => ({
  loadTreeSnapshot: vi.fn(async () => []),
}));

import { POST } from './route';

// ---- helpers ----

async function setupSession(
  db: ReturnType<typeof testDb>,
  opts: {
    sessionId?: string;
    status?: string;
    assetIds?: string[];
  } = {},
) {
  const sessionId = opts.sessionId ?? createId();
  const assetIds = opts.assetIds ?? ['asset_1'];
  const now = new Date();

  // Insert source_assets
  for (const assetId of assetIds) {
    await db.insert(source_asset).values({
      id: assetId,
      kind: 'image',
      storage_key: `sk_${assetId}`,
      mime_type: 'image/png',
      byte_size: 8,
      sha256: '0'.repeat(64),
      created_at: now,
    });
  }

  const sourceDocId = createId();
  await db.insert(source_document).values({
    id: sourceDocId,
    title: null,
    source_asset_ids: assetIds,
    body_md: null,
    provenance: {} as Record<string, unknown>,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  await db.insert(ingestion_session).values({
    id: sessionId,
    source_document_id: sourceDocId,
    source_asset_ids: assetIds,
    status: opts.status ?? 'extracted',
    entrypoint: 'vision_single',
    error_message: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });

  return { sessionId, sourceDocId };
}

async function insertBlock(
  db: ReturnType<typeof testDb>,
  opts: {
    id: string;
    sessionId: string;
    docId: string;
    status?: string;
    visual_complexity?: string;
  },
) {
  const now = new Date();
  await db.insert(question_block).values({
    id: opts.id,
    ingestion_session_id: opts.sessionId,
    source_document_id: opts.docId,
    source_asset_ids: ['asset_1'],
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
    extracted_prompt_md: 'Q text',
    reference_md: null,
    wrong_answer_md: null,
    image_refs: ['asset_1'],
    crop_refs: [],
    visual_complexity: opts.visual_complexity ?? 'low',
    extraction_confidence: 0.9,
    status: opts.status ?? 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_mistake_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function insertKnowledge(db: ReturnType<typeof testDb>, id: string) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain: 'wenyan',
    parent_id: null,
    base_mastery: 0,
    ai_delta_mastery: 0,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function makeImportBody(overrides: Record<string, unknown> = {}) {
  return {
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
        ...overrides,
      },
    ],
  };
}

function postReq(sessionId: string, body: unknown) {
  return new Request(`http://localhost/api/ingestion/${sessionId}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(sessionId: string, body: unknown) {
  return POST(postReq(sessionId, body), { params: Promise.resolve({ id: sessionId }) });
}

describe('POST /api/ingestion/[id]/import', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
    mockRunProposeAndWrite.mockReset();
    mockRunAttributionAndWrite.mockReset();
    vi.clearAllMocks();
    mockRunProposeAndWrite.mockResolvedValue(undefined);
    mockRunAttributionAndWrite.mockResolvedValue(undefined);
  });

  it('unchanged card happy path: cause=null → inserts 1 question + 1 mistake, session=imported', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, makeImportBody());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(1);
    expect(body.mistake_ids).toHaveLength(1);

    // DB assertions
    const questions = await db.select().from(question).where(eq(question.id, body.question_ids[0]));
    expect(questions).toHaveLength(1);
    expect(questions[0].prompt_md).toBe('Q final');

    const mistakes = await db.select().from(mistake).where(eq(mistake.id, body.mistake_ids[0]));
    expect(mistakes).toHaveLength(1);
    expect(mistakes[0].wrong_answer_md).toBe('WA');

    const sessions = await db
      .select()
      .from(ingestion_session)
      .where(eq(ingestion_session.id, sessionId));
    expect(sessions[0].status).toBe('imported');

    // Block updated
    const blocks = await db.select().from(question_block).where(eq(question_block.id, 'block_a'));
    expect(blocks[0].status).toBe('imported');
    expect(blocks[0].imported_question_id).toBe(body.question_ids[0]);
    expect(blocks[0].imported_mistake_id).toBe(body.mistake_ids[0]);
  });

  it('cause provided → cause stored in mistake', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(
      sessionId,
      makeImportBody({ cause: { primary_category: 'concept', user_notes: 'note' } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { mistake_ids: string[] };
    const mistakes = await db.select().from(mistake).where(eq(mistake.id, body.mistake_ids[0]));
    expect((mistakes[0].cause as Record<string, unknown>)?.primary_category).toBe('concept');
    expect((mistakes[0].cause as Record<string, unknown>)?.user_notes).toBe('note');
  });

  it('knowledge_ids missing/archived → 400, NO inserts', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    // k_missing not inserted

    const res = await post(sessionId, makeImportBody({ knowledge_ids: ['k_missing'] }));

    expect(res.status).toBe(400);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('session not found → 404', async () => {
    const db = testDb();
    await insertKnowledge(db, 'k1');

    const res = await post('missing_sess', makeImportBody());

    expect(res.status).toBe(404);
  });

  it('source_block_ids contains block from another session → 400, NO inserts', async () => {
    const db = testDb();
    const { sessionId, sourceDocId: _ } = await setupSession(db, { sessionId: 'sess_1' });
    const { sessionId: otherSessionId, sourceDocId: otherDocId } = await setupSession(db, {
      sessionId: 'sess_other',
      assetIds: ['asset_other'],
    });
    await insertBlock(db, { id: 'block_a', sessionId: otherSessionId, docId: otherDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, makeImportBody());

    expect(res.status).toBe(400);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('merged virtual card: INSERT new question_block with merged_from_block_ids, source blocks marked ignored', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db, { assetIds: ['asset_1', 'asset_2'] });
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertBlock(db, { id: 'block_b', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
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
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(1);

    // New virtual question_block was inserted
    const allBlocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    // 2 original + 1 virtual
    expect(allBlocks).toHaveLength(3);

    const virtualBlock = allBlocks.find((b) => b.id !== 'block_a' && b.id !== 'block_b');
    expect(virtualBlock).toBeDefined();
    expect(virtualBlock?.merged_from_block_ids).toEqual(['block_a', 'block_b']);

    // Source blocks should be ignored
    const blockA = allBlocks.find((b) => b.id === 'block_a');
    const blockB = allBlocks.find((b) => b.id === 'block_b');
    expect(blockA?.status).toBe('ignored');
    expect(blockB?.status).toBe('ignored');
  });

  it('split: 2 virtual cards sharing source_block_id → 2 new question_blocks, source updated ignored once', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
      blocks: [
        {
          source_block_ids: ['block_a'],
          page_spans: [
            { page_index: 0, bbox: { x: 0, y: 0, width: 0.5, height: 1 }, role: 'prompt' },
          ],
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
          page_spans: [
            { page_index: 0, bbox: { x: 0.5, y: 0, width: 0.5, height: 1 }, role: 'prompt' },
          ],
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
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(2);
    expect(body.mistake_ids).toHaveLength(2);

    const allBlocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    // 1 original + 2 virtual
    expect(allBlocks).toHaveLength(3);

    const blockA = allBlocks.find((b) => b.id === 'block_a');
    expect(blockA?.status).toBe('ignored');
  });

  it('unchanged card also used as source_block_id in virtual → NOT marked ignored', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
      blocks: [
        {
          block_id: 'block_a',
          source_block_ids: ['block_a'],
          page_spans: [
            { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
          ],
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
          source_block_ids: ['block_a'],
          page_spans: [
            { page_index: 0, bbox: { x: 0, y: 0, width: 0.5, height: 1 }, role: 'prompt' },
          ],
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
    });

    expect(res.status).toBe(200);

    const blocks = await db.select().from(question_block).where(eq(question_block.id, 'block_a'));
    // block_a was imported, not ignored
    expect(blocks[0].status).toBe('imported');
  });

  it('rejects image_ref not in session.source_asset_ids → 400', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db, { assetIds: ['asset_1'] });
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, makeImportBody({ image_refs: ['asset_FOREIGN'] }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/image_ref asset_FOREIGN/);
  });

  it('rejects block_id not in source_block_ids → 400', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertBlock(db, { id: 'block_b', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(
      sessionId,
      makeImportBody({ block_id: 'block_a', source_block_ids: ['block_b'] }),
    );

    expect(res.status).toBe(400);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('rejects unknown source_block_id (no row at all) → 400', async () => {
    const db = testDb();
    const { sessionId } = await setupSession(db);
    await insertKnowledge(db, 'k1');

    const res = await post(
      sessionId,
      makeImportBody({ block_id: undefined, source_block_ids: ['block_NEVER_EXISTED'] }),
    );

    expect(res.status).toBe(400);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('rejects page_index out of session asset range → 400', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db, { assetIds: ['asset_1'] });
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(
      sessionId,
      makeImportBody({
        page_spans: [{ page_index: 5, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/page_index 5 out of range/);
  });

  it('rejects re-import: session already in status=imported → 409', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db, { status: 'imported' });
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, makeImportBody());

    expect(res.status).toBe(409);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('preserves high visual_complexity when merging from any high source block', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db, { assetIds: ['asset_1', 'asset_2'] });
    await insertBlock(db, {
      id: 'block_low',
      sessionId,
      docId: sourceDocId,
      visual_complexity: 'low',
    });
    await insertBlock(db, {
      id: 'block_high',
      sessionId,
      docId: sourceDocId,
      visual_complexity: 'high',
    });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
      blocks: [
        {
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
    });

    expect(res.status).toBe(200);

    const allBlocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    const virtualBlock = allBlocks.find((b) => b.id !== 'block_low' && b.id !== 'block_high');
    expect(virtualBlock).toBeDefined();
    expect(virtualBlock?.visual_complexity).toBe('high');
  });

  it('manual block (Tier 4 fallback): block_id=undefined, source_block_ids=[] → 200, question + mistake created', async () => {
    const db = testDb();
    const { sessionId } = await setupSession(db);
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
      blocks: [
        {
          source_block_ids: [],
          page_spans: [
            { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
          ],
          image_refs: ['asset_1'],
          final_prompt_md: 'manual q',
          final_reference_md: null,
          final_wrong_answer_md: 'manual a',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_ids: string[]; mistake_ids: string[] };
    expect(body.question_ids).toHaveLength(1);
    expect(body.mistake_ids).toHaveLength(1);

    const questions = await db.select().from(question);
    expect(questions).toHaveLength(1);
    const mistakes = await db.select().from(mistake);
    expect(mistakes).toHaveLength(1);

    // A new question_block is inserted for the manual card
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks).toHaveLength(1);
  });

  it('manual block without image_refs → 400', async () => {
    const db = testDb();
    const { sessionId } = await setupSession(db);
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
      blocks: [
        {
          source_block_ids: [],
          page_spans: [
            { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
          ],
          image_refs: [],
          final_prompt_md: 'manual q',
          final_reference_md: null,
          final_wrong_answer_md: 'manual a',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/manual block must reference at least one image_ref/);
  });

  it('delete-block sweep: draft block not in body → marked ignored after import', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_imported', sessionId, docId: sourceDocId });
    await insertBlock(db, { id: 'block_deleted', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
      blocks: [
        {
          block_id: 'block_imported',
          source_block_ids: ['block_imported'],
          page_spans: [
            { page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' },
          ],
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
    });

    expect(res.status).toBe(200);

    const allBlocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    const blockDeleted = allBlocks.find((b) => b.id === 'block_deleted');
    expect(blockDeleted?.status).toBe('ignored');

    const blockImported = allBlocks.find((b) => b.id === 'block_imported');
    expect(blockImported?.status).toBe('imported');
  });

  it('wrong_answer_image_refs derived from page_spans where role=answer_area', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db, { assetIds: ['asset_p', 'asset_a'] });
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const res = await post(sessionId, {
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
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { mistake_ids: string[] };
    const mistakes = await db.select().from(mistake).where(eq(mistake.id, body.mistake_ids[0]));
    expect(mistakes[0].wrong_answer_image_refs).toEqual(['asset_a']);
  });
});
