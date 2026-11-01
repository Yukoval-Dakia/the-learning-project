import { eq } from 'drizzle-orm';
import {
  DREAMING_NOTE_REFRESH_ACTION,
  DreamingNoteRefreshPayload,
} from '@/core/schema/event/dreaming-note-refresh';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import {
  type NoteRefineBossSend,
  type NoteRefineTriggerResult,
  enqueueDreamingNoteRefine,
} from './note-refine-triggers';

interface DreamingNoteRefreshRow {
  action: string;
  subject_id: string;
  payload: unknown;
}

type RefreshRead =
  | { kind: 'missing' }
  | { kind: 'skip'; reason: string }
  | { kind: 'refresh'; artifactId: string; triggerEventId: string };

type EnqueueDisposition =
  | { kind: 'done'; enqueue: 'enqueued' | 'debounced' }
  | { kind: 'skip'; reason: string }
  | { kind: 'retry'; error: string };

function readDreamingNoteRefresh(row: DreamingNoteRefreshRow | undefined): RefreshRead {
  if (!row) return { kind: 'missing' };
  if (row.action !== DREAMING_NOTE_REFRESH_ACTION) {
    return { kind: 'skip', reason: `unexpected source action '${row.action}'` };
  }
  const parsed = DreamingNoteRefreshPayload.safeParse(row.payload);
  if (!parsed.success)
    return { kind: 'skip', reason: 'dreaming note refresh payload is malformed' };
  if (parsed.data.artifact_id !== row.subject_id) {
    return {
      kind: 'skip',
      reason: 'dreaming note refresh artifact does not match the event subject',
    };
  }
  return {
    kind: 'refresh',
    artifactId: parsed.data.artifact_id,
    triggerEventId: parsed.data.trigger_event_id,
  };
}

function disposition(result: NoteRefineTriggerResult): EnqueueDisposition {
  switch (result.status) {
    case 'enqueued':
      return { kind: 'done', enqueue: 'enqueued' };
    case 'skipped:debounced':
      return { kind: 'done', enqueue: 'debounced' };
    case 'skipped:disabled':
      return { kind: 'skip', reason: 'dreaming note refine disabled' };
    case 'skipped:test_env':
      return { kind: 'skip', reason: 'background jobs are not enqueued in this environment' };
    case 'failed':
      return { kind: 'retry', error: result.error };
  }
}

export async function handleDreamingNoteRefreshDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: { bossSend?: NoteRefineBossSend } = {},
): Promise<EventSubscriptionOutcome> {
  const [row] = await db
    .select({
      action: event.action,
      subject_id: event.subject_id,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, delivery.sourceEventId))
    .limit(1);
  const refresh = readDreamingNoteRefresh(row);
  if (refresh.kind === 'missing') {
    throw new Error(`dreaming note refresh event '${delivery.sourceEventId}' was not found`);
  }
  if (refresh.kind === 'skip') return { status: 'skipped', reason: refresh.reason };

  const outcome = disposition(
    await enqueueDreamingNoteRefine({
      db,
      artifactId: refresh.artifactId,
      triggerEventId: refresh.triggerEventId,
      bossSend: deps.bossSend,
    }),
  );
  if (outcome.kind === 'retry') {
    throw new Error(
      `dreaming note refresh enqueue failed for ${refresh.artifactId}: ${outcome.error}`,
    );
  }
  if (outcome.kind === 'skip') return { status: 'skipped', reason: outcome.reason };
  return {
    status: 'succeeded',
    detail: { artifact_id: refresh.artifactId, enqueue: outcome.enqueue },
  };
}

export const buildDreamingNoteRefreshSubscriber: EventSubscriptionHandlerFactory = (db) => {
  return (delivery) => handleDreamingNoteRefreshDelivery(db, delivery);
};
