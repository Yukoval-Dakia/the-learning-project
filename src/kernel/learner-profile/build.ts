// Canonical learner-profile builder. Loads the same canonical component
// readings the incumbent learner-judgment read uses — mastery projection,
// FSRS scheduling facts, durations, non-KC role gate, activity clock — directly
// from the record owners (never through the public getKnowledgeState /
// readLearnerJudgments API, which avoids the profile→public-judgment→profile
// dependency cycle). Each KC's LearnerJudgment is then produced by the shared
// build-judgment projection. R(t) is evaluated from sealed FSRS state at the
// caller's evaluation time; it is never persisted as a constant.

import { and, eq, inArray } from 'drizzle-orm';
import type { LearnerJudgment } from '@/core/schema/learner-judgment';
import {
  type RetentionReading,
  type SchedulingState,
  SchedulingStateSchema,
} from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { event, material_fsrs_state } from '@/db/schema';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import { lastKnowledgeActivityAt } from '@/kernel/read-models/knowledge-activity';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import {
  type MasteryProjection,
  getMasteryProjection,
} from '@/kernel/read-models/mastery-projection';
import {
  type SchedulingReviewFact,
  lastRetrievalAt,
  recordedDurationMs,
} from '@/kernel/read-models/review-timing';
import { resolveSchedulingProjection } from '@/kernel/records/scheduling-state';
import { retrievabilityForKc, selectedForgettingEngine } from '@/kernel/scheduling';
import { type ComponentRead, buildLearnerJudgmentItem } from './build-judgment';

type DbLike = Db | Tx;

const UNREADABLE_RETENTION: RetentionReading = {
  kind: 'unknown',
  reason: 'state_or_history_unavailable',
  calibration: 'uncalibrated',
  provenance: 'engineering',
};

// Same component reads as the incumbent learner-judgment snapshot, sourced
// from the record owners. The builder and the compat reader deliberately share
// these inputs so the profile row and the read-only fallback return the same
// projection for one KC in one snapshot.
export interface CanonicalProfileInputs {
  mastery: ComponentRead<MasteryProjection>;
  scheduling: ComponentRead<SchedulingReviewFact>;
  retention: ComponentRead<RetentionReading>;
  durations: ReadonlyMap<string, number | null> | null;
  nonKcIds: ReadonlySet<string>;
  activity: ReadonlyMap<string, Date>;
  selectedEngine:
    | { kind: 'selected'; engine: 'fsrs' | 'forgetting_candidate' }
    | { kind: 'unknown'; reason: string };
  /** Per-KC resolved sealed memory state — the stable fact a drain persists so
   *  a later read re-evaluates R(t) at its own as_of instead of reusing a
   *  frozen constant. Ids without a card are absent. */
  schedulingState: Map<string, SchedulingStateEntry>;
}

/** The sealed memory-state fact the profile persists for one KC. */
export interface SchedulingStateEntry {
  state: SchedulingState;
  due_at: Date;
  state_readable: boolean;
  last_review_event_id: string | null;
}

/**
 * The stable canonical facts a drain persists per KC. Time-derived fields —
 * retention reading, evidence age, review timing, disagreement, judgement —
 * are re-derived from these at the caller's as_of through the shared
 * projection; the row never stores a frozen R(t) or stale wording.
 */
export interface PersistedProfileState {
  mastery:
    | (Omit<MasteryProjection, 'last_outcome_at'> & {
        last_outcome_at: Date | string | null;
      })
    | null;
  scheduling:
    | (Omit<SchedulingStateEntry, 'due_at' | 'state'> & {
        due_at: Date | string;
        state: SchedulingState | Record<string, unknown>;
      })
    | null;
  duration: { event_id: string | null; present: boolean; ms: number | null };
  activity: Date | string | null;
  non_kc: boolean;
}

function persistedDate(value: unknown, field: string): Date {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid persisted ${field}`);
  }
  return parsed;
}

function persistedEpochMs(value: unknown, field: string): number {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? /^-?\d+$/.test(value)
            ? Number(value)
            : Date.parse(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid persisted ${field}`);
  return parsed;
}

