// 学习者从空闲/休眠回来后几分钟内做「回来即可练」准备。
// 订阅只入队；compose 与补题在 job 里跑。测试标记的事件仍准备今日安排和补题，不刷新简报。

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { event, learning_record, question, question_revision } from '@/db/schema';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandler,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { LEARNING_EVENT_ACTIONS } from '@/kernel/nightly-eligibility';
import { batchResolveSubjectIds } from '@/kernel/read-models/subject-resolution';
import { runQuestionSupplyNightly } from '../jobs/question_supply_nightly';
import { loadActivityTier } from './activity-tier';
import { getPracticeBoss } from './queue-runtime';
import { streamLocalDate } from './stream-date';
import { composeNightly } from './stream-store';

export const LEARNER_RETURN_WAKE_QUEUE = 'learner_return_wake';
const WAKE_SINGLETON_SECONDS = 180;
const WAKE_ACTIONS = new Set<string>(LEARNING_EVENT_ACTIONS);

// enqueueBriefRegen 的队列契约。练习层不引用 server/memory。
const MEMORY_BRIEF_REGEN_QUEUE = 'memory_brief_regen';
const REGEN_SINGLETON_SECONDS = 6 * 60;

export function buildLearnerReturnWakeSubscriber(db: Db): EventSubscriptionHandler {
  return async (delivery: EventSubscriptionDelivery): Promise<EventSubscriptionOutcome> => {
    const [row] = await db
      .select({ action: event.action })
      .from(event)
      .where(eq(event.id, delivery.sourceEventId))
      .limit(1);
    if (!row || !WAKE_ACTIONS.has(row.action)) {
      return { status: 'skipped', reason: 'not a learning event' };
    }
    const boss = await getPracticeBoss();
    await boss.send(
      LEARNER_RETURN_WAKE_QUEUE,
      { eventId: delivery.sourceEventId },
      {
        singletonKey: 'learner-return-wake',
        singletonSeconds: WAKE_SINGLETON_SECONDS,
      },
    );
    return { status: 'succeeded' };
  };
}

export function buildLearnerReturnWakeHandler(
  db: Db,
): (jobs: Job<{ eventId?: string }>[]) => Promise<void> {
  return async (jobs) => {
    const eventId = jobs[0]?.data?.eventId;
    if (!eventId) return;
    const [row] = await db.select().from(event).where(eq(event.id, eventId)).limit(1);
    if (!row || !WAKE_ACTIONS.has(row.action)) return;

    const tier = await loadActivityTier(db, row.created_at, row.created_at);
    if (tier !== 'idle' && tier !== 'dormant') return;

    const added = await composeNightly(db, streamLocalDate(row.created_at), {
      policy: { policy: 'legacy' },
    });
    const supply = await runQuestionSupplyNightly(db, { returnStock: true });
    const policy = await readEventDerivationPolicy(db, eventId);
    if (policy !== 'allow') {
      console.warn(
        `[learner_return_wake] prepared return practice without a brief (derivation_policy=${policy}, composed=${added}, dispatched=${supply.dispatched})`,
      );
      return;
    }
    const subjectId = await wakeSubjectId(db, row);
    if (!subjectId) return;
    const boss = await getPracticeBoss();
    const scopeKey = `subject:${subjectId}`;
    await boss.send(
      MEMORY_BRIEF_REGEN_QUEUE,
      { scope_key: scopeKey, now: row.created_at.toISOString() },
      {
        singletonKey: `memory.regen.${scopeKey}`,
        singletonSeconds: REGEN_SINGLETON_SECONDS,
        singletonNextSlot: true,
      },
    );
    console.log(
      `[learner_return_wake] return from ${tier}: composed=${added}, dispatched=${supply.dispatched}, brief=${scopeKey}`,
    );
  };
}

async function wakeSubjectId(db: Db, row: typeof event.$inferSelect): Promise<string | null> {
  if (row.action === 'experimental:record_capture') return subjectFromCapture(db, row);
  if (row.action === 'experimental:assessment_attempt') return subjectFromAssessment(db, row);
  const subjects = await batchResolveSubjectIds(db, [
    { id: row.id, knowledge_ids: referencedKnowledgeIds(row.payload) },
  ]);
  return subjects.get(row.id) ?? null;
}

async function subjectFromCapture(db: Db, row: typeof event.$inferSelect): Promise<string | null> {
  const [rec] = await db
    .select({
      knowledge_ids: learning_record.knowledge_ids,
      subject_id: learning_record.subject_id,
    })
    .from(learning_record)
    .where(eq(learning_record.id, row.subject_id))
    .limit(1);
  if (!rec) return null;
  if (rec.knowledge_ids.length > 0) {
    const subjects = await batchResolveSubjectIds(db, [
      { id: row.id, knowledge_ids: rec.knowledge_ids },
    ]);
    return subjects.get(row.id) ?? null;
  }
  return rec.subject_id;
}

async function subjectFromAssessment(
  db: Db,
  row: typeof event.$inferSelect,
): Promise<string | null> {
  const answeredPartId = row.subject_kind === 'question' ? row.subject_id : '';
  const questionId =
    answeredPartId || (await revisionGroupId(db, stringField(row.payload, 'revision_id')));
  if (!questionId) return null;
  const [item] = await db
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  const knowledgeIds = item?.knowledge_ids ?? [];
  if (knowledgeIds.length === 0) return null;
  const subjects = await batchResolveSubjectIds(db, [{ id: row.id, knowledge_ids: knowledgeIds }]);
  return subjects.get(row.id) ?? null;
}

async function revisionGroupId(db: Db, revisionId: string | null): Promise<string> {
  if (!revisionId) return '';
  const [revision] = await db
    .select({ group_id: question_revision.group_id })
    .from(question_revision)
    .where(eq(question_revision.revision_id, revisionId))
    .limit(1);
  return revision?.group_id ?? '';
}

function referencedKnowledgeIds(payload: unknown): string[] {
  const ids = fieldArray(payload, 'referenced_knowledge_ids');
  return ids ?? [];
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function fieldArray(payload: unknown, key: string): string[] | null {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return null;
  return value.filter((id): id is string => typeof id === 'string');
}
