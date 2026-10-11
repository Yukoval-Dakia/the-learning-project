// Response shapes for the tap-answer blocks (ADR-0074 D3a). These are the exact shapes the
// learner's answer is submitted in; grading happens server-side against stable ids and gap
// positions, never against text or on-screen order. Nothing here knows the key.

/** One pair: a left item id linked to a right item id. */
export interface MatchingPair {
  left_id: string;
  right_id: string;
}

/** 左右配对的作答。 */
export interface MatchingResponse {
  kind: 'matching';
  pairs: MatchingPair[];
}

/**
 * 断句的作答。A position is a gap index into the frozen text, counted in Unicode code points
 * (`Array.from(text)`): gap `i` sits between character `i - 1` and character `i`.
 */
export interface SentenceBreaksResponse {
  kind: 'sentence_breaks';
  positions: number[];
}

/**
 * How many left items may point at one right item, declared per question. Each left item always
 * links to at most one right item. Distractors (right items nobody links to) are allowed under
 * both; `MatchingBlock` only mentions them when the question says so.
 */
export type MatchingCardinality = 'one_to_one' | 'many_to_one';

/** A matching item as printed: a stable id, its text, and an optional printed label (甲, A, ①). */
export interface MatchingItem {
  id: string;
  text: string;
  label?: string;
}

export const EMPTY_MATCHING: MatchingResponse = { kind: 'matching', pairs: [] };
export const EMPTY_SENTENCE_BREAKS: SentenceBreaksResponse = {
  kind: 'sentence_breaks',
  positions: [],
};
