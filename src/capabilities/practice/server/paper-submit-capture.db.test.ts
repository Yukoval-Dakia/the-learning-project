// YUK-784 — 卷提交路径的过程框落库（conditional write）。镜像 submit.ts 的散题条件写入
// （reasoning_trace?.trim() 才带键 → 缺省 absent，既有卷提交事件 byte-identical）。
//
// 判分用确定性 exact（true_false + reference 'true'），无 LLM / runTask mock。
// No-DB 分区禁入：本文件落 db 车道（.db.test.ts 命名约定）。

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { AttemptOnQuestion } from '@/core/schema/event/known';
import { artifact, event, question } from '@/db/schema';
import { Review } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { submitPaperSlot } from './paper-submit';

async function seedQuestion(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    prompt_md: `Prompt ${id}`,
    reference_md: 'true',
    knowledge_ids: ['kc_paper'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(id: string, questionIds: string[]) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: 'capture paper',
    knowledge_ids: ['kc_paper'],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: ['kc_paper'],
          feedback_policy: 'immediate',
          adaptation_policy: 'none',
          assignments: questionIds.map((qid) => ({
            question_id: qid,
            primary_knowledge_id: 'kc_paper',
            secondary_knowledge_ids: [],
            selection_reason: 'test',
            review_profile_snapshot: {},
          })),
        },
      ],
    } as never,
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function attemptPayloadRow(attemptEventId: string) {
  const db = testDb();
  const rows = await db.select().from(event).where(eq(event.id, attemptEventId));
  if (rows.length === 0) throw new Error(`no attempt event ${attemptEventId}`);
  return rows[0];
}

describe('YUK-784 — paper submit reasoning_trace conditional write', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('带上过程文本 → attempt event payload.reasoning_trace 原样落库，且 payload 过 AttemptOnQuestion 校验', async () => {
    const db = testDb();
    await seedQuestion('pq_a');
    await seedPaper('paper_cap', ['pq_a']);
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_cap' });

    const result = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_cap',
        questionId: 'pq_a',
        answerMd: 'true',
        primaryKnowledgeId: 'kc_paper',
        secondaryKnowledgeIds: [],
        reasoningTrace: '先判断命题真假，再对照定义',
      },
      db,
    );

    const row = await attemptPayloadRow(result.attemptEventId);
    expect((row.payload as Record<string, unknown>).reasoning_trace).toBe(
      '先判断命题真假，再对照定义',
    );
    // 事件 payload 形状仍过读侧 schema（槽位已在 AttemptOnQuestion 上，YUK-562 先行铺）。
    const parsed = AttemptOnQuestion.safeParse({
      actor_kind: row.actor_kind,
      actor_ref: row.actor_ref,
      action: row.action,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      outcome: row.outcome,
      payload: row.payload,
      caused_by_event_id: row.caused_by_event_id ?? undefined,
    });
    expect(parsed.success).toBe(true);
  });

  it('未带 / 纯空白 → payload 无 reasoning_trace 键（既有卷提交 byte-identical）', async () => {
    const db = testDb();
    await seedQuestion('pq_a');
    await seedQuestion('pq_b');
    await seedPaper('paper_cap', ['pq_a', 'pq_b']);
    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_cap' });

    const withBlank = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_cap',
        questionId: 'pq_a',
        answerMd: 'true',
        primaryKnowledgeId: 'kc_paper',
        secondaryKnowledgeIds: [],
        reasoningTrace: '   ',
      },
      db,
    );
    const without = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_cap',
        questionId: 'pq_b',
        answerMd: 'true',
        primaryKnowledgeId: 'kc_paper',
        secondaryKnowledgeIds: [],
      },
      db,
    );

    for (const attemptEventId of [withBlank.attemptEventId, without.attemptEventId]) {
      const row = await attemptPayloadRow(attemptEventId);
      expect(Object.hasOwn(row.payload as Record<string, unknown>, 'reasoning_trace')).toBe(false);
    }
  });
});
