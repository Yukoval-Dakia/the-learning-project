// YUK-214 (Strategy D · S1) — DB integration for createIngestionPaper: the full
// write path (reverse-query imported questions → build → INSERT artifact) +
// idempotency (a second call for the same session returns the existing paper).
// The pure builder shape is covered by make-paper.unit.test.ts (unit partition).

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  artifact,
  knowledge,
  learning_session,
  question,
  question_block,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createIngestionPaper } from './make-paper';

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'yuwen',
      parent_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

/** Seed an ingestion session + source document + N imported questions whose
 *  metadata carries ingestion_session_id (mirrors import/route's write).
 *
 *  When a question carries `block_created_at`, a matching `question_block` row is
 *  also seeded (with that created_at) and linked via
 *  `metadata.question_block_id` — mirroring import/route's write so the block-order
 *  reverse-query can be exercised. All imported questions share one `now` (as the
 *  real import route does); `block_ordinal` (YUK-221) carries the true 0-based paper
 *  order the reverse-query sorts by (defaults to 0 when unspecified). */
async function seedImportedSession(opts: {
  sessionId: string;
  questions: Array<{
    id: string;
    knowledge_ids: string[];
    block_created_at?: Date;
    block_ordinal?: number;
  }>;
  docTitle?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  const docId = createId();
  await db.insert(source_document).values({
    id: docId,
    title: opts.docTitle ?? null,
    source_asset_ids: [],
    body_md: null,
    provenance: {} as Record<string, unknown>,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(learning_session).values({
    id: opts.sessionId,
    type: 'ingestion',
    source_document_id: docId,
    source_asset_ids: [],
    status: 'imported',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  for (const q of opts.questions) {
    for (const k of q.knowledge_ids) await seedKnowledge(k);
    let blockId: string | undefined;
    if (q.block_created_at) {
      blockId = createId();
      await db.insert(question_block).values({
        id: blockId,
        ingestion_session_id: opts.sessionId,
        source_document_id: docId,
        source_asset_ids: [],
        page_spans: [],
        extracted_prompt_md: `Prompt ${q.id}`,
        reference_md: null,
        wrong_answer_md: null,
        image_refs: [],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 1,
        status: 'imported',
        knowledge_hint: null,
        merged_from_block_ids: [],
        imported_question_id: q.id,
        imported_attempt_event_id: null,
        // YUK-221 — the block carries the original paper order via `ordinal`.
        ordinal: q.block_ordinal ?? 0,
        created_at: q.block_created_at,
        updated_at: q.block_created_at,
        version: 0,
      });
    }
    await db.insert(question).values({
      id: q.id,
      kind: 'short_answer',
      prompt_md: `Prompt ${q.id}`,
      reference_md: null,
      knowledge_ids: q.knowledge_ids,
      difficulty: 3,
      source: 'vision_single',
      variant_depth: 0,
      metadata: {
        ingestion_session_id: opts.sessionId,
        source_document_id: docId,
        // Link to the source block (import/route.ts:407) when one was seeded.
        ...(blockId ? { question_block_id: blockId } : {}),
      },
      // All imported questions share one `now` (import/route.ts:250).
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  return { docId };
}

describe('createIngestionPaper (YUK-214)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('is idempotent on sessionId — a second call returns the same paper', async () => {
    const db = testDb();
    await seedImportedSession({
      sessionId: 'sess_c',
      questions: [{ id: 'qc1', knowledge_ids: ['k1'] }],
    });
    const first = await createIngestionPaper(db, { sessionId: 'sess_c' });
    const second = await createIngestionPaper(db, { sessionId: 'sess_c' });
    expect(second.reused).toBe(true);
    expect(second.artifactId).toBe(first.artifactId);

    const rows = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.source_ref, 'sess_c'));
    expect(rows).toHaveLength(1);
  });
});
