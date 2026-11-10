// Correct answers on the same knowledge point, quoted beside a failure cell.
// A missing or unquotable prompt is dropped. It does not reject the cell: the
// failure packet's own completeness gate is unchanged.

import type { Db } from '@/db/client';
import { loadRecentCorrectAttemptsForKnowledge } from '@/kernel/read-models/learner-activity';
import { CONJECTURE_CONTRAST_CORRECT_LIMIT } from '../../tasks/conjecture-induction';
import type { ConjectureFailureAttempt } from './evidence';
import { quoteConjectureAttemptSamples } from './evidence-enrichment';
import { wrapTruncatedLearnerText } from './untrusted-text';

/** Extra corrects fetched so a dropped prompt does not leave the cell with nothing. */
const CONTRAST_FETCH_MULTIPLIER = 3;

export interface ContrastCorrectSample {
  attempt_event_id: string;
  question_id: string;
  question_prompt_md: string;
  question_reference_md: string | null;
  answer_md: string | null;
}

function asFailureAttempt(attempt: {
  attempt_event_id: string;
  question_id: string;
  knowledge_ids: readonly string[];
  created_at: Date;
  answer_md: string | null;
  answer_image_refs: string[];
  question_snapshot: ConjectureFailureAttempt['question_snapshot'];
}): ConjectureFailureAttempt {
  return {
    attempt_event_id: attempt.attempt_event_id,
    question_id: attempt.question_id,
    answer_md: attempt.answer_md,
    answer_image_refs: attempt.answer_image_refs,
    referenced_knowledge_ids: [...attempt.knowledge_ids],
    question_snapshot: attempt.question_snapshot,
    created_at: attempt.created_at,
  };
}

export async function loadContrastCorrectSamples(
  db: Db,
  input: { knowledgeIds: readonly string[]; since: Date },
): Promise<Map<string, ContrastCorrectSample[]>> {
  const knowledgeIds = [...new Set(input.knowledgeIds)];
  const out = new Map<string, ContrastCorrectSample[]>(knowledgeIds.map((id) => [id, []]));
  if (knowledgeIds.length === 0) return out;

  const fetchCap = CONJECTURE_CONTRAST_CORRECT_LIMIT * CONTRAST_FETCH_MULTIPLIER;
  const byKnowledge = await loadRecentCorrectAttemptsForKnowledge(db, {
    knowledgeIds,
    since: input.since,
    limitPerKnowledge: fetchCap,
  });
  const legacy = [...byKnowledge.values()]
    .flat()
    .filter((attempt) => attempt.frozen_prompt_md === null);
  const quotedLegacy = await quoteConjectureAttemptSamples(db, legacy.map(asFailureAttempt));
  const byAttemptId = new Map<string, ContrastCorrectSample>();
  for (const [attemptId, sample] of quotedLegacy) {
    if (sample.question_prompt_md === null) continue;
    byAttemptId.set(attemptId, {
      attempt_event_id: sample.attempt_event_id,
      question_id: sample.question_id,
      question_prompt_md: sample.question_prompt_md,
      question_reference_md: sample.question_reference_md,
      answer_md: sample.answer_md,
    });
  }
  for (const attempts of byKnowledge.values()) {
    for (const attempt of attempts) {
      if (attempt.frozen_prompt_md === null || byAttemptId.has(attempt.attempt_event_id)) continue;
      byAttemptId.set(attempt.attempt_event_id, {
        attempt_event_id: attempt.attempt_event_id,
        question_id: attempt.question_id,
        question_prompt_md: wrapTruncatedLearnerText(attempt.frozen_prompt_md),
        question_reference_md: null,
        answer_md: wrapTruncatedLearnerText(attempt.answer_md),
      });
    }
  }

  for (const [knowledgeId, attempts] of byKnowledge) {
    const samples: ContrastCorrectSample[] = [];
    for (const attempt of attempts) {
      const sample = byAttemptId.get(attempt.attempt_event_id);
      if (!sample) continue;
      samples.push(sample);
      if (samples.length >= fetchCap) break;
    }
    out.set(knowledgeId, samples);
  }
  return out;
}

export function contrastSamplesForCell(
  cell: { knowledge_id: string; evidence_event_ids: readonly string[] },
  byKnowledge: ReadonlyMap<string, readonly ContrastCorrectSample[]>,
): ContrastCorrectSample[] {
  const failureIds = new Set(cell.evidence_event_ids);
  const samples: ContrastCorrectSample[] = [];
  for (const sample of byKnowledge.get(cell.knowledge_id) ?? []) {
    if (failureIds.has(sample.attempt_event_id)) continue;
    samples.push(sample);
    if (samples.length >= CONJECTURE_CONTRAST_CORRECT_LIMIT) break;
  }
  return samples;
}