function schedulingStateFromPersisted(raw: unknown): SchedulingState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid persisted scheduling state');
  }
  const state = { ...(raw as Record<string, unknown>) };
  if ('due' in state) state.due = persistedDate(state.due, 'scheduling.state.due');
  if ('last_review' in state && state.last_review !== null) {
    state.last_review = persistedDate(state.last_review, 'scheduling.state.last_review');
  }
  if (state.modelDue && typeof state.modelDue === 'object' && !Array.isArray(state.modelDue)) {
    const modelDue = { ...(state.modelDue as Record<string, unknown>) };
    if ('at' in modelDue)
      modelDue.at = persistedEpochMs(modelDue.at, 'scheduling.state.modelDue.at');
    if ('checkedThrough' in modelDue) {
      modelDue.checkedThrough = persistedEpochMs(
        modelDue.checkedThrough,
        'scheduling.state.modelDue.checkedThrough',
      );
    }
    state.modelDue = modelDue;
  }
  return SchedulingStateSchema.parse(state);
}

async function loadSchedulingReviewFacts(
  db: DbLike,
  subjectKind: 'question' | 'knowledge',
  ids: string[],
  now: Date,
): Promise<{
  facts: Map<string, SchedulingReviewFact>;
  states: Map<string, SchedulingStateEntry>;
}> {
  const facts = new Map<string, SchedulingReviewFact>();
  const states = new Map<string, SchedulingStateEntry>();
  if (ids.length === 0) return { facts, states };
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        inArray(material_fsrs_state.subject_id, ids),
      ),
    );
  for (const raw of rows) {
    const eventId = raw.last_review_event_id ?? null;
    try {
      const row = await resolveSchedulingProjection(db, subjectKind, raw.subject_id, raw, now);
      facts.set(raw.subject_id, {
        reading: retrievabilityForKc(row.state, now),
        due_at: row.due_at,
        last_retrieval_at: lastRetrievalAt(row.state),
        state_readable: true,
        last_review_event_id: eventId,
      });
      states.set(raw.subject_id, {
        state: row.state,
        due_at: row.due_at,
        state_readable: true,
        last_review_event_id: eventId,
      });
    } catch (err) {
      // Legitimate unreadable stored state: the sealed card fails the schema
      // parse ('invalid scheduling state'). HostOperationNotInstalledError and
      // any other error are operational — they propagate so the caller's
      // component-failure mode decides, never a swallowed consume.
      const unreadable = err instanceof Error && err.message === 'invalid scheduling state';
      if (err instanceof HostOperationNotInstalledError || !unreadable) throw err;
      facts.set(raw.subject_id, {
        reading: UNREADABLE_RETENTION,
        due_at: raw.due_at,
        last_retrieval_at: null,
        state_readable: false,
        last_review_event_id: eventId,
      });
      // Persist the sealed raw state too: an unreadable card is itself a
      // stable fact; the read path re-derives the same UNREADABLE_RETENTION
      // named unknown from state_readable=false.
      states.set(raw.subject_id, {
        state: raw.state as SchedulingState,
        due_at: raw.due_at,
        state_readable: false,
        last_review_event_id: eventId,
      });
    }
  }
  return { facts, states };
}

async function durationsByEventId(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, number | null>> {
  const ids = [...new Set(eventIds)];
  const found = new Map<string, number | null>();
  if (ids.length === 0) return found;
  const allowed = await allowedEventIds(db, ids);
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, ids));
  for (const row of rows) {
    if (allowed.has(row.id)) found.set(row.id, recordedDurationMs(row.payload));
  }
  return found;
}

function retentionRead(
  scheduling: ComponentRead<SchedulingReviewFact>,
): ComponentRead<RetentionReading> {
  if (scheduling.kind === 'unknown') return scheduling;
  const values = new Map<string, RetentionReading>();
  for (const [id, fact] of scheduling.values) values.set(id, fact.reading);
  return { kind: 'available', values };
}

