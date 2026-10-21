import { createHash } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { DOWNSTREAM_COMPLETION_CONTRACT } from '@/core/event-subscription-effect';
import type { Db, Tx } from '@/db/client';
import { event_subscription_effect } from '@/db/schema';
import type { RunNoteRefineResult } from '../jobs/note-refine';
import { notesBossTransaction } from './boss-port';
import type { NoteRefineBossSend } from './note-refine-triggers';
import { NOTE_REFINE_TRIGGER_DEBOUNCE_MS, noteRefineTriggerEnabled } from './note-refine-triggers';

type EffectRow = typeof event_subscription_effect.$inferSelect;

export type MasteryRefineEffectResult =
  | { status: 'enqueued' | 'debounced' | 'disabled'; effectId: string; effect: EffectRow }
  | { status: 'already_processed'; effectId: string; effect: EffectRow };

function stableEffectIdentity(attemptEventId: string, artifactId: string) {
  const digest = createHash('sha256')
    .update(`mastery_change\0${attemptEventId}\0${artifactId}`)
    .digest('hex');
  return {
    effectId: `mastery-refine-effect-${digest}`,
    stableJobKey: `mastery-refine-${digest}`,
  };
}

/**
 * Reserve the effect and enqueue its job atomically. The key ignores individual
 * KC siblings: one attempt owns one effect per target artifact, so a replay sees
 * the persisted effect instead of enqueueing again.
 */
export async function reserveAndEnqueueMasteryRefineEffect(input: {
  tx: Tx;
  bossSend: NoteRefineBossSend;
  attemptEventId: string;
  artifactId: string;
  masteryEventIds: string[];
  questionId?: string;
  subscriberId: string;
  subscriberVersion: number;
  sourceEventId: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<MasteryRefineEffectResult> {
  const masteryEventIds = [
    ...new Set(input.masteryEventIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (masteryEventIds.length === 0) throw new Error('masteryEventIds must not be empty');

  const now = input.now ?? new Date();
  const { effectId, stableJobKey } = stableEffectIdentity(input.attemptEventId, input.artifactId);
  const causalLock = `note_refine:effect:${input.attemptEventId}:${input.artifactId}:mastery_change`;
  const productLock = `note_refine:product:${input.artifactId}:mastery_change`;

  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${causalLock}))`);

  const existing = await input.tx
    .select()
    .from(event_subscription_effect)
    .where(
      and(
        eq(event_subscription_effect.attempt_event_id, input.attemptEventId),
        eq(event_subscription_effect.artifact_id, input.artifactId),
        eq(event_subscription_effect.effect_kind, 'mastery_change'),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return { status: 'already_processed', effectId: existing[0].id, effect: existing[0] };
  }

  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${productLock}))`);

  let status: 'enqueued' | 'debounced' | 'disabled';
  let downstreamJobId: string | null = null;
  let enqueuedAt: Date | null = null;

  if (!noteRefineTriggerEnabled('mastery_change', input.env ?? process.env)) {
    status = 'disabled';
  } else {
    const cutoff = new Date(now.getTime() - NOTE_REFINE_TRIGGER_DEBOUNCE_MS);
    const recent = await input.tx
      .select({ id: event_subscription_effect.id })
      .from(event_subscription_effect)
      .where(
        and(
          eq(event_subscription_effect.artifact_id, input.artifactId),
          eq(event_subscription_effect.effect_kind, 'mastery_change'),
          eq(event_subscription_effect.status, 'enqueued'),
          gt(event_subscription_effect.enqueued_at, cutoff),
        ),
      )
      .orderBy(desc(event_subscription_effect.enqueued_at))
      .limit(1);

    if (recent.length > 0) {
      status = 'debounced';
    } else {
      downstreamJobId = await input.bossSend(
        'note_refine',
        {
          artifact_id: input.artifactId,
          effect_id: effectId,
          trigger: {
            kind: 'mastery_change',
            context_md: input.questionId
              ? `Mastery signal raised for question ${input.questionId} (attempt succeeded).`
              : 'Mastery signal raised (attempt succeeded).',
            evidence_ids: [input.attemptEventId, ...masteryEventIds],
            trigger_event_id: input.sourceEventId,
          },
        },
        { db: notesBossTransaction(input.tx) },
      );
      if (downstreamJobId === null) {
        throw new Error('note_refine transactional send returned null');
      }
      status = 'enqueued';
      enqueuedAt = now;
    }
  }

  const inserted = await input.tx
    .insert(event_subscription_effect)
    .values({
      id: effectId,
      attempt_event_id: input.attemptEventId,
      artifact_id: input.artifactId,
      effect_kind: 'mastery_change',
      subscriber_id: input.subscriberId,
      subscriber_version: input.subscriberVersion,
      source_event_id: input.sourceEventId,
      mastery_event_ids: masteryEventIds,
      evidence_ids: [input.attemptEventId, ...masteryEventIds],
      question_id: input.questionId ?? null,
      status,
      stable_job_key: stableJobKey,
      downstream_job_id: downstreamJobId,
      reserved_at: now,
      enqueued_at: enqueuedAt,
      completed_at: status === 'enqueued' ? null : now,
      outcome:
        status === 'enqueued'
          ? { completion_contract: DOWNSTREAM_COMPLETION_CONTRACT }
          : { status },
      created_at: now,
      updated_at: now,
    })
    .returning();
  if (!inserted[0]) throw new Error('mastery refine effect was not persisted');
  return { status, effectId, effect: inserted[0] };
}

export async function recordMasteryRefineEffectResult(input: {
  db: Db | Tx;
  effectId: string;
  status: RunNoteRefineResult['status'];
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db
    .update(event_subscription_effect)
    .set({
      // Deferred patches live outside the logical ZIP, even after the job ends.
      completed_at: input.status === 'deferred' ? null : now,
      updated_at: now,
      outcome: sql`coalesce(${event_subscription_effect.outcome}, '{}'::jsonb) || ${JSON.stringify({
        completion_contract: DOWNSTREAM_COMPLETION_CONTRACT,
        status: input.status,
      })}::jsonb`,
    })
    .where(
      and(
        eq(event_subscription_effect.id, input.effectId),
        eq(event_subscription_effect.effect_kind, 'mastery_change'),
        isNull(event_subscription_effect.completed_at),
      ),
    );
}
