// Review-facing reading on the learner-judgment contract.
// Point recall is the incumbent R(t). The interval stays unestimated because
// population or engineering parameters are not a personal calibration.
// Freshness reuses the existing decay bucket; missing inputs stay unknown.

import { MASTERY_BAND_THRESHOLDS, masteryBandIdx } from '@/core/mastery-band';
import { masteryDecayBucket } from '@/core/mastery-freshness';
import type {
  LearnerJudgment,
  ReviewTiming,
  ReviewTimingJson,
} from '@/core/schema/learner-judgment';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import { type SchedulingState, isCandidateState } from '@/core/schema/scheduling-state';

export interface SchedulingReviewFact {
  reading: RetentionReading;
  due_at: Date;
  /** Null when the card has no retrieval timestamp. Ignored when state_readable is false. */
  last_retrieval_at: Date | null;
  state_readable: boolean;
  last_review_event_id: string | null;
}

// A new FSRS card can carry an enrollment clock. That is not a retrieval.
export function lastRetrievalAt(state: SchedulingState): Date | null {
  if (isCandidateState(state)) return state.last_review;
  if (state.reps <= 0 || state.state === 'new') return null;
  return state.last_review ?? null;
}

const UNCALIBRATED_RECALL_INTERVAL = {
  kind: 'not_estimated',
  calibration: 'uncalibrated',
} as const;

type Instant = ReviewTiming['basis']['last_retrieval_at'];
type Duration = ReviewTiming['basis']['duration_ms'];
type Due = ReviewTiming['freshness']['due_at'];

export type CardBasisInput =
  | { presence: 'unread'; reason: string }
  | { presence: 'absent'; reason: string }
  | {
      presence: 'present';
      due_at: Date;
      state_readable: boolean;
      last_retrieval_at: Date | null;
      event_id: string | null;
      durations: ReadonlyMap<string, number | null> | null;
    };

function unknown(reason: string): { kind: 'unknown'; reason: string } {
  return { kind: 'unknown', reason };
}

// duration_ms on a review event, or latency_ms sealed on the settlement that
// wrote the card. Null means the payload did not record a duration.
export function recordedDurationMs(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const direct = nonnegativeInt(record.duration_ms);
  if (direct !== null) return direct;
  const replay = record.replay_inputs;
  if (!replay || typeof replay !== 'object') return null;
  const forgetting = (replay as Record<string, unknown>).forgettingInput;
  if (!forgetting || typeof forgetting !== 'object') return null;
  const fact = (forgetting as Record<string, unknown>).fact;
  if (!fact || typeof fact !== 'object') return null;
  return nonnegativeInt((fact as Record<string, unknown>).latency_ms);
}

function nonnegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function durationOf(
  eventId: string | null,
  durations: ReadonlyMap<string, number | null> | null,
): Duration {
  if (durations === null) return unknown('duration_read_failed');
  if (eventId === null) return unknown('duration_not_linked');
  if (!durations.has(eventId)) return unknown('review_event_missing');
  const ms = durations.get(eventId);
  if (ms == null) return unknown('duration_not_recorded');
  return { kind: 'known', duration_ms: ms };
}

export function cardBasis(input: CardBasisInput): {
  due_at: Due;
  last_retrieval_at: Instant;
  duration_ms: Duration;
} {
  if (input.presence === 'unread') {
    const unread = unknown(input.reason);
    return { due_at: unread, last_retrieval_at: unread, duration_ms: unread };
  }
  if (input.presence === 'absent') {
    const missing = unknown(input.reason);
    return { due_at: { kind: 'absent' }, last_retrieval_at: missing, duration_ms: missing };
  }
  const last_retrieval_at: Instant = !input.state_readable
    ? unknown('state_or_history_unavailable')
    : input.last_retrieval_at
      ? { kind: 'known', at: input.last_retrieval_at }
      : unknown('no_retrieval_recorded');
  return {
    due_at: { kind: 'known', at: input.due_at },
    last_retrieval_at,
    duration_ms: durationOf(input.event_id, input.durations),
  };
}

