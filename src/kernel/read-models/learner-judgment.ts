import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  type JudgmentUnknown,
  type LearnerJudgment,
  type LearnerJudgmentBatch,
  type LearnerJudgmentInput,
  LearnerJudgmentInputSchema,
  type ReviewTiming,
} from '@/core/schema/learner-judgment';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import { event, material_fsrs_state } from '@/db/schema';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import {
  type ComponentRead,
  buildLearnerJudgmentItem,
  isComponentFailureReason,
  retentionAvailable,
  retentionValue,
} from '@/kernel/learner-profile/build-judgment';
import { lastKnowledgeActivityAt } from '@/kernel/read-models/knowledge-activity';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import { resolveSchedulingProjection } from '@/kernel/records/scheduling-state';
import { retrievabilityForKc, selectedForgettingEngine } from '@/kernel/scheduling';
import { type MasteryProjection, getMasteryProjection } from './mastery-projection';
import {
  type SchedulingReviewFact,
  cardBasis,
  lastRetrievalAt,
  recordedDurationMs,
  reviewTiming,
} from './review-timing';

type DbLike = Db | Tx;
type MasteryReader = (db: DbLike, ids: string[]) => Promise<Map<string, MasteryProjection>>;

function unknown(reason: string): JudgmentUnknown {
  return { kind: 'unknown', reason };
}

function judgment(
  id: string,
  mastery: ComponentRead<MasteryProjection>,
  retention: ComponentRead<RetentionReading>,
  asOf: Date,
  scheduling: ComponentRead<SchedulingReviewFact>,
  durations: ReadonlyMap<string, number | null> | null,
  nonKcIds: ReadonlySet<string> = new Set(),
  // any-event activity clock from the event spine; null when the
  // derivation found nothing (or was not run for this read path).
  activity: Date | null = null,
): LearnerJudgment {
  return buildLearnerJudgmentItem({
    knowledgeId: id,
    mastery,
    retention,
    asOf,
    scheduling,
    durations,
    nonKcIds,
    activity,
  });
}

/**
 * Evidenced ability only, failing closed when the ability component did not
 * answer. Insufficient evidence, inferred-only neighbours, and roles that are
 * not mastery-evaluable are omitted: a missing key is not a cold-start low
 * score. The raw reading stays on the item.
 */
export function abilityReadingsByIdOrFail(
  batch: LearnerJudgmentBatch,
): Map<string, MasteryProjection> {
  for (const item of batch.items) {
    if (item.ability.kind === 'unknown' && isComponentFailureReason(item.ability.reason)) {
      throw new Error(`learner-judgment ability component failed: ${item.ability.reason}`);
    }
    if (item.ability_claim.kind === 'unavailable') {
      throw new Error(`learner-judgment ability component failed: ${item.ability_claim.reason}`);
    }
  }
  const byId = new Map<string, MasteryProjection>();
  for (const item of batch.items) {
    if (item.ability_claim.kind !== 'low_observed' && item.ability_claim.kind !== 'observed') {
      continue;
    }
    if (item.ability.kind !== 'available') continue;
    byId.set(item.knowledge_id, item.ability.reading);
  }
  return byId;
}

function retentionRead(
  scheduling: ComponentRead<SchedulingReviewFact>,
): ComponentRead<RetentionReading> {
  if (scheduling.kind === 'unknown') return scheduling;
  const values = new Map<string, RetentionReading>();
  for (const [id, fact] of scheduling.values) values.set(id, fact.reading);
  return { kind: 'available', values };
}

const UNREADABLE_RETENTION: RetentionReading = {
  kind: 'unknown',
  reason: 'state_or_history_unavailable',
  calibration: 'uncalibrated',
  provenance: 'engineering',
};

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
  // Durations are a derived-input read too — a restricted event contributes no
  // signal (its duration is simply absent), never a peek past consent.
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

