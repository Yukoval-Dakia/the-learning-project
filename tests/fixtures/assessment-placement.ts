import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { question, question_group_lifecycle } from '@/db/schema';
import {
  normalizeQuestionGroupToContract,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';

/** Author a deterministic reference for old selection-only fixtures, then really publish it. */
export async function publishPlacementFixture(db: Db | Tx, questionId: string) {
  const [q] = await db.select().from(question).where(eq(question.id, questionId));
  if (!q) throw new Error('placement fixture missing');
  const groupId = q.parent_question_id ?? q.id;
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId));
  if (lifecycle?.current_revision_id) return lifecycle;
  await db
    .update(question)
    .set({ reference_md: 'fixture answer', judge_kind_override: 'exact' })
    .where(eq(question.id, groupId));
  const [root] = await db.select().from(question).where(eq(question.id, groupId));
  const children = await db.select().from(question).where(eq(question.parent_question_id, groupId));
  const published = await publishQuestionGroup(db, {
    group_id: groupId,
    contract: children.length
      ? normalizeQuestionGroupToContract(root, children)
      : normalizeQuestionRowToContract(root),
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:placement-publication',
    now: new Date(),
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  if (published.status !== 'published')
    throw new Error(`placement fixture publication: ${published.status}`);
  return published;
}

/** Synthetic warm pool for the parent's isolated API/UI run. Every executor is local exact. */
export async function seedPlacementRuntimeFixture(db: Db) {
  const { createId } = await import('@paralleldrive/cuid2');
  const { goal, knowledge } = await import('@/db/schema');
  const key = `yuk1047_${createId()}`;
  const now = new Date();
  const knowledgeId = `${key}_kc`;
  const goalId = `${key}_goal`;
  await db.insert(knowledge).values({
    id: knowledgeId,
    name: '定位恢复验证',
    domain: 'math',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(goal).values({
    id: goalId,
    title: 'YUK-1047 本地定位验证',
    source: 'manual',
    scope_mode: 'explicit',
    scope_knowledge_ids: [knowledgeId],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const questionIds = Array.from({ length: 8 }, (_, i) => `${key}_q${i + 1}`);
  for (const [index, id] of questionIds.entries()) {
    await db.insert(question).values({
      id,
      kind: 'short_answer',
      prompt_md: `本地定位验证 ${index + 1}。填写原始文本 fixture answer。可先填写长文本、刷新验证恢复，再改为参考文本提交。`,
      knowledge_ids: [knowledgeId],
      difficulty: 3,
      source: 'manual',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await publishPlacementFixture(db, id);
  }
  return {
    goalId,
    knowledgeId,
    questionIds,
    answer: 'fixture answer',
    route: `/placement?goal=${encodeURIComponent(goalId)}`,
  };
}
