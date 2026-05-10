import { type Card, type Grade, Rating, State, createEmptyCard, fsrs } from 'ts-fsrs';
import type { z } from 'zod';
import type { FsrsRating, FsrsState } from '../../../src/core/schema/business';

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
