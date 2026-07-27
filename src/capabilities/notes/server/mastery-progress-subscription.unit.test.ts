import { describe, expect, it } from 'vitest';
import { handleMasteryProgressNoteRefineDelivery } from './mastery-progress-subscription';

describe('mastery progress note-refine subscription', () => {
  it('supports an operator kill switch without touching the source event', async () => {
    const outcome = await handleMasteryProgressNoteRefineDelivery(
      {} as never,
      {
        subscriberId: 'notes.mastery-progress-note-refine',
        subscriberVersion: 1,
        deliverySeq: '1',
        sourceEventId: 'event-1',
      },
      { env: { NOTES_MASTERY_SUBSCRIPTION_ENABLED: 'false' } },
    );

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'mastery-progress note-refine subscription disabled by operator',
    });
  });
});
