/**
 * Tests for runAutoEnrollForSession — T-OC slice 3 (YUK-145, OC-4 / OC-5).
 *
 * DB-backed. Injected tagging fn so no real LLM runs. Auto-enroll has no off switch
 * (YUK-1994); the safety contract is revertibility plus "no prompt / failed write stays
 * draft".
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installPracticeHost } from '@/capabilities/practice/public';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  event,
  knowledge,
  learning_session,
  question,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type RunAutoEnrollParams, runAutoEnrollForSession } from './auto-enroll';
import { revertAutoEnrolledBlock } from './revert-auto-enroll';

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

async function seed(
  db: ReturnType<typeof testDb>,
  derivationPolicy: 'allow' | 'answer_only' | 'crisis' = 'allow',
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
  const documentId = createId();
  await db.insert(source_document).values({
    id: documentId,
    source_asset_ids: ['asset_1'],
    provenance: { usage_policy: { derivation_policy: derivationPolicy } },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: documentId,
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
  beforeAll(installPracticeHost);
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
  // @invariant concurrency: a duplicate/retried auto_enroll delivery never double-inserts
  //   a question for an already-enrolled block
  // @fails-if removing the draft re-read or FOR UPDATE claim lets a redelivered batch
  //   enroll the same block twice and creates duplicate questions
  it('YUK-486 idempotent re-run: a duplicate/retry auto_enroll does not double-enroll', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const first = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
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

  // YUK-1994 — a degraded (partial) page and an unattributed block must not be a
  // reason to withhold the question, and the automatic enrollment must stay reversible.
  // @invariant data: an unattributed block from a partial session enters the library
  //   and its automatic enrollment can be reverted without losing the question row
  // @fails-if the block stays draft, the question is hidden from the library
  //   (draft_status 'draft'), or revert cannot restore the block
  it('enrolls an unattributed block from a partial session and keeps it revertible', async () => {
    const db = testDb();
    const now = new Date();
    const sessionId = createId();
    const documentId = createId();
    await db.insert(source_document).values({
      id: documentId,
      source_asset_ids: ['asset_1'],
      provenance: { usage_policy: { derivation_policy: 'allow' } },
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      status: 'partial',
      source_document_id: documentId,
      source_asset_ids: ['asset_1'],
      entrypoint: 'vision_paper',
      warnings: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const blockId = createId();
    const answeredBlockId = createId();
    const promptFallbackBlockId = createId();
    await db.insert(source_asset).values({
      id: 'asset_1',
      kind: 'image',
      storage_key: 'offline/page-1',
      mime_type: 'image/png',
      byte_size: 4096,
      sha256: 'b'.repeat(64),
      created_at: now,
    });
    await db.insert(question_block).values([
      {
        id: blockId,
        ingestion_session_id: sessionId,
        source_document_id: null,
        source_asset_ids: ['asset_1'],
        page_spans: [],
        structured: structured('下列句中「之」的用法'),
        figures: [],
        layout_quality: 'partial',
        image_refs: ['asset_1'],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 0.2,
        status: 'draft',
        knowledge_hint: null,
        merged_from_block_ids: [],
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: answeredBlockId,
        ingestion_session_id: sessionId,
        source_document_id: null,
        source_asset_ids: ['asset_1'],
        page_spans: [],
        structured: {
          id: createId(),
          role: 'standalone',
          kind: 'choice',
          source: 'vlm_structure',
          prompt_text: '1. Solve 3x + 5 = 20.',
          options: [
            { label: 'A', text: '3' },
            { label: 'B', text: '5' },
          ],
          student_answer_present: true,
        },
        figures: [],
        layout_quality: 'partial',
        image_refs: ['asset_1'],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 0.2,
        wrong_answer_md: 'B',
        status: 'draft',
        knowledge_hint: null,
        merged_from_block_ids: [],
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        // VLM emitted options with an empty prompt; the OCR text holds the stem. The one
        // prompt selector must write the stem AND keep the options.
        id: promptFallbackBlockId,
        ingestion_session_id: sessionId,
        source_document_id: null,
        source_asset_ids: ['asset_1'],
        page_spans: [],
        structured: {
          id: createId(),
          role: 'standalone',
          kind: 'choice',
          source: 'vlm_structure',
          prompt_text: '',
          options: [
            { label: 'A', text: '1' },
            { label: 'B', text: '2' },
          ],
        },
        extracted_prompt_md: 'What is 1+1?',
        figures: [],
        layout_quality: 'partial',
        image_refs: ['asset_1'],
        crop_refs: [],
        visual_complexity: 'low',
        extraction_confidence: 0.2,
        status: 'draft',
        knowledge_hint: null,
        merged_from_block_ids: [],
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
      // Attribution failure is ordinary (provider outage / no candidate): the block
      // still enters the library with `knowledge: 'missing'`.
      tagKnowledgeFn: async () => {
        throw new Error('tag provider unavailable');
      },
    });
    expect(result.status).toBe('completed');
    // The unattributed block and the answered block (partial page) both enter the bank;
    // the answered one keeps its captured work as evidence without grading it.
    expect(result.enrolled).toBe(3);

    const [block] = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(block?.status).toBe('auto_enrolled');
    if (!block?.imported_question_id) throw new Error('block has no imported question');
    const [enrolledQuestion] = await db
      .select()
      .from(question)
      .where(eq(question.id, block.imported_question_id));
    expect(enrolledQuestion?.knowledge_ids).toEqual([]);
    expect(enrolledQuestion?.draft_status).toBe('active');
    expect(enrolledQuestion?.metadata).toMatchObject({
      ingestion_enrollment: { knowledge: 'missing' },
    });
    // The publication event must carry the ingestion session: that is the lineage the
    // admission gate proves its source purpose from.
    const [published] = await db
      .select({ sessionId: event.session_id, payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:assessment_publish'),
          eq(event.subject_id, block.imported_question_id),
        ),
      );
    expect(published?.sessionId).toBe(sessionId);

    const [answered] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, answeredBlockId));
    expect(answered?.status).toBe('auto_enrolled');
    if (!answered?.imported_question_id) throw new Error('answered block has no question');
    const [answeredQuestion] = await db
      .select()
      .from(question)
      .where(eq(question.id, answered.imported_question_id));
    // Whole pages stay machine prompt input; no answer key or grading is produced here.
    expect(answeredQuestion?.image_refs).toEqual(['asset_1']);
    expect(answeredQuestion?.reference_md).toBeNull();

    const [fallback] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, promptFallbackBlockId));
    expect(fallback?.status).toBe('auto_enrolled');
    if (!fallback?.imported_question_id) throw new Error('fallback block has no question');
    const [fallbackQuestion] = await db
      .select()
      .from(question)
      .where(eq(question.id, fallback.imported_question_id));
    expect(fallbackQuestion?.prompt_md).toContain('What is 1+1?');
    expect(fallbackQuestion?.prompt_md).toContain('A. 1');
    expect(fallbackQuestion?.choices_md).toEqual(['1', '2']);

    await revertAutoEnrolledBlock(db, { blockId, sessionId });
    const [reverted] = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(reverted).toMatchObject({
      status: 'draft',
      imported_question_id: null,
      imported_attempt_event_id: null,
    });
    expect(
      await db.select().from(question).where(eq(question.id, block.imported_question_id)),
    ).toHaveLength(1);
  });

  // YUK-1994 — a restricted usage policy forbids every model send of the
  // document's content on this path: block assembly, the cold-start bridge and
  // the tagging call all see zero invocations while the blocks still enroll
  // with `knowledge: 'missing'` for the policy-gated backfill.
  // @invariant security: an answer_only/crisis source document never reaches a
  //   provider through auto-enroll — assembly and attribution make zero model calls
  // @fails-if the assembly pass or the attribution path sends document text under a
  //   restricted derivation policy, or the policy gate aborts enrollment
  it('restricted answer_only document sends no model call and still enrolls', async () => {
    const db = testDb();
    const { sessionId } = await seed(db, 'answer_only');
    const calls = { assembly: 0, bridge: 0, tag: 0 };

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'yuwen',
      runBlockAssemblyFn: async () => {
        calls.assembly += 1;
        return { text: '{}' };
      },
      runColdStartBridgeFn: async () => {
        calls.bridge += 1;
        return { text: '' };
      },
      tagKnowledgeFn: async () => {
        calls.tag += 1;
        return { kind: 'match', knowledge_ids: ['k1'] };
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(2);
    expect(calls).toEqual({ assembly: 0, bridge: 0, tag: 0 });

    const enrolledQuestions = await db.select().from(question);
    expect(enrolledQuestions).toHaveLength(2);
    for (const row of enrolledQuestions) {
      expect(row.metadata).toMatchObject({
        ingestion_enrollment: { knowledge: 'missing', solution: 'missing' },
      });
    }
  });
});