export class ProfileComponentError extends Error {
  constructor(
    readonly component: 'mastery' | 'retention' | 'durations' | 'engine' | 'activity',
    cause: unknown,
  ) {
    super(`canonical ${component} read failed`, { cause });
    this.name = 'ProfileComponentError';
  }
}

type ComponentFailureMode = { mode: 'throw' } | { mode: 'degrade' };

/**
 * Load every canonical input for `ids` inside `tx`'s snapshot. Component reads
 * use savepoints so a failed component is contained without aborting the
 * others. `onComponentFailure` decides what an operational read failure means:
 * the drain passes 'throw' so its transaction rolls back and the pending
 * intents stay retryable; the read-only getter passes 'degrade' so a live
 * component outage yields named unknowns for that read instead of failing it.
 * A legitimate lack of evidence (no mastery row, no card) is never a failure —
 * it reaches the projection as `missing_*_state`.
 */
export async function loadCanonicalProfileInputs(
  tx: Tx,
  ids: string[],
  asOf: Date,
  onComponentFailure: ComponentFailureMode = { mode: 'degrade' },
): Promise<CanonicalProfileInputs> {
  const fail = (
    component: 'mastery' | 'retention' | 'durations' | 'engine' | 'activity',
    cause: unknown,
  ) => {
    if (onComponentFailure.mode === 'throw') throw new ProfileComponentError(component, cause);
  };

  let selectedEngine: CanonicalProfileInputs['selectedEngine'];
  try {
    selectedEngine = { kind: 'selected', engine: selectedForgettingEngine() };
  } catch (err) {
    fail('engine', err);
    selectedEngine = { kind: 'unknown', reason: 'engine_selection_unavailable' };
  }

  let mastery: ComponentRead<MasteryProjection>;
  try {
    mastery = {
      kind: 'available',
      values: await tx.transaction((part) => getMasteryProjection(part, ids)),
    };
  } catch (err) {
    fail('mastery', err);
    mastery = { kind: 'unknown', reason: 'mastery_component_unavailable' };
  }

  let scheduling: ComponentRead<SchedulingReviewFact>;
  let schedulingState: CanonicalProfileInputs['schedulingState'] = new Map();
  let nonKcIds: ReadonlySet<string> = new Set();
  let durations: ReadonlyMap<string, number | null> | null = new Map();
  try {
    const loaded = await tx.transaction(async (part) => {
      nonKcIds = await getNonKcKnowledgeIds(part, ids);
      return loadSchedulingReviewFacts(
        part,
        'knowledge',
        ids.filter((id) => !nonKcIds.has(id)),
        asOf,
      );
    });
    scheduling = { kind: 'available', values: loaded.facts };
    schedulingState = loaded.states;
    const eventIds = [...loaded.facts.values()].flatMap((fact) =>
      fact.last_review_event_id ? [fact.last_review_event_id] : [],
    );
    try {
      durations = await tx.transaction((part) => durationsByEventId(part, eventIds));
    } catch (err) {
      fail('durations', err);
      durations = null;
    }
  } catch (err) {
    if (err instanceof ProfileComponentError) throw err;
    fail('retention', err);
    scheduling = { kind: 'unknown', reason: 'retention_component_unavailable' };
    durations = null;
  }

  let activity: ReadonlyMap<string, Date> = new Map();
  try {
    activity = await tx.transaction((part) => lastKnowledgeActivityAt(part, ids));
  } catch (err) {
    // An operational failure in the activity clock must not silently persist
    // an empty last_activity_at and consume the intent. Strict mode throws so
    // the drain rolls back and keeps the intent retryable; the read-only
    // getter degrades to an absent clock instead of failing the read.
    fail('activity', err);
    console.warn('[learner-profile] activity clock derivation failed', err);
    activity = new Map();
  }

  return {
    mastery,
    scheduling,
    retention: retentionRead(scheduling),
    durations,
    nonKcIds,
    activity,
    selectedEngine,
    schedulingState,
  };
}

