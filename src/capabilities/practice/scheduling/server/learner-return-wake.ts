// 学习者从空闲/休眠回来后几分钟内做「回来即可练」准备。
// 订阅只入队；compose 与补题在 job 里跑。测试标记的事件仍准备今日安排和补题，不刷新简报。
// 任何档位的回访都先看教练计划是否过期，过期才唤醒 coach_daily（窗口与节流在 kernel 端口）。

import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { enqueueCoachIfDue } from '@/kernel/coach-wake';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandler,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { loadActivityTier } from '@/kernel/read-models/activity-tier';
import { LEARNING_ACTIVITY_ACTIONS } from '@/kernel/read-models/learner-activity';
import { streamLocalDate } from '@/kernel/stream-date';
import { getStartedBoss } from '@/server/boss/client';
import { composeNightly } from './stream-store';

export const LEARNER_RETURN_WAKE_QUEUE = 'learner_return_wake';
const WAKE_SINGLETON_SECONDS = 180;
const WAKE_ACTIONS = new Set<string>(LEARNING_ACTIVITY_ACTIONS);

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
    const boss = await getStartedBoss();
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

    // The coach wake is an add-on: its failure must not cost the learner the brief refresh below.
    try {
      const coachWoken = await enqueueCoachIfDue(db, await getStartedBoss(), new Date());
      if (coachWoken) console.log('[learner_return_wake] coach plan stale; coach_daily enqueued');
    } catch (err) {
      console.error('[learner_return_wake] coach wake check failed; continuing', err);
    }

    const tier = await loadActivityTier(db, row.created_at, row.created_at);
    if (tier !== 'idle' && tier !== 'dormant') return;

    const added = await composeNightly(db, streamLocalDate(row.created_at), {
      policy: { policy: 'legacy' },
    });
    const { runQuestionSupplyNightly } = await import('../../public');
    const supply = await runQuestionSupplyNightly(db, { returnStock: true });
    console.log(
      `[learner_return_wake] return from ${tier}: composed=${added}, dispatched=${supply.dispatched}`,
    );
  };
}