/**
 * One batch identity, one evaluation time, two incumbent owners. No fused P,
 * new model, write, issuance or provider call. A new Db transaction establishes
 * a read-only repeatable snapshot; an existing Tx must already provide one.
 */
export async function readLearnerJudgments(
  db: DbLike,
  input: LearnerJudgmentInput,
  // Preserve the existing Copilot mastery-reader injection. This is an explicit
  // partial source override: no DB access or fictitious retention/snapshot is
  // added to an injected read. Production supplies no override.
  deps: { getMasteryProjectionFn?: MasteryReader } = {},
): Promise<LearnerJudgmentBatch> {
  const parsed = LearnerJudgmentInputSchema.parse(input);
  const ids = [...new Set(parsed.knowledge_ids)];
  const asOf = new Date(parsed.as_of.getTime());
  const batch: LearnerJudgmentBatch = {
    version: 'v0-incumbent',
    calibration: 'uncalibrated',
    context: parsed.context,
    as_of: asOf,
    consistency: unknown('snapshot_not_established'),
    components: {
      ability: {
        source: 'kernel/read-models/mastery-projection:getMasteryProjection',
        version: unknown('incumbent_port_does_not_expose_component_version'),
        input_high_water: unknown('incumbent_port_does_not_expose_input_high_water'),
      },
      retention: {
        source: 'kernel/scheduling:retrievabilityForKc',
        selected_engine: unknown('engine_not_read'),
        version: unknown('incumbent_port_does_not_expose_component_version'),
        input_high_water: unknown('incumbent_port_does_not_expose_input_high_water'),
      },
    },
    input_high_water: unknown('incumbent_ports_do_not_expose_complete_input_high_water'),
    calibration_evidence: unknown('sealed_outcome_pairs_not_connected'),
    sealing: 'not_connected',
    items: [],
  };
  const unavailable = (reason: string) => {
    const failed = unknown(reason);
    batch.items = ids.map((id) => judgment(id, failed, failed, asOf, failed, null));
    return batch;
  };
  if (ids.length === 0) return batch;

  const injectedMastery = deps.getMasteryProjectionFn;
  if (injectedMastery) {
    batch.consistency = unknown('injected_partial_source');
    batch.components.ability.version = unknown('injected_source');
    let mastery: ComponentRead<MasteryProjection>;
    try {
      mastery = { kind: 'available', values: await injectedMastery(db, ids) };
    } catch {
      mastery = unknown('mastery_component_unavailable');
    }
    const unread = unknown('retention_source_not_injected');
    // The injected read stays a partial source override: no extra DB access,
    // so the any-event clock stays null (the practice clock still comes from
    // the injected mastery entries).
    batch.items = ids.map((id) => judgment(id, mastery, unread, asOf, unread, null));
    return batch;
  }

  try {
    batch.components.retention.selected_engine = {
      kind: 'selected',
      engine: selectedForgettingEngine(),
    };
  } catch {
    batch.components.retention.selected_engine = unknown('engine_selection_unavailable');
  }

  const readSnapshot = async (tx: Tx): Promise<LearnerJudgmentBatch> => {
    // Isolate errors with savepoints so a failed component query does not abort
    // the other component's read. Reads are sequential on the same connection.
    let mastery: ComponentRead<MasteryProjection>;
    try {
      mastery = {
        kind: 'available',
        values: await tx.transaction((part) => getMasteryProjection(part, ids)),
      };
    } catch {
      mastery = unknown('mastery_component_unavailable');
    }
    let scheduling: ComponentRead<SchedulingReviewFact>;
    let nonKcIds: ReadonlySet<string> = new Set();
    let durations: ReadonlyMap<string, number | null> | null = new Map();
    if (batch.components.retention.selected_engine.kind === 'unknown') {
      scheduling = unknown('engine_selection_unavailable');
    } else {
      try {
        scheduling = {
          kind: 'available',
          values: await tx.transaction(async (part) => {
            // YUK-1600: retention is a mastery-family reading, so goal/container
            // roots never read FSRS R(t), even where pre-gate stock rows exist.
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
        scheduling = unknown('retention_component_unavailable');
        durations = null;
      }
    }
    const retention = retentionRead(scheduling);
    // the learner activity clock rides the same snapshot in its
    // own savepoint; a failed derivation degrades to per-item null (display
    // clock, fail-soft) instead of aborting the ability/retention readings.
    let activity: ReadonlyMap<string, Date> = new Map();
    try {
      activity = await tx.transaction((part) => lastKnowledgeActivityAt(part, ids));
    } catch (err) {
      console.warn('[learner-judgment] activity clock derivation failed', err);
      activity = new Map();
    }
    batch.items = ids.map((id) =>
      judgment(
        id,
        mastery,
        retention,
        asOf,
        scheduling,
        durations,
        nonKcIds,
        activity.get(id) ?? null,
      ),
    );
    return batch;
  };

  try {
    if ('$client' in db) {
      const result = await db.transaction(readSnapshot, {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
      result.consistency = {
        kind: 'snapshot',
        isolation: 'repeatable read',
        access: 'read only',
      };
      return result;
    }
    // A savepoint cannot upgrade its parent's snapshot or access mode. Do not
    // silently label a caller's read-committed/write transaction as a snapshot.
    const settings = await db.execute<{ isolation: string; read_only: string }>(sql`
      select current_setting('transaction_isolation') as isolation,
             current_setting('transaction_read_only') as read_only
    `);
    const setting = settings[0];
    if (
      setting?.read_only !== 'on' ||
      (setting.isolation !== 'repeatable read' && setting.isolation !== 'serializable')
    ) {
      return unavailable('caller_transaction_is_not_a_read_only_snapshot');
    }
    await readSnapshot(db);
    batch.consistency = {
      kind: 'snapshot',
      isolation: setting.isolation,
      access: 'read only',
    };
    return batch;
  } catch {
    batch.consistency = unknown('snapshot_unavailable');
    return unavailable('snapshot_unavailable');
  }
}

/** Unlabeled question card. No ability row exists on this subject, so freshness
 * stays unknown unless the card's own retention point is high enough for a shelf. */
export async function readQuestionCardReviewTiming(
  db: DbLike,
  questionId: string,
  asOf: Date,
): Promise<ReviewTiming | null> {
  return (await readQuestionCardReviewTimings(db, [questionId], asOf)).get(questionId) ?? null;
}

/**
 * Batch form of the unlabeled question card read: one scheduling-facts load and one
 * duration read for the whole page. Cards that do not exist are simply absent.
 */
export async function readQuestionCardReviewTimings(
  db: DbLike,
  questionIds: readonly string[],
  asOf: Date,
): Promise<Map<string, ReviewTiming>> {
  const out = new Map<string, ReviewTiming>();
  const ids = [...new Set(questionIds)];
  if (ids.length === 0) return out;
  const facts = await loadSchedulingReviewFacts(db, 'question', ids, asOf);
  if (facts.size === 0) return out;
  const eventIds = [...facts.values()]
    .map((fact) => fact.last_review_event_id)
    .filter((id): id is string => id !== null);
  let durations: ReadonlyMap<string, number | null> | null = new Map();
  if (eventIds.length > 0) {
    try {
      durations = await durationsByEventId(db, eventIds);
    } catch {
      durations = null;
    }
  }
  for (const id of ids) {
    const fact = facts.get(id);
    if (!fact) continue;
    const basis = cardBasis({
      presence: 'present',
      due_at: fact.due_at,
      state_readable: fact.state_readable,
      last_retrieval_at: fact.last_retrieval_at,
      event_id: fact.last_review_event_id,
      durations,
    });
    out.set(
      id,
      reviewTiming({
        asOf,
        ability: unknown('question_card_has_no_ability_reading'),
        retention: retentionAvailable(fact.reading),
        ...basis,
      }),
    );
  }
  return out;
}
