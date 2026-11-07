import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installPracticeHost } from '@/capabilities/practice/public';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { learning_session, question, question_block, source_document } from '@/db/schema';
import { persistCapturedQuestionBlock } from '@/kernel/records/question-block-creation';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { enrollIngestionBlock } from './single-block-enroll';

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

async function seedSession(
  db: ReturnType<typeof testDb>,
  options: { sessionStatus?: 'extracted' | 'partial'; prompts: string[] },
): Promise<{ sessionId: string; docId: string; blockIds: string[] }> {
  const now = new Date();
  const docId = createId();
  await db.insert(source_document).values({
    id: docId,
    source_asset_ids: [],
    provenance: { usage_policy: { derivation_policy: 'allow' } },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const sessionId = createId();
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: options.sessionStatus ?? 'extracted',
    source_document_id: docId,
    source_asset_ids: [],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const blockIds: string[] = [];
  for (const [ordinal, prompt] of options.prompts.entries()) {
    const blockId = createId();
    blockIds.push(blockId);
    await persistCapturedQuestionBlock(
      db,
      {
        origin: 'ocr',
        blockId,
        sessionId,
        sourceDocumentId: docId,
        ordinal,
        layoutQuality: 'structured',
        structured: structured(prompt),
        figures: [],
        sourceAssetIds: [],
        pageSpans: [],
        imageRefs: [],
        extractionConfidence: 1,
      },
      now,
    );
  }
  return { sessionId, docId, blockIds };
}

describe('enrollIngestionBlock', () => {
  beforeAll(installPracticeHost);
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: one block maps to at most one question, and a repeated click
  //   returns the enrolled row instead of inserting a second one
  // @fails-if a second call creates another question, or a prompt retry leaves the
  //   block draft while the sibling block changes
  it.each([
    { mode: 'retry_existing_prompt', sessionStatus: 'extracted' as const, prompt: '已识别的题面' },
    { mode: 'write_prompt_then_enroll', sessionStatus: 'extracted' as const, prompt: '' },
    { mode: 'partial_session', sessionStatus: 'partial' as const, prompt: '部分页里的题' },
  ])('enrolls one block idempotently (%s)', async ({ sessionStatus, prompt }) => {
    const db = testDb();
    const { sessionId, blockIds } = await seedSession(db, {
      sessionStatus,
      prompts: [prompt, '同页另一题'],
    });
    const blockId = blockIds[0];
    const siblingId = blockIds[1];
    if (!blockId || !siblingId) throw new Error('seed blocks missing');
    const body = prompt
      ? { expectedVersion: 0 }
      : { expectedVersion: 0, promptMd: '用户补的题面' };

    const first = await enrollIngestionBlock(db, { sessionId, blockId, ...body });
    expect(first.status).toBe('enrolled');
    expect(first.library_visible).toBe(true);

    const second = await enrollIngestionBlock(db, { sessionId, blockId, ...body });
    expect(second.status).toBe('already_enrolled');
    expect(second.question_id).toBe(first.question_id);

    const questions = await db
      .select()
      .from(question)
      .where(sql`${question.id} = ${first.question_id}`);
    expect(questions).toHaveLength(1);
    if (prompt === '') {
      expect(questions[0]?.prompt_md).toContain('用户补的题面');
    }

    const [enrolledBlock] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, blockId));
    expect(enrolledBlock?.status).toBe('auto_enrolled');
    expect(enrolledBlock?.imported_question_id).toBe(first.question_id);

    const [sibling] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, siblingId));
    expect(sibling?.status).toBe('draft');
    expect(sibling?.imported_question_id).toBeNull();
  });
});
