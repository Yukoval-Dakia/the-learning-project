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
import { resolveQualifyingEventSubjects } from '@/server/memory/active-subjects';
import { enqueueBriefRegen } from '@/server/memory/triggers';
import { loadNightlyContext } from '@/server/orchestration/nightly-signals';
import { runQuestionSupplyNightly } from '../jobs/question_supply_nightly';
import { getPracticeBoss } from './queue-runtime';
import { streamLocalDate } from './stream-date';
import { composeNightly } from './stream-store';

export const LEARNER_RETURN_WAKE_QUEUE = 'learner_return_wake';
const WAKE_SINGLETON_SECONDS = 180;
const WAKE_ACTIONS = new Set(['attempt', 'review', 'experimental:assessment_attempt']);

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

    const before = await loadNightlyContext(db, row.created_at, [LEARNER_RETURN_WAKE_QUEUE], {
      before: row.created_at,
    });
    const tier = before.forJob(LEARNER_RETURN_WAKE_QUEUE).tier;
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
    const subjects = await resolveQualifyingEventSubjects(db, [
      {
        id: row.id,
        action: row.action,
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        outcome: row.outcome,
        payload: row.payload,
        created_at: row.created_at,
      },
    ]);
    const subjectId = subjects.get(row.id);
    if (!subjectId) return;
    const boss = await getPracticeBoss();
    await enqueueBriefRegen(boss, `subject:${subjectId}`, row.created_at);
    console.log(
      `[learner_return_wake] return from ${tier}: composed=${added}, dispatched=${supply.dispatched}, brief=subject:${subjectId}`,
    );
  };
}
