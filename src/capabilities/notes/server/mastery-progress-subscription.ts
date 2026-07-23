import type { EventSubscriptionHandlerFactory } from '@/kernel/manifest';

export const buildMasteryProgressNoteRefineSubscriber: EventSubscriptionHandlerFactory = () => {
  return async () => {
    throw new Error('mastery-progress note-refine subscription is not active');
  };
};
