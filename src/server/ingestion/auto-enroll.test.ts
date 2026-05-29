/**
 * Tests for runAutoEnrollForSession — T-OC slice 3 (YUK-145, OC-4 / OC-5).
 *
 * DB-backed. Injected TaggingTask fn so no real LLM runs. The headline test is
 * the CRITICAL SAFETY one: with the flag OFF (default), NOTHING auto-enrolls and
 * every block stays 'draft' for the existing human review flow. See ADR-0026 +
 * docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md §4.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import {
  event,
  knowledge,
  learning_record,
  learning_session,
  question,
  question_block,
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { runAutoEnrollForSession } from './auto-enroll';

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
    domain: 'wenyan',
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

const highConfidenceTagging = async (): Promise<TaggingOutputT> => ({
  suggestions: [{ knowledge_id: 'k1', confidence: 0.95, reasoning: 'ok' }],
  overall_confidence: 0.95,
  reasoning: 'high',
});

const lowConfidenceTagging = async (): Promise<TaggingOutputT> => ({
  suggestions: [{ knowledge_id: 'k1', confidence: 0.3, reasoning: 'meh' }],
  overall_confidence: 0.3,
  reasoning: 'low',
});

describe('runAutoEnrollForSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ===========================================================================
  // CRITICAL SAFETY: flag OFF (default) → no-op. This is the production default.
  // ===========================================================================
  it('flag OFF (default): no-op, nothing enrolled, all blocks stay draft', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db);

    let taggingCalled = false;
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {}, // flag undefined → OFF
      runTaggingFn: async () => {
        taggingCalled = true;
        return highConfidenceTagging();
      },
    });

    expect(result.status).toBe('skipped:flag_off');
    expect(result.enrolled).toBe(0);
    // The judge / tagging never even runs when the flag is off.
    expect(taggingCalled).toBe(false);

    // Every block is untouched: still 'draft', no question, no event.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
    expect(blocks.every((b) => b.imported_question_id === null)).toBe(true);

    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
    const events = await db.select().from(event);
    expect(events).toHaveLength(0);
    expect(blockIds).toHaveLength(2);
  });

  it("flag explicitly 'false' → still OFF (no-op)", async () => {
    const db = testDb();
    const { sessionId } = await seed(db);
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [FLAG]: 'false' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(result.status).toBe('skipped:flag_off');
    expect(result.enrolled).toBe(0);
  });

  // ===========================================================================
  // Flag ON: high confidence → auto-enroll with generated_by='workflow_judge'.
  // ===========================================================================
  it('flag ON + high confidence: auto-enrolls with workflow_judge provenance', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(2);
    expect(result.routed_to_review).toBe(0);

    // Both blocks flipped to 'imported' + linked to a question.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'imported')).toBe(true);
    expect(blocks.every((b) => b.imported_question_id !== null)).toBe(true);

    // Questions created with the prefilled knowledge ids.
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.knowledge_ids.includes('k1'))).toBe(true);

    // outcome=unanswered → no attempt event, but a record_capture event with the
    // workflow_judge provenance marker (OC-5).
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(0);
    const captures = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:record_capture'));
    expect(captures).toHaveLength(2);
    expect(
      captures.every(
        (e) => (e.payload as Record<string, unknown>).generated_by === 'workflow_judge',
      ),
    ).toBe(true);

    // open_question records created (unanswered = item/material).
    const records = await db.select().from(learning_record);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.kind === 'open_question')).toBe(true);
  });

  // ===========================================================================
  // Flag ON: low confidence → routed to review, block stays draft (no change).
  // ===========================================================================
  it('flag ON + low confidence: routes to review, block stays draft', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: lowConfidenceTagging,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(2);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('flag ON + tagging outage: routes to review (never auto-enrolls on failure)', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const { TaggingTaskError } = await import('./tagging');
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: async () => {
        throw new TaggingTaskError('provider down');
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(2);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  it('skips when session is not in an extractable status', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);
    await db
      .update(learning_session)
      .set({ status: 'imported' })
      .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(result.status).toBe('skipped:wrong_status');
    expect(result.enrolled).toBe(0);
  });

  it('skips when the session does not exist', async () => {
    const db = testDb();
    const result = await runAutoEnrollForSession({
      db,
      sessionId: createId(),
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(result.status).toBe('skipped:session_not_found');
  });
});