/** Build one LearnerJudgment per id from canonical inputs already loaded. */
export function buildProfileJudgments(
  ids: string[],
  inputs: CanonicalProfileInputs,
  asOf: Date,
): LearnerJudgment[] {
  return ids.map((id) =>
    buildLearnerJudgmentItem({
      knowledgeId: id,
      mastery: inputs.mastery,
      retention: inputs.retention,
      asOf,
      scheduling: inputs.scheduling,
      durations: inputs.durations,
      nonKcIds: inputs.nonKcIds,
      activity: inputs.activity.get(id) ?? null,
    }),
  );
}

/** Serialize one KC's stable canonical inputs into the persisted state shape. */
export function persistedStateForKc(
  knowledgeId: string,
  inputs: CanonicalProfileInputs,
): PersistedProfileState {
  const masteryEntry =
    inputs.mastery.kind === 'available' ? (inputs.mastery.values.get(knowledgeId) ?? null) : null;
  const sched = inputs.schedulingState.get(knowledgeId) ?? null;
  const fact =
    inputs.scheduling.kind === 'available' ? inputs.scheduling.values.get(knowledgeId) : undefined;
  const eventId = sched?.last_review_event_id ?? fact?.last_review_event_id ?? null;
  return {
    mastery: masteryEntry,
    scheduling: sched
      ? {
          state: sched.state_readable ? schedulingStateFromPersisted(sched.state) : sched.state,
          due_at: sched.due_at.toISOString(),
          state_readable: sched.state_readable,
          last_review_event_id: sched.last_review_event_id,
        }
      : null,
    duration: {
      event_id: eventId,
      present: eventId !== null && (inputs.durations?.has(eventId) ?? false),
      ms: eventId !== null ? (inputs.durations?.get(eventId) ?? null) : null,
    },
    activity: inputs.activity.get(knowledgeId)?.toISOString() ?? null,
    non_kc: inputs.nonKcIds.has(knowledgeId),
  };
}

/**
 * Rebuild a current row's judgment at the caller's `as_of` from its persisted
 * stable facts. Retention reading, evidence age, review timing, disagreement
 * and judgement all re-evaluate through the shared projection — only the
 * sealed facts come from the row, never a frozen derived value.
 */
export function judgmentFromPersistedState(
  knowledgeId: string,
  persisted: PersistedProfileState,
  asOf: Date,
): LearnerJudgment {
  const masteryValues = new Map<string, MasteryProjection>();
  if (persisted.mastery) {
    masteryValues.set(knowledgeId, {
      ...persisted.mastery,
      last_outcome_at:
        persisted.mastery.last_outcome_at === null
          ? null
          : persistedDate(persisted.mastery.last_outcome_at, 'mastery.last_outcome_at'),
    });
  }
  const schedulingValues = new Map<string, SchedulingReviewFact>();
  const retentionValues = new Map<string, RetentionReading>();
  if (persisted.scheduling) {
    const dueAt = persistedDate(persisted.scheduling.due_at, 'scheduling.due_at');
    const state = persisted.scheduling.state_readable
      ? schedulingStateFromPersisted(persisted.scheduling.state)
      : null;
    const reading: RetentionReading = state
      ? retrievabilityForKc(state, asOf)
      : UNREADABLE_RETENTION;
    schedulingValues.set(knowledgeId, {
      reading,
      due_at: dueAt,
      last_retrieval_at: state ? lastRetrievalAt(state) : null,
      state_readable: persisted.scheduling.state_readable,
      last_review_event_id: persisted.scheduling.last_review_event_id,
    });
    retentionValues.set(knowledgeId, reading);
  }
  const durations = new Map<string, number | null>();
  if (persisted.duration.event_id && persisted.duration.present) {
    durations.set(persisted.duration.event_id, persisted.duration.ms);
  }
  return buildLearnerJudgmentItem({
    knowledgeId,
    mastery: { kind: 'available', values: masteryValues },
    retention: { kind: 'available', values: retentionValues },
    asOf,
    scheduling: { kind: 'available', values: schedulingValues },
    durations,
    nonKcIds: persisted.non_kc ? new Set([knowledgeId]) : new Set(),
    activity: persisted.activity ? persistedDate(persisted.activity, 'activity') : null,
  });
}
