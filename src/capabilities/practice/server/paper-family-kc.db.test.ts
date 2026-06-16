// YUK-361 Phase 5 finding #3b 回归 — paper 路径的 family_key / distinct 计数基一致性。
//
// bug：paper 提交时 family 旧实现按 slot 的 primaryKnowledgeId 成键，但
// countDistinctQuestionsInFamily 按 question.knowledge_ids->>0 过滤。若 slot 的
// primaryKnowledgeId ≠ 题的 knowledge_ids[0]（plan slot 指派 vs 题自身主 knowledge），
// family_key 与 distinct 计数基指向**不同**的题集 → distinct 门数错 / 数不到，门控失效。
//
// 修复：canonical 家族基统一为 question.knowledge_ids[0]（题自身的主 knowledge），
// paper hook 改传 q.knowledge_ids[0]（不再传 slot.primaryKnowledgeId）。review 路径
// 本就传 q.knowledge_ids[0]，两路径对齐到同一真相。
//
// 本测试：seed 一道 knowledge_ids=[kQ] 的题，但 paper slot 指派 primary_knowledge_id=kSlot
// (≠kQ)，objective(exact) 提交后断言：
//   (1) family 行按 kQ（题的 knowledge_ids[0]）成键，**不**按 kSlot；
//   (2) distinct 计数基 = knowledge_ids[0]=kQ 的题集，与 family_key 同源（数得到）。

import { artifact, item_family_calibration, knowledge, question } from '@/db/schema';
import { Review } from '@/server/session';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  countDistinctQuestionsInFamily,
  familyKey,
} from '../../../server/mastery/personalized-difficulty';
import { submitPaperSlot } from './paper-submit';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const db = testDb();
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedTrueFalseQuestion(id: string, knowledgeIds: string[], reference = 'true') {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    prompt_md: `Prompt ${id}`,
    reference_md: reference,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(id: string, questionIds: string[], slotPrimaryKnowledgeId: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: '测试卷 (#3b)',
    knowledge_ids: [slotPrimaryKnowledgeId],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: [slotPrimaryKnowledgeId],
          feedback_policy: 'immediate',
          adaptation_policy: 'none',
          assignments: questionIds.map((qid) => ({
            question_id: qid,
            // slot 指派的 primary —— 故意 ≠ 题的 knowledge_ids[0]（bug 触发条件）。
            primary_knowledge_id: slotPrimaryKnowledgeId,
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

describe('finding #3b — paper family_key / distinct 计数基一致 (slot.primary ≠ knowledge_ids[0])', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('family 按题的 knowledge_ids[0] 成键 (非 slot 的 primaryKnowledgeId)', async () => {
    const db = testDb();
    // 题的主 knowledge = kQ；slot 指派的 primary = kSlot（故意不同）。
    await seedKnowledge('kQ', 'wenyan');
    await seedKnowledge('kSlot', 'wenyan');
    await seedTrueFalseQuestion('q1', ['kQ'], 'true');
    await seedPaper('paper_3b', ['q1'], 'kSlot');

    const { sessionId } = await Review.startReviewSession(db, { artifactId: 'paper_3b' });

    // objective(exact) 提交 → family hook 触发。slot.primaryKnowledgeId=kSlot 传入路由，
    // 但 family 必须按 q.knowledge_ids[0]=kQ 成键（修复后）。
    const submit = await submitPaperSlot(
      {
        sessionId,
        paperArtifactId: 'paper_3b',
        questionId: 'q1',
        answerMd: 'true', // 正确 → success
        primaryKnowledgeId: 'kSlot',
        feedbackPolicy: 'immediate',
      },
      db,
    );
    expect(submit.coarseOutcome).toBe('correct');

    const famRows = await db.select().from(item_family_calibration);
    expect(famRows).toHaveLength(1);
    // 修复后：family_key 含 kQ（题的 knowledge_ids[0]），不含 kSlot（slot 指派）。
    const expectedKey = familyKey('wenyan', 'kQ', 'true_false', 'manual');
    expect(famRows[0].family_key).toBe(expectedKey);
    expect(famRows[0].family_key).toContain(':kQ:');
    expect(famRows[0].family_key).not.toContain('kSlot');
  });

  it('distinct 计数基 = knowledge_ids[0]，与 family_key 同源 (数得到正确题集)', async () => {
    const db = testDb();
    await seedKnowledge('kQ', 'wenyan');
    // 5 道同 (kQ, true_false, manual) 家族的题（按 knowledge_ids[0]=kQ）。
    for (let i = 0; i < 5; i++) {
      await seedTrueFalseQuestion(`fq${i}`, ['kQ'], 'true');
    }
    // 一道 knowledge_ids[0]=kOther 的干扰题——不属 kQ 家族，不该被计入。
    await seedKnowledge('kOther', 'wenyan');
    await seedTrueFalseQuestion('noise', ['kOther'], 'true');

    // 按 kQ（canonical 基）计数 → 正确数到 5 道（不含 kOther 干扰题）。
    const countByKQ = await countDistinctQuestionsInFamily(db, 'kQ', 'true_false', 'manual');
    expect(countByKQ).toBe(5);

    // 反例：若按一个 slot 风格的、与 knowledge_ids[0] 不一致的 id（kSlot）计数 →
    // 数到 0（没有题的 knowledge_ids[0]=kSlot）。这正是 bug 的失效模式：family_key 按
    // kSlot 成键但 distinct 永远数 0 → 门控永不过。修复后 family 与计数都用 kQ，一致。
    const countByKSlot = await countDistinctQuestionsInFamily(db, 'kSlot', 'true_false', 'manual');
    expect(countByKSlot).toBe(0);
  });
});
