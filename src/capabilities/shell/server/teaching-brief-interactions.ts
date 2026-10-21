// Append-only interaction ledger for the survival report: a brief was opened, or its
// prepared action was started. No derived status is written back.
//
// Row ids are deterministic in the idempotency key (brief × Asia/Shanghai learner-local
// day; action starts also key on action kind and probe question). The PK conflict is the
// serialization — no advisory lock is needed, and a lost race can only mislabel
// `idempotent`, never double-write.
//
// `ingest_at` opts every row out of the mem0 learner-fact collection.

import { and, eq } from 'drizzle-orm';
import { learnerLocalDay } from '@/core/learner-day';
import {
  BRIEF_SEEN_ACTION,
  type BriefState,
  PRIMARY_ACTION_STARTED_ACTION,
  type PrimaryActionKind,
} from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

export interface RecordInteractionResult {
  /** The append-only interaction event id (the existing row's id on an idempotent repeat). */
  interaction_event_id: string;
  /** The learner-local (Asia/Shanghai) day the interaction was bucketed under. */
  local_day: string;
  /** true when a prior identical interaction already existed — no second row was written. */
  idempotent: boolean;
}

// Shared with the offline report reader at compile time; the reader still validates at its
// boundary because a foreign or corrupt row is missing data, not truth.
export interface BriefSeenPayload {
  brief_state: BriefState;
  local_day: string;
  seen_at: string;
}

export interface PrimaryActionStartedPayload {
  action_kind: PrimaryActionKind;
  local_day: string;
  started_at: string;
  /** Present only for scoped_practice (the confirmed outcome's probe_result event id). */
  result_event_id?: string;
  /** Present only for answer_probe; distinguishes initial and recurrence starts. */
  probe_question_id?: string;
}

function encodeEventIdSegment(value: string): string {
  return encodeURIComponent(value);
}

// Encode each segment: legacy ids may contain `|`, and aliasing would silently drop a row.
function briefSeenEventId(briefId: string, localDay: string): string {
  return `bseen|${encodeEventIdSegment(briefId)}|${encodeEventIdSegment(localDay)}`;
}

function primaryActionEventId(
  briefId: string,
  actionKind: PrimaryActionKind,
  localDay: string,
  probeQuestionId?: string,
): string {
  if (actionKind === 'answer_probe') {
    return `bact|${encodeEventIdSegment(briefId)}|${actionKind}|${encodeEventIdSegment(
      probeQuestionId ?? '',
    )}|${encodeEventIdSegment(localDay)}`;
  }
  return `bact|${encodeEventIdSegment(briefId)}|${actionKind}|${encodeEventIdSegment(localDay)}`;
}

/** The pre-read only sets `idempotent`; the PK conflict is the real single-row guard. */
async function appendInteraction(
  db: Db,
  input: {
    id: string;
    action: typeof BRIEF_SEEN_ACTION | typeof PRIMARY_ACTION_STARTED_ACTION;
    briefId: string;
    localDay: string;
    payload: BriefSeenPayload | PrimaryActionStartedPayload;
    now: Date;
  },
): Promise<RecordInteractionResult> {
  const [existing] = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.id, input.id)))
    .limit(1);
  if (existing) {
    return { interaction_event_id: existing.id, local_day: input.localDay, idempotent: true };
  }

  await writeEvent(db, {
    id: input.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: input.action,
    // The stable brief id is the subject the report joins on.
    subject_kind: 'event',
    subject_id: input.briefId,
    payload: input.payload,
    caused_by_event_id: input.briefId,
    // mem0 opt-out (acceptance item 8): skip the ingest outbox + leave affected_scopes empty.
    ingest_at: input.now,
    created_at: input.now,
  });
  return { interaction_event_id: input.id, local_day: input.localDay, idempotent: false };
}

/** Idempotent per brief × local day; carries no claim, basis, or answer text. */
export async function recordBriefSeen(
  db: Db,
  input: { briefId: string; briefState: BriefState },
  now: Date = new Date(),
): Promise<RecordInteractionResult> {
  const localDay = learnerLocalDay(now);
  const payload: BriefSeenPayload = {
    brief_state: input.briefState,
    local_day: localDay,
    seen_at: now.toISOString(),
  };
  return appendInteraction(db, {
    id: briefSeenEventId(input.briefId, localDay),
    action: BRIEF_SEEN_ACTION,
    briefId: input.briefId,
    localDay,
    payload,
    now,
  });
}

/**
 * Idempotent per brief × action kind × local day; answer_probe also keys on question id so
 * recurrence is counted separately. No answer text is recorded.
 */
export async function recordPrimaryActionStarted(
  db: Db,
  input: {
    briefId: string;
    actionKind: PrimaryActionKind;
    resultEventId?: string;
    probeQuestionId?: string;
  },
  now: Date = new Date(),
): Promise<RecordInteractionResult> {
  // Mirror the route Zod refine for direct callers. Use truthiness so an empty
  // scoped_practice id throws instead of being dropped by the payload construction.
  if (input.actionKind === 'scoped_practice' && !input.resultEventId) {
    throw new Error('recordPrimaryActionStarted: scoped_practice requires resultEventId');
  }
  if (input.actionKind !== 'scoped_practice' && input.resultEventId) {
    throw new Error(
      'recordPrimaryActionStarted: resultEventId is only allowed for the scoped_practice action',
    );
  }
  if (input.actionKind === 'answer_probe' && !input.probeQuestionId) {
    throw new Error('recordPrimaryActionStarted: answer_probe requires probeQuestionId');
  }
  if (input.actionKind !== 'answer_probe' && input.probeQuestionId) {
    throw new Error(
      'recordPrimaryActionStarted: probeQuestionId is only allowed for the answer_probe action',
    );
  }
  const localDay = learnerLocalDay(now);
  const payload: PrimaryActionStartedPayload = {
    action_kind: input.actionKind,
    local_day: localDay,
    started_at: now.toISOString(),
    ...(input.resultEventId ? { result_event_id: input.resultEventId } : {}),
    ...(input.probeQuestionId ? { probe_question_id: input.probeQuestionId } : {}),
  };
  return appendInteraction(db, {
    id: primaryActionEventId(input.briefId, input.actionKind, localDay, input.probeQuestionId),
    action: PRIMARY_ACTION_STARTED_ACTION,
    briefId: input.briefId,
    localDay,
    payload,
    now,
  });
}
