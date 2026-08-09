import { parseFlag } from '@/core/env-flags';
import { MASTERY_PROGRESS_ACTION, MasteryProgressExperimental } from '@/core/schema/event';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { getEventById } from '@/kernel/events';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { and, asc, eq } from 'drizzle-orm';
import { getNotesBoss } from './boss-port';
import { reserveAndEnqueueMasteryRefineEffect } from './mastery-refine-effect';
import { collectMasteryRefineTargets } from './mastery-refine-targets';
import type { NoteRefineBossSend } from './note-refine-triggers';

const SUBSCRIPTION_ENABLED_ENV = 'NOTES_MASTERY_SUBSCRIPTION_ENABLED';

interface MasteryProgressSubscriptionDeps {
  bossSend?: NoteRefineBossSend;
  env?: NodeJS.ProcessEnv;
}

export async function handleMasteryProgressNoteRefineDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: MasteryProgressSubscriptionDeps = {},
): Promise<EventSubscriptionOutcome> {
  if (
    !parseFlag((deps.env ?? process.env)[SUBSCRIPTION_ENABLED_ENV], {
      defaultValue: true,
    })
  ) {
    return {
      status: 'skipped',
      reason: 'mastery-progress note-refine subscription disabled by operator',
    };
  }

  const source = await getEventById(db, delivery.sourceEventId);
  if (!source) {
    throw new Error(`mastery-progress source event '${delivery.sourceEventId}' was not found`);
  }
  if (source.action !== MASTERY_PROGRESS_ACTION) {
    return { status: 'skipped', reason: `unexpected source action '${source.action}'` };
  }
  const masteryEvent = MasteryProgressExperimental.parse(source);
  const attemptEventId = masteryEvent.payload.attempt_event_id;
  if (
    !attemptEventId ||
    (masteryEvent.caused_by_event_id && masteryEvent.caused_by_event_id !== attemptEventId)
  ) {
    return { status: 'skipped', reason: 'invalid causal attempt' };
  }

  const attempt = await getEventById(db, attemptEventId);
  if (
    !attempt ||
    !['attempt', 'review'].includes(attempt.action) ||
    !('subject_kind' in attempt) ||
    attempt.subject_kind !== 'question' ||
    !('subject_id' in attempt) ||
    typeof attempt.subject_id !== 'string'
  ) {
    return { status: 'skipped', reason: 'invalid causal attempt' };
  }
  const questionId = attempt.subject_id;
  if (masteryEvent.payload.question_id && masteryEvent.payload.question_id !== questionId) {
    return { status: 'skipped', reason: 'question mismatch' };
  }

  // The publisher writes every KC sibling in one batch transaction. Once one
  // delivery is visible, the complete immutable sibling set is therefore
  // visible and can be folded into one causal effect per note.
  const siblingRows = await db
    .select()
    .from(event)
    .where(
      and(eq(event.action, MASTERY_PROGRESS_ACTION), eq(event.caused_by_event_id, attemptEventId)),
    )
    .orderBy(asc(event.dispatch_seq), asc(event.id));
  const siblings = siblingRows.map((row) => ({
    id: row.id,
    parsed: MasteryProgressExperimental.parse({
      actor_kind: row.actor_kind,
      actor_ref: row.actor_ref,
      action: row.action,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      outcome: row.outcome,
      payload: row.payload,
      caused_by_event_id: row.caused_by_event_id ?? undefined,
      task_run_id: row.task_run_id ?? undefined,
      cost_micro_usd: row.cost_micro_usd ?? undefined,
    }),
  }));
  const causalSiblings = siblings.filter(
    ({ parsed }) =>
      parsed.payload.attempt_event_id === attemptEventId &&
      (!parsed.payload.question_id || parsed.payload.question_id === questionId),
  );
  if (causalSiblings.length === 0) {
    return { status: 'skipped', reason: 'mastery siblings not found' };
  }

  const masteryEventIds = causalSiblings.map(({ id }) => id);
  const knowledgeIds = causalSiblings.map(({ parsed }) => parsed.payload.knowledge_id);
  const sourceArtifactId =
    causalSiblings.find(({ parsed }) => parsed.payload.source_artifact_id)?.parsed.payload
      .source_artifact_id ?? null;
  const targets = await collectMasteryRefineTargets(db, sourceArtifactId, knowledgeIds);
  if (targets.length === 0) return { status: 'skipped', reason: 'no live note targets' };

  let send = deps.bossSend;
  if (!send) {
    const boss = await getNotesBoss();
    send = boss.send.bind(boss);
  }
  const counts = {
    targets: targets.length,
    enqueued: 0,
    debounced: 0,
    alreadyProcessed: 0,
    disabled: 0,
  };

  for (const artifactId of targets) {
    const result = await db.transaction((tx) =>
      reserveAndEnqueueMasteryRefineEffect({
        tx,
        bossSend: send,
        attemptEventId,
        artifactId,
        masteryEventIds,
        questionId,
        subscriberId: delivery.subscriberId,
        subscriberVersion: delivery.subscriberVersion,
        sourceEventId: delivery.sourceEventId,
        env: deps.env,
      }),
    );
    switch (result.status) {
      case 'enqueued':
        counts.enqueued += 1;
        break;
      case 'debounced':
        counts.debounced += 1;
        break;
      case 'already_processed':
        counts.alreadyProcessed += 1;
        break;
      case 'disabled':
        counts.disabled += 1;
        break;
    }
  }

  return {
    status: 'succeeded',
    detail: { attempt_event_id: attemptEventId, mastery_event_ids: masteryEventIds, ...counts },
  };
}

export const buildMasteryProgressNoteRefineSubscriber: EventSubscriptionHandlerFactory = (
  db: Db,
) => {
  return (delivery) => handleMasteryProgressNoteRefineDelivery(db, delivery);
};
