/**
 * Tests for POST /api/ingestion/[id]/import
 *
 * Strategy:
 * - Use testDb() / resetDb() for actual Postgres integration
 * - Mock @/server/ai/runner
 * - Lane D (YUK-482): the failure→propose-new-KC side-effect was removed from
 *   import; these tests assert only canonical capture facts are written. The
 *   practice-owned durable subscription derives failure learning afterwards.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  event,
  job_events,
  knowledge,
  learning_record,
  learning_session,
  question,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';

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

import { Ingestion } from '@/server/session';
import { initiateDocxTextUpload } from '@/server/session/docx-ingestion';
// YUK-503 (YUK-471 W3-D test hardening) — fold==row parity helpers for the set_status writers.
// The import POST emits a canonical `experimental:question_block_lifecycle` (op='set_status') alongside
// each imperative status UPDATE; these let the test prove the additive double-write keeps the event-log
// fold byte-identical to the live row (catching a future ONE-SIDED literal drift between the UPDATE and
// the lifecycle-event payload, which the existing behavioural assertions on `block.status` would miss).
import {
  type IngestionOperationJobData,
  buildIngestionOperationHandler,
} from '../jobs/ingestion_operation';
import { runAutoEnrollForSession } from '../server/auto-enroll';
import { segmentMarkdown } from '../server/docx/markdown-segment';
import * as enrollment from '../server/enroll';
import { completeIngestionImport } from '../server/import-completion';
import { readIngestionOperation, reserveIngestionOperation } from '../server/operation-store';
import { ImportBody } from './import-schema';

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

  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocId,
    source_asset_ids: assetIds,
    status: opts.status ?? 'extracted',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
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
    ordinal?: number;
  },
) {
  const now = new Date();
  await db.insert(question_block).values({
    id: opts.id,
    ingestion_session_id: opts.sessionId,
    source_document_id: opts.docId,
    source_asset_ids: ['asset_1'],
    page_spans: [{ page_index: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, role: 'prompt' }],
    ordinal: opts.ordinal ?? 0,
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
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function insertKnowledge(db: ReturnType<typeof testDb>, id: string, domain = 'yuwen') {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain,
    parent_id: null,
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

describe('POST /api/ingestion/[id]/import', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
    vi.clearAllMocks();
  });

  // @invariant data: incomplete DOCX extraction retains recoverable source and all media.
  // @fails-if year-led questions merge, decimal/counter text creates phantom blocks, or uncertain images bypass review.
  it('retains incomplete DOCX source and media behind explicit review', async () => {
    const db = testDb();
    const markdown = [
      '**1.**题甲',
      'A.甲 B.乙 C.丙 D.丁',
      '2.5米是题甲的条件',
      '2.2024年图前 ![](media/a.png) 图后 ![](media/b.png)',
      'A.甲 B.乙 C.丙 D.丁',
      '1.本节共两题',
      '4\\.',
      '![](media/c.png) ![](media/d.png)',
    ].join('\n');
    const mediaAssetIds = ['a', 'b', 'c', 'd'];
    const { blocks, warnings } = segmentMarkdown({
      markdown,
      media: mediaAssetIds.map((id) => ({ path: `media/${id}.png` })),
    });
    const result = await initiateDocxTextUpload(db, {
      evidenceAssetIds: ['page'],
      mediaAssets: Object.fromEntries(mediaAssetIds.map((id) => [`media/${id}.png`, id])),
      markdown,
      warnings,
      blocks: blocks.map((b) => ({
        structured: b.structured,
        imageRefs: b.imagePaths.map((path) => path.slice(6, -4)),
      })),
    });
    const [source] = await db
      .select()
      .from(source_document)
      .where(eq(source_document.id, result.sourceDocumentId));
    const [session] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, result.sessionId));
    const drafts = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, result.sessionId))
      .orderBy(question_block.ordinal);
    expect(source.body_md).toBe(markdown);
    expect(source.provenance).toMatchObject({
      docx_media: { 'media/c.png': 'c', 'media/d.png': 'd' },
    });
    expect(source.source_asset_ids).toEqual(['page', ...mediaAssetIds]);
    expect(session.source_asset_ids).toEqual(source.source_asset_ids);
    expect(drafts.map((b) => b.structured?.question_no)).toEqual(['1', '2', '4']);
    expect(drafts[0].structured?.options?.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(drafts[0].structured?.prompt_text).toBe('题甲\n2.5米是题甲的条件');
    expect(drafts[1].structured?.prompt_text).toBe('2024年图前  图后 \n1.本节共两题');
    expect(drafts[1].structured?.options?.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(drafts.map((b) => b.image_refs)).toEqual([[], ['a', 'b'], []]);
    expect(session.status).toBe('partial');
    expect(session.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('题号 3 至 3'),
        expect.stringContaining('第 4 题缺少'),
        expect.stringContaining('图片的题目归属不明'),
        expect.stringContaining('题号 1 重复或倒序'),
        expect.stringContaining('第 2 题的图片按 DOCX 文本锚点'),
      ]),
    );
    const receipts = await db
      .select()
      .from(job_events)
      .where(
        and(
          eq(job_events.business_id, session.id),
          eq(job_events.event_type, 'ingestion.extraction_completed'),
        ),
      );
    expect(receipts[0].payload).toMatchObject({
      block_count: 3,
      layout_quality: 'partial',
      warnings: session.warnings,
    });
    await expect(
      db.transaction((tx) => Ingestion.assertSessionAvailableForImport(tx, session.id)),
    ).rejects.toThrow();
  });

  it('durable import calls the owner once across concurrent delivery and replay', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');
    const operationId = 'ingop_duplicate_import';
    await reserveIngestionOperation(db, {
      operationId,
      sessionId,
      operationKind: 'import',
      inputHash: 'test-input',
    });
    const jobs = [
      {
        id: 'job-import',
        data: {
          operationId,
          sessionId,
          request: { kind: 'import', input: ImportBody.parse(makeImportBody()) },
        },
      },
    ] as Job<IngestionOperationJobData>[];
    const handler = buildIngestionOperationHandler(db);
    await Promise.all([handler(jobs), handler(jobs)]);
    const receipt = await readIngestionOperation(db, operationId);
    expect(receipt).toMatchObject({
      status: 'succeeded',
      result: {
        question_ids: [expect.any(String)],
        mistake_ids: [expect.any(String)],
        record_ids: [expect.any(String)],
      },
    });
    await handler(jobs);
    expect(await readIngestionOperation(db, operationId)).toEqual(receipt);
    expect(await db.select().from(question)).toHaveLength(1);
    expect(await db.select().from(learning_record)).toHaveLength(1);
    const completed = await db
      .select()
      .from(job_events)
      .where(
        and(
          eq(job_events.business_id, operationId),
          eq(job_events.event_type, 'operation.completed'),
        ),
      );
    expect(completed).toHaveLength(1);
    const [session] = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session.status).toBe('imported');
  });

  it('manual import and auto-enroll cannot consume the same source block concurrently', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');
    await db
      .update(question_block)
      .set({
        structured: {
          id: 'structured-a',
          role: 'standalone',
          prompt_text: '解释下列句子中之字的用法，并指出代词与结构助词的区别。',
          source: 'vlm_structure',
        },
        layout_quality: 'structured',
      })
      .where(eq(question_block.id, 'block_a'));
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realEnroll = enrollment.enrollCapturedBlock;
    const enrollmentSpy = vi
      .spyOn(enrollment, 'enrollCapturedBlock')
      .mockImplementationOnce(async (tx, input) => {
        // Manual path has validated the source and inserted its question, but has
        // not yet written the block's terminal status: the historical double-consume gap.
        paused.resolve();
        await release.promise;
        return realEnroll(tx, input);
      });
    const manual = completeIngestionImport(db, sessionId, ImportBody.parse(makeImportBody()));
    await paused.promise;
    let autoFinished = false;
    const automatic = runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
      env: { WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: 'true' },
      tagKnowledgeFn: async () => ({ kind: 'match', knowledge_ids: ['k1'] }),
    }).finally(() => {
      autoFinished = true;
    });
    try {
      // Wait for the actual database lock wait (fixed path), or completion (old
      // path), not a guessed sleep duration. Then let manual import settle.
      await vi.waitFor(
        async () => {
          const [waiter] = await db.execute(sql`SELECT EXISTS(
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND objid = hashtext('learning-state:write')::oid
        ) AS blocked`);
          expect(autoFinished || waiter.blocked === true).toBe(true);
        },
        { timeout: 5_000, interval: 10 },
      );
      release.resolve();
      const [, result] = await Promise.all([manual, automatic]);
      expect(await db.select().from(question)).toHaveLength(1);
      expect(await db.select().from(learning_record)).toHaveLength(1);
      expect(await db.select().from(event).where(eq(event.action, 'attempt'))).toHaveLength(1);
      expect(result.enrolled).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([manual, automatic]);
      enrollmentSpy.mockRestore();
    }
  });

  // Codex P1-A — concurrent double-submit must not produce partial side effects.
  // The status-machine check (commitImport) and the write phase must live inside
  // a single transaction; otherwise both callers may pass per-row checks, both
  // INSERT question/mistake/question_block rows, and only one wins the
  // status-transition fight in commitImport — leaving the other call's writes
  // committed and orphaned (and the user observing duplicate imports on retry).
  it('concurrent double-submit: exactly one import succeeds, no partial side effects', async () => {
    const db = testDb();
    const { sessionId, sourceDocId } = await setupSession(db);
    await insertBlock(db, { id: 'block_a', sessionId, docId: sourceDocId });
    await insertKnowledge(db, 'k1');

    const results = await Promise.allSettled([
      completeIngestionImport(db, sessionId, ImportBody.parse(makeImportBody())),
      completeIngestionImport(db, sessionId, ImportBody.parse(makeImportBody())),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'conflict', status: 409 },
    });

    // Exactly one question and one attempt event were inserted (the winning import).
    // Step 9 dropped the mistake table — the attempt event id doubles as the
    // back-compat mistake_id.
    const questions = await db.select().from(question);
    const attemptEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.outcome, 'failure')));
    expect(questions).toHaveLength(1);
    expect(attemptEvents).toHaveLength(1);

    // Block was promoted from draft → imported exactly once.
    const blocks = await db.select().from(question_block).where(eq(question_block.id, 'block_a'));
    expect(blocks[0].status).toBe('imported');

    // Session reached terminal `imported` state.
    const sessions = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(sessions[0].status).toBe('imported');
  });
});
