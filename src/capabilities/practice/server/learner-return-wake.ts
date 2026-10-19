// YUK-1560 — 学习者从空闲/休眠回来后几分钟内做「回来即可练」准备。
// 订阅只入队；compose 与补题在 job 里跑。测试标记的事件仍准备今日安排和补题，不刷新简报。

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandler,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { RETURN_STOCK_QUESTIONS } from '@/kernel/nightly-eligibility';
import { batchResolveSubjectIds } from '@/kernel/read-models/subject-resolution';
import { runQuestionSupplyNightly } from '../jobs/question_supply_nightly';
import { loadActivityTier } from './activity-tier';
import { getPracticeBoss } from './queue-runtime';
import { streamLocalDate } from './stream-date';
import { composeNightly } from './stream-store';

export const LEARNER_RETURN_WAKE_QUEUE = 'learner_return_wake';
const WAKE_SINGLETON_SECONDS = 180;
const WAKE_ACTIONS = new Set(['attempt', 'review', 'experimental:assessment_attempt']);

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

    const added = await composeNightly(db, streamLocalDate(row.created_at));
    const supply = await runQuestionSupplyNightly(db, { maxPerRun: RETURN_STOCK_QUESTIONS });
    const policy = await readEventDerivationPolicy(db, eventId);
    if (policy !== 'allow') {
      console.warn(
        `[learner_return_wake] prepared return practice without a brief (derivation_policy=${policy}, composed=${added}, dispatched=${supply.dispatched})`,
      );
      return;
    }
    const subjects = await batchResolveSubjectIds(db, [
      { id: row.id, knowledge_ids: referencedKnowledgeIds(row.payload) },
    ]);
    const subjectId = subjects.get(row.id);
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

function referencedKnowledgeIds(payload: unknown): string[] {
  if (payload && typeof payload === 'object' && 'referenced_knowledge_ids' in payload) {
    const ids = (payload as { referenced_knowledge_ids?: unknown }).referenced_knowledge_ids;
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  }
  return [];
}