function recallOf(retention: LearnerJudgment['retention']): ReviewTiming['recall'] {
  if (retention.kind === 'unknown') return retention;
  const reading = retention.reading;
  if (typeof reading === 'number') {
    return {
      kind: 'point',
      value: reading,
      interval: UNCALIBRATED_RECALL_INTERVAL,
      calibration: 'uncalibrated',
      engine: 'fsrs',
    };
  }
  if (reading.kind === 'score') {
    return {
      kind: 'point',
      value: reading.value,
      interval: UNCALIBRATED_RECALL_INTERVAL,
      calibration: 'uncalibrated',
      engine: 'forgetting_candidate',
    };
  }
  return unknown(reading.reason);
}

function decayOf(
  ability: LearnerJudgment['ability'],
  asOf: Date,
): ReviewTiming['freshness']['decay_bucket'] {
  if (ability.kind === 'available') {
    return masteryDecayBucket(
      ability.reading.evidence_count,
      ability.reading.last_outcome_at,
      asOf,
    );
  }
  // A successful read with no row is the same cold start the tree already calls untrained.
  if (ability.reason === 'missing_mastery_state') return 'untrained';
  return 'unknown';
}

function abilityIsMastered(ability: LearnerJudgment['ability']): boolean {
  return (
    ability.kind === 'available' &&
    Number.isFinite(ability.reading.mastery) &&
    masteryBandIdx(ability.reading.mastery) === 3
  );
}

function shelfOf(
  ability: LearnerJudgment['ability'],
  recall: ReviewTiming['recall'],
  decay: ReviewTiming['freshness']['decay_bucket'],
  due: Due,
): ReviewTiming['freshness']['mastered_shelf'] {
  const retentionHigh = recall.kind === 'point' && recall.value >= MASTERY_BAND_THRESHOLDS.mastered;
  if (abilityIsMastered(ability) || retentionHigh) {
    return { kind: 'shelf', decay_bucket: decay, due_at: due };
  }
  if (ability.kind === 'unknown' && recall.kind === 'unknown') {
    return unknown('no_mastery_or_retention_reading');
  }
  if (recall.kind === 'unknown') return unknown(recall.reason);
  if (ability.kind === 'unknown') return unknown(ability.reason);
  return { kind: 'not_high' };
}

export function reviewTiming(input: {
  asOf: Date;
  ability: LearnerJudgment['ability'];
  retention: LearnerJudgment['retention'];
  due_at: Due;
  last_retrieval_at: Instant;
  duration_ms: Duration;
}): ReviewTiming {
  const recall = recallOf(input.retention);
  const decay_bucket = decayOf(input.ability, input.asOf);
  return {
    recall,
    basis: {
      last_retrieval_at: input.last_retrieval_at,
      duration_ms: input.duration_ms,
    },
    freshness: {
      decay_bucket,
      due_at: input.due_at,
      mastered_shelf: shelfOf(input.ability, recall, decay_bucket, input.due_at),
    },
  };
}

function instantJson(value: Instant): ReviewTimingJson['basis']['last_retrieval_at'] {
  if (value.kind === 'unknown') return value;
  return { kind: 'known', at: value.at.toISOString() };
}

function dueJson(value: Due): ReviewTimingJson['freshness']['due_at'] {
  if (value.kind !== 'known') return value;
  return { kind: 'known', at: value.at.toISOString() };
}

export function reviewTimingJson(timing: ReviewTiming): ReviewTimingJson {
  const due_at = dueJson(timing.freshness.due_at);
  const mastered_shelf = timing.freshness.mastered_shelf;
  return {
    recall: timing.recall,
    basis: {
      last_retrieval_at: instantJson(timing.basis.last_retrieval_at),
      duration_ms: timing.basis.duration_ms,
    },
    freshness: {
      decay_bucket: timing.freshness.decay_bucket,
      due_at,
      mastered_shelf:
        mastered_shelf.kind === 'shelf'
          ? {
              kind: 'shelf',
              decay_bucket: mastered_shelf.decay_bucket,
              due_at: dueJson(mastered_shelf.due_at),
            }
          : mastered_shelf,
    },
  };
}
