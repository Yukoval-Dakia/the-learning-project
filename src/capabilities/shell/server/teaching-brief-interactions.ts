// YUK-710 (P0F/6) — the append-only teaching-brief interaction ledger.
//
// Two minimal, opt-out-of-mem0 UI-interaction events power the two-week survival report
// (scripts/report-teaching-brief.ts) WITHOUT a new table, a new gate, or a third-party
// analytics platform:
//
//   - `experimental:brief_seen`            — the learner opened a delivered brief.
//   - `experimental:primary_action_started` — the learner started a brief's prepared action.
//
// Everything else the report needs already exists and is NOT re-instrumented here: the
// proposal decision (accept/edit/dismiss) is the canonical `rate` event, the probe outcome
// is `experimental:probe_result`, and the outcome dismissal is `experimental:brief_acknowledged`
// (teaching-brief-ack.ts). This module only adds the two funnel-entry signals those events
// cannot express.
//
// Idempotency (contract-style, mirrors the ack writer's "one effective row" guarantee but
// without an advisory lock): each event's row id is DETERMINISTIC in its idempotency key —
// `brief_id × learner-local day` for a seen, `brief_id × action_kind × learner-local day` for
// an action start. writeEvent's `onConflictDoNothing({ target: event.id })` then makes a
// re-render / React Query refetch / reload / dev strict-mode double-invoke a hard no-op at the
// PK, so the ledger can never inflate. The PK conflict IS the serialization, so unlike the ack
// (whose idempotency key ≠ its event id and which needs a deliverability re-check under lock)
// no advisory lock is required. The pre-INSERT existence read only reports `idempotent`
// accurately; the PK is the real guard, so a lost race just mis-labels the flag, never
// double-writes.
//
// "learner-local day" = Asia/Shanghai calendar day (learnerLocalDay), the project-wide learner
// day boundary (fixed UTC+8, matching the house crons / overnight-digest / learner-state).
//
// mem0 opt-out (acceptance item 8, mirrors the ack event): every row is written with
// `ingest_at = now`, so the memory-ingestion outbox poller skips it, and — because ingest_at is
// non-null and affected_scopes is left unset — writeEvent stamps an empty scope set, so no brief
// scan can mistake an internal interaction row for learner evidence. These rows never reach the
// mem0 learner-fact collection. This is a pure observational ledger: it writes NO derived status
// back onto the proposal / question / result, and touches NO FSRS / mastery / θ̂ state.

import { learnerLocalDay } from '@/core/learner-day';
import {
  BRIEF_SEEN_ACTION,
  type BriefState,
  PRIMARY_ACTION_STARTED_ACTION,
  type PrimaryActionKind,
} from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { and, eq } from 'drizzle-orm';

export interface RecordInteractionResult {
  /** The append-only interaction event id (the existing row's id on an idempotent repeat). */
  interaction_event_id: string;
  /** The learner-local (Asia/Shanghai) day the interaction was bucketed under. */
  local_day: string;
  /** true when a prior identical interaction already existed — no second row was written. */
  idempotent: boolean;
}

// The two ledger payload shapes are the SINGLE contract between this writer and the offline
// report reader (scripts/report-teaching-brief.ts imports them as types), so the read side is
// connected to the write side at compile time and cannot silently drift from the fields written
// here. All fields are always written; the reader still validates at the boundary (a foreign /
// corrupt row is treated as missing data, never trusted blindly).
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
}

// `|` never appears in a cuid2 / `evt_*` event id, the fixed PrimaryActionKind enum, or a
// `YYYY-MM-DD` day, so these composites collide iff every idempotency-key field matches.
function briefSeenEventId(briefId: string, localDay: string): string {
  return `bseen|${briefId}|${localDay}`;
}

function primaryActionEventId(
  briefId: string,
  actionKind: PrimaryActionKind,
  localDay: string,
): string {
  return `bact|${briefId}|${actionKind}|${localDay}`;
}

/**
 * Append the interaction row under its deterministic idempotency-key id. The pre-read only
 * decides the returned `idempotent` flag; the PK `onConflictDoNothing` inside writeEvent is
 * the actual single-row guarantee. `ingest_at = now` + the resulting empty affected_scopes
 * keep the row out of mem0 (see file header).
 */
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
    // The brief (its stable id = the conjecture proposal event id) is the subject; the report
    // joins interactions to briefs on subject_id. caused_by keeps the evidence chain to the brief.
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

/**
 * Record that the learner opened a delivered brief. Idempotent per brief_id × learner-local
 * day. Carries only the brief state + timestamps as metadata — never claim / basis / answer text.
 */
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
 * Record that the learner started a brief's prepared action. Idempotent per
 * brief_id × action_kind × learner-local day (so a double-click never inflates the funnel).
 * `resultEventId` is present only for scoped_practice (the confirmed outcome's probe_result), so
 * the report can join a confirmed outcome to its practice start. NO answer text is ever recorded.
 */
export async function recordPrimaryActionStarted(
  db: Db,
  input: { briefId: string; actionKind: PrimaryActionKind; resultEventId?: string },
  now: Date = new Date(),
): Promise<RecordInteractionResult> {
  const localDay = learnerLocalDay(now);
  const payload: PrimaryActionStartedPayload = {
    action_kind: input.actionKind,
    local_day: localDay,
    started_at: now.toISOString(),
    ...(input.resultEventId ? { result_event_id: input.resultEventId } : {}),
  };
  return appendInteraction(db, {
    id: primaryActionEventId(input.briefId, input.actionKind, localDay),
    action: PRIMARY_ACTION_STARTED_ACTION,
    briefId: input.briefId,
    localDay,
    payload,
    now,
  });
}
