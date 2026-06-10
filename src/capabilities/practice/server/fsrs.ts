import type { FsrsRating, FsrsState } from '@/core/schema/business';
import { type Card, type Grade, Rating, State, createEmptyCard, fsrs } from 'ts-fsrs';
import type { z } from 'zod';

type FsrsStateData = z.infer<typeof FsrsState>;
type RatingLabel = z.infer<typeof FsrsRating>;

const RATING_MAP: Record<RatingLabel, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
};

const STATE_TO_STRING: Record<State, FsrsStateData['state']> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const STATE_FROM_STRING: Record<FsrsStateData['state'], State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const scheduler = fsrs();

export interface ScheduleResult {
  nextState: FsrsStateData;
  dueAt: Date;
}

export function scheduleReview(
  prevState: FsrsStateData | null,
  rating: RatingLabel,
  now: Date,
): ScheduleResult {
  const card: Card = prevState ? cardFromState(prevState) : createEmptyCard(now);
  const result = scheduler.next(card, now, RATING_MAP[rating]);
  return {
    nextState: stateFromCard(result.card),
    dueAt: result.card.due,
  };
}

// Search-grounded QuizGen (T-SQ) §3 / Q6 — enroll-on-active. When a quiz_gen
// draft is promoted to active, it has NO failure attempts and NO prior reviews,
// so it lands in NEITHER review-pool slice (overdue material_fsrs_state, nor the
// never-reviewed-failure-attempt stream). To put it in the pool we materialize a
// fresh FSRS "new" card via ts-fsrs `createEmptyCard` (the SAME primitive
// scheduleReview uses for a first review — we do NOT hand-roll FSRS) and persist
// it via the single-owner upsertFsrsState. due_at = the empty card's due (== now
// for a New card), so the promoted question is immediately due for its first
// pass. The next /api/review/submit then drives normal scheduling from this row.
export interface InitialFsrsState {
  state: FsrsStateData;
  dueAt: Date;
}

export function initialFsrsState(now: Date): InitialFsrsState {
  const card = createEmptyCard(now);
  return {
    state: stateFromCard(card),
    dueAt: card.due,
  };
}

function cardFromState(s: FsrsStateData): Card {
  return {
    due: s.due,
    stability: s.stability,
    difficulty: s.difficulty,
    // elapsed_days deprecated in ts-fsrs v6; default to 0 if absent.
    elapsed_days: s.elapsed_days ?? 0,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: STATE_FROM_STRING[s.state],
    last_review: s.last_review ?? undefined,
  };
}

function stateFromCard(c: Card): FsrsStateData {
  return {
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: STATE_TO_STRING[c.state],
    last_review: c.last_review ?? null,
  };
}
