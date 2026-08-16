import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifact,
  event,
  event_subscription_checkpoint,
  event_subscription_delivery,
  event_subscription_effect,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { handleMasteryProgressNoteRefineDelivery } from './mastery-progress-subscription';

const SOURCE_EVENT_ID = 'mastery_progress_subscription_source';

async function seedSource(): Promise<void> {
  const now = new Date('2026-07-27T08:00:00.000Z');
  await testDb()
    .insert(artifact)
    .values({
      id: 'source_note',
      type: 'note_atomic',
      title: 'Source note',
      knowledge_ids: ['kc_subscription'],
      generation_status: 'ready',
      intent_source: 'test',
      source: 'test',
      verification_status: 'not_required',
      created_at: now,
      updated_at: now,
    });
  await writeEvent(testDb(), {
    id: 'attempt_subscription',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_subscription',
    outcome: 'success',
    payload: {
      answer_md: 'answer',
      answer_image_refs: [],
      referenced_knowledge_ids: ['kc_subscription'],
    },
    created_at: now,
  });
  await writeEvent(testDb(), {
    id: SOURCE_EVENT_ID,
    actor_kind: 'system',
    actor_ref: 'mastery_progress_signal',
    action: 'experimental:mastery_progress',
    subject_kind: 'knowledge',
    subject_id: 'kc_subscription',
    outcome: null,
    payload: {
      knowledge_id: 'kc_subscription',
      theta_delta: 0.2,
      p_learned: 0.8,
      theta_hat: 1.1,
      question_id: 'q_subscription',
      source_artifact_id: 'source_note',
      attempt_event_id: 'attempt_subscription',
      threshold_deferred: true,
    },
    caused_by_event_id: 'attempt_subscription',
    created_at: now,
  });
  const [source] = await testDb()
    .select({ dispatchSeq: event.dispatch_seq })
    .from(event)
    .where(eq(event.id, SOURCE_EVENT_ID));
  if (!source) throw new Error('source event was not seeded');
  await testDb().insert(event_subscription_checkpoint).values({
    subscriber_id: 'notes.mastery-progress-note-refine',
    subscriber_version: 1,
    declaration_hash: 'test',
    status: 'active',
    next_delivery_seq: 2,
    bootstrapped_at: now,
    activated_at: now,
  });
  await testDb().insert(event_subscription_delivery).values({
    subscriber_id: 'notes.mastery-progress-note-refine',
    subscriber_version: 1,
    source_event_id: SOURCE_EVENT_ID,
    source_dispatch_seq: source.dispatchSeq,
    delivery_seq: 1,
    status: 'pending',
  });
}

describe('mastery progress note-refine subscription', () => {
  beforeEach(async () => {
    await resetDb();
    await seedSource();
  });

  it('enqueues a source effect once and turns delivery replay into an idempotent success', async () => {
    const bossSend = vi.fn(async () => 'job-1');
    const delivery = {
      subscriberId: 'notes.mastery-progress-note-refine',
      subscriberVersion: 1,
      deliverySeq: '1',
      sourceEventId: SOURCE_EVENT_ID,
    };

    await expect(
      handleMasteryProgressNoteRefineDelivery(testDb(), delivery, { bossSend }),
    ).resolves.toEqual({
      status: 'succeeded',
      detail: {
        attempt_event_id: 'attempt_subscription',
        mastery_event_ids: [SOURCE_EVENT_ID],
        targets: 1,
        enqueued: 1,
        debounced: 0,
        alreadyProcessed: 0,
        disabled: 0,
      },
    });
    await expect(
      handleMasteryProgressNoteRefineDelivery(testDb(), delivery, { bossSend }),
    ).resolves.toEqual({
      status: 'succeeded',
      detail: {
        attempt_event_id: 'attempt_subscription',
        mastery_event_ids: [SOURCE_EVENT_ID],
        targets: 1,
        enqueued: 0,
        debounced: 0,
        alreadyProcessed: 1,
        disabled: 0,
      },
    });

    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith(
      'note_refine',
      expect.objectContaining({
        artifact_id: 'source_note',
        trigger: expect.objectContaining({
          kind: 'mastery_change',
          trigger_event_id: SOURCE_EVENT_ID,
          evidence_ids: ['attempt_subscription', SOURCE_EVENT_ID],
        }),
      }),
      expect.objectContaining({ db: expect.anything() }),
    );

    const effects = await testDb().select().from(event_subscription_effect);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      attempt_event_id: 'attempt_subscription',
      artifact_id: 'source_note',
      subscriber_id: 'notes.mastery-progress-note-refine',
      subscriber_version: 1,
      source_event_id: SOURCE_EVENT_ID,
      status: 'enqueued',
      downstream_job_id: 'job-1',
    });
  });

  it('rolls back the effect reservation when transactional enqueue fails', async () => {
    const bossSend = vi.fn(async () => null);
    const delivery = {
      subscriberId: 'notes.mastery-progress-note-refine',
      subscriberVersion: 1,
      deliverySeq: '1',
      sourceEventId: SOURCE_EVENT_ID,
    };

    await expect(
      handleMasteryProgressNoteRefineDelivery(testDb(), delivery, { bossSend }),
    ).rejects.toThrow('transactional send returned null');

    await expect(testDb().select().from(event_subscription_effect)).resolves.toEqual([]);
  });
});
