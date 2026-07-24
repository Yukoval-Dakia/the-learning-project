import type { EventSubscriptionHandlerFactory } from '@/kernel/manifest';

export const buildMasteryProgressNoteRefineSubscriber: EventSubscriptionHandlerFactory = () => {
  return async () => {
    // Not active yet. Returning 'skipped' (vs throwing) is the semantically-correct terminal outcome
    // for an intentionally-inactive handler: throwing would drive every delivery through
    // failSubscriptionDelivery's retry → dead-letter path, burning attempts and accumulating
    // dead-letter rows + alert noise (YUK-751 review).
    return {
      status: 'skipped' as const,
      reason: 'mastery-progress note-refine subscription is not active',
    };
  };
};
