import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installPracticeHost } from '@/capabilities/practice/public';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  event,
  knowledge,
  learning_session,
  question,
  question_block,
  source_document,
} from '@/db/schema';
import { persistCapturedQuestionBlock } from '@/kernel/records/question-block-creation';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { captureIngestionOriginal } from './assessment-capture';
import { enrollIngestionBlock } from './single-block-enroll';

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

async function seedSession(
  db: ReturnType<typeof testDb>,
  options: {
    sessionStatus?: 'extracted' | 'partial';
    prompts: string[];
    wrongAnswer?: string;
    nullStructured?: boolean;
    derivationPolicy?: 'allow' | 'answer_only' | 'crisis';
    knowledgeHint?: string;
  },
): Promise<{ sessionId: string; docId: string; blockIds: string[] }> {
  const now = new Date();
  const docId = createId();
  await db.insert(source_document).values({
    id: docId,
    source_asset_ids: [],
    provenance: {
      usage_policy: { derivation_policy: options.derivationPolicy ?? 'allow' },
    },
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
    if (options.nullStructured) {
      await db
        .update(question_block)
        .set({ structured: null })
        .where(eq(question_block.id, blockId));
    }
    if (options.wrongAnswer) {
      await db
        .update(question_block)
        .set({ wrong_answer_md: options.wrongAnswer })
        .where(eq(question_block.id, blockId));
    }
    if (options.knowledgeHint) {
      await db
        .update(question_block)
        .set({ knowledge_hint: options.knowledgeHint })
        .where(eq(question_block.id, blockId));
    }
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
    {
      mode: 'captured_answer',
      sessionStatus: 'extracted' as const,
      prompt: '带作答的题',
      wrongAnswer: 'x=42',
    },
    {
      mode: 'capture_committed_retry',
      sessionStatus: 'extracted' as const,
      prompt: 'capture 已提交后重试',
      wrongAnswer: 'x=7',
    },
    {
      mode: 'null_structured_prompt',
      sessionStatus: 'extracted' as const,
      prompt: '没有树的题',
      nullStructured: true,
    },
  ])(
    'enrolls one block idempotently (%s)',
    async ({ sessionStatus, prompt, wrongAnswer, nullStructured }) => {
      const db = testDb();
      const { sessionId, blockIds } = await seedSession(db, {
        sessionStatus,
        prompts: [prompt, '同页另一题'],
        ...(wrongAnswer ? { wrongAnswer } : {}),
        ...(nullStructured ? { nullStructured } : {}),
      });
      const blockId = blockIds[0];
      const siblingId = blockIds[1];
      if (!blockId || !siblingId) throw new Error('seed blocks missing');
      const body =
        prompt && !nullStructured
          ? { expectedVersion: 0 }
          : { expectedVersion: 0, promptMd: '用户补的题面' };

      let capturedQuestionId: string | null = null;
      if (wrongAnswer) {
        const [blockRow] = await db
          .select()
          .from(question_block)
          .where(eq(question_block.id, blockId));
        if (!blockRow) throw new Error('seeded block missing');
        if (wrongAnswer === 'x=7') {
          const captured = await captureIngestionOriginal(db, {
            block: blockRow,
            knowledgeIds: [],
            difficulty: 3,
            confidence: 0,
            canEnroll: true,
            pageRefs: [],
            now: new Date(),
          });
          capturedQuestionId = captured?.questionId ?? null;
        }
      }

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
      if (prompt === '' || nullStructured) {
        expect(questions[0]?.prompt_md).toContain('用户补的题面');
      }
      if (wrongAnswer) {
        expect(first.question_id.startsWith('q_capture_')).toBe(true);
        if (capturedQuestionId) expect(first.question_id).toBe(capturedQuestionId);
        const questionsForBlock = await db
          .select({ id: question.id })
          .from(question)
          .where(sql`${question.metadata}->>'question_block_id' = ${blockId}`);
        expect(questionsForBlock).toHaveLength(1);
        const attempts = await db
          .select({ id: event.id })
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:assessment_attempt'),
              sql`${event.payload}->'ingestion'->>'block_id' = ${blockId}`,
            ),
          );
        expect(attempts.length).toBeGreaterThanOrEqual(1);
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
    },
  );

  // @invariant security: a restricted source document never arms knowledge
  //   attribution — /enroll on its blocks leaves knowledge 'missing' and
  //   knowledge_ids empty, so downstream model lanes keyed on knowledge_ids
  //   are never fed; allowed documents attribute by exact name as before
  // @fails-if exact-name attribution runs for answer_only/crisis documents, or
  //   restricted blocks stop enrolling entirely (enrollment itself must stay)
  it.each([
    { policy: 'answer_only' as const, expectedKnowledge: 'missing' as const, ids: [] as string[] },
    { policy: 'crisis' as const, expectedKnowledge: 'missing' as const, ids: [] as string[] },
    { policy: 'allow' as const, expectedKnowledge: 'attributed' as const, ids: ['kc-1'] },
  ])(
    'suppresses knowledge attribution by source policy ($policy)',
    async ({ policy, expectedKnowledge, ids }) => {
      const db = testDb();
      await db.insert(knowledge).values({
        id: 'kc-1',
        name: '虚词',
        domain: 'yuwen',
        parent_id: null,
        archived_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      });
      const { sessionId, blockIds } = await seedSession(db, {
        prompts: ['带提示的题'],
        derivationPolicy: policy,
        knowledgeHint: '虚词',
      });
      const blockId = blockIds[0];
      if (!blockId) throw new Error('seed block missing');

      const result = await enrollIngestionBlock(db, { sessionId, blockId, expectedVersion: 0 });
      expect(result.status).toBe('enrolled');
      expect(result.knowledge).toBe(expectedKnowledge);

      const [row] = await db
        .select({ knowledge_ids: question.knowledge_ids, metadata: question.metadata })
        .from(question)
        .where(eq(question.id, result.question_id));
      expect(row?.knowledge_ids).toEqual(ids);
      expect(
        (row?.metadata as { ingestion_enrollment?: { knowledge?: string } } | null)
          ?.ingestion_enrollment?.knowledge,
      ).toBe(expectedKnowledge);
    },
  );
});
