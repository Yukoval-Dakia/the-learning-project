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
import type { RetentionReading } from '@/core/schema/scheduling-state';
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
}

async function loadSchedulingReviewFacts(
  db: DbLike,
  subjectKind: 'question' | 'knowledge',
  ids: string[],
  now: Date,
): Promise<Map<string, SchedulingReviewFact>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        inArray(material_fsrs_state.subject_id, ids),
      ),
    );
  const values = new Map<string, SchedulingReviewFact>();
  for (const raw of rows) {
    const eventId = raw.last_review_event_id ?? null;
    try {
      const row = await resolveSchedulingProjection(db, subjectKind, raw.subject_id, raw, now);
      values.set(raw.subject_id, {
        reading: retrievabilityForKc(row.state, now),
        due_at: row.due_at,
        last_retrieval_at: lastRetrievalAt(row.state),
        state_readable: true,
        last_review_event_id: eventId,
      });
    } catch (err) {
      if (err instanceof HostOperationNotInstalledError) throw err;
      values.set(raw.subject_id, {
        reading: UNREADABLE_RETENTION,
        due_at: raw.due_at,
        last_retrieval_at: null,
        state_readable: false,
        last_review_event_id: eventId,
      });
    }
  }
  return values;
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

/**
 * Load every canonical input for `ids` inside `tx`'s snapshot. Component reads
 * use savepoints so a failed component degrades to its named unknown without
// aborting the others.
 */
export async function loadCanonicalProfileInputs(
  tx: Tx,
  ids: string[],
  asOf: Date,
): Promise<CanonicalProfileInputs> {
  let selectedEngine: CanonicalProfileInputs['selectedEngine'];
  try {
    selectedEngine = { kind: 'selected', engine: selectedForgettingEngine() };
  } catch {
    selectedEngine = { kind: 'unknown', reason: 'engine_selection_unavailable' };
  }

  let mastery: ComponentRead<MasteryProjection>;
  try {
    mastery = {
      kind: 'available',
      values: await tx.transaction((part) => getMasteryProjection(part, ids)),
    };
  } catch {
    mastery = { kind: 'unknown', reason: 'mastery_component_unavailable' };
  }

  let scheduling: ComponentRead<SchedulingReviewFact>;
  let nonKcIds: ReadonlySet<string> = new Set();
  let durations: ReadonlyMap<string, number | null> | null = new Map();
  try {
    scheduling = {
      kind: 'available',
      values: await tx.transaction(async (part) => {
        nonKcIds = await getNonKcKnowledgeIds(part, ids);
        return loadSchedulingReviewFacts(
          part,
          'knowledge',
          ids.filter((id) => !nonKcIds.has(id)),
          asOf,
        );
      }),
    };
    const eventIds = [...scheduling.values.values()].flatMap((fact) =>
      fact.last_review_event_id ? [fact.last_review_event_id] : [],
    );
    try {
      durations = await tx.transaction((part) => durationsByEventId(part, eventIds));
    } catch {
      durations = null;
    }
  } catch {
    scheduling = { kind: 'unknown', reason: 'retention_component_unavailable' };
    durations = null;
  }

  let activity: ReadonlyMap<string, Date> = new Map();
  try {
    activity = await tx.transaction((part) => lastKnowledgeActivityAt(part, ids));
  } catch (err) {
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
