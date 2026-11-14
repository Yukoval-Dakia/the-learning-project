// Wake learner-profile refresh on every sealed settlement receipt. The
// subscription only enqueues the drain job; the intent rows committed in the
// settlement's own transaction are the durable work, so a missed wake is
// recovered by the queue's minute-floor sweep — never a lost invalidation.

import type { Db } from '@/db/client';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { getStartedBoss } from '@/server/boss/client';
import { LEARNER_PROFILE_REFRESH_QUEUE } from '../jobs/learner-profile-refresh';

export const PROFILE_REFRESH_SUBSCRIBER = 'practice.learner-profile-refresh';

export const buildLearnerProfileRefreshSubscriber: EventSubscriptionHandlerFactory = (_db: Db) => {
  return async (_delivery: EventSubscriptionDelivery): Promise<EventSubscriptionOutcome> => {
    const boss = await getStartedBoss();
    await boss.send(
      LEARNER_PROFILE_REFRESH_QUEUE,
      {},
      { singletonKey: 'learner-profile-refresh', singletonSeconds: 2 },
    );
    return { status: 'succeeded' };
  };
};
