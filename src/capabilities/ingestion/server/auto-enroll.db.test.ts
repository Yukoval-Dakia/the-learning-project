/**
 * Tests for runAutoEnrollForSession — T-OC slice 3 (YUK-145, OC-4 / OC-5).
 *
 * DB-backed. Injected TaggingTask fn so no real LLM runs. The headline test is
 * the CRITICAL SAFETY one: with the flag OFF (default), NOTHING auto-enrolls and
 * every block stays 'draft' for the existing human review flow. See ADR-0026 +
 * docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md §4.
 */
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type RunAutoEnrollParams, runAutoEnrollForSession } from './auto-enroll';

const FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

async function seed(
  db: ReturnType<typeof testDb>,
): Promise<{ sessionId: string; blockIds: string[] }> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '虚词',
    domain: 'yuwen',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const sessionId = createId();
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: createId(),
    source_asset_ids: ['asset_1'],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const blockIds = [createId(), createId()];
  await db.insert(question_block).values(
    blockIds.map((id) => ({
      id,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      structured: structured(`下列句中「之」的用法 ${id}`),
      figures: [],
      layout_quality: 'structured',
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: '之',
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
  return { sessionId, blockIds };
}

// P3 (YUK-489): the ENROLL path runs the unified `tagKnowledge`, not the grid-prefill
// TaggingTask. DB tests inject a `tagKnowledgeFn` stub (mirroring tag-knowledge.db.test.ts's
// embedFn/nameKcFn stubs) so no embedding/naming model is called.
//
// matchK1 — always MATCHES the seeded `k1` KC (the common enroll case): the question attributes
// to k1 with no new KC minted.
const matchK1: RunAutoEnrollParams['tagKnowledgeFn'] = async () => ({
  kind: 'match',
  knowledge_ids: ['k1'],
});

describe('runAutoEnrollForSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ===========================================================================
  // YUK-486 — idempotent re-run: a duplicate auto_enroll job (dev double-consume,
  // or a pg-boss retry re-delivering the same session) must NOT double-INSERT
  // questions. The status='draft' SELECT + per-block 'auto_enrolled' flip make a
  // sequential re-run a no-op; the in-tx FOR UPDATE claim is the concurrent backstop
  // (singletonKey+singletonSeconds on the send only REDUCES duplicate jobs — the FOR UPDATE
  // claim is the structural guarantee). This is the observable contract; the truly-concurrent
  // race needs a timing seam to exercise.
  // ===========================================================================
  it('YUK-486 idempotent re-run: a duplicate/retry auto_enroll does not double-enroll', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const first = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
    });
    expect(first.status).toBe('completed');
    expect(first.enrolled).toBe(2);

    expect(await db.select().from(question)).toHaveLength(2);
    const importedIds = (
      await db
        .select({ id: question_block.imported_question_id })
        .from(question_block)
        .where(eq(question_block.ingestion_session_id, sessionId))
    )
      .map((b) => b.id)
      .sort();

    // Re-run the SAME session (duplicate job / pg-boss retry).
    const second = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
    });
    expect(second.status).toBe('completed');
    expect(second.enrolled).toBe(0); // no draft blocks left → nothing re-enrolled
    expect(second.routed_to_review).toBe(0);

    // No duplicate questions; the block→question links are unchanged.
    expect(await db.select().from(question)).toHaveLength(2);
    const importedIds2 = (
      await db
        .select({ id: question_block.imported_question_id })
        .from(question_block)
        .where(eq(question_block.ingestion_session_id, sessionId))
    )
      .map((b) => b.id)
      .sort();
    expect(importedIds2).toEqual(importedIds);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'auto_enrolled')).toBe(true);
  });
});
