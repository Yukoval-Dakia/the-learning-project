// Shared evidence reads retain real attempts, including those on agent lanes.
// Question-bank authoring is audit history; Mem0 inference has a separate,
// narrower gate so it cannot restrict Curator, brief or profile evidence.

import { inArray, sql } from 'drizzle-orm';
import { allowsDerivation } from '@/core/schema/derivation-policy';
import { event } from '@/db/schema';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';

/**
 * Actions emitted by the question-bank authoring/publish pipeline. Each audits a
 * bank-content mutation or its admission gate, not a learner interaction. Some
 * writers already stamp `ingest_at`; listing them here still protects the
 * evidence-read side regardless of write-time stamps.
 */
const QUESTION_BANK_AUTHORING_ACTIONS = [
  // Revision / draft audit
  'experimental:question_edit',
  'experimental:question_structure_edit',
  'experimental:question_archive',
  'experimental:question_restore',
  'experimental:edit_question_block_structured',
  'experimental:question_draft_save',
  'experimental:question_draft_probe',
  'experimental:question_draft_submit',
  // Admission QA + canonical publish
  'experimental:submit_question',
  'experimental:quiz_verify',
  'experimental:source_verify',
  'experimental:variant_verify',
  'experimental:assessment_publish',
  // Block creation / enrollment lifecycle
  'experimental:question_block_create',
  'experimental:question_block_lifecycle',
  'experimental:auto_enroll_observed',
] as const;

const NON_LEARNER_ACTIONS: ReadonlySet<string> = new Set(QUESTION_BANK_AUTHORING_ACTIONS);

/** Does this event count as input to the learner's memory? */
export function isLearnerEvidenceAction(action: string): boolean {
  return !NON_LEARNER_ACTIONS.has(action);
}

// Verbatim-answer events outside the kernel LEARNER_ANSWER_ACTIONS constant
// (the constant has other consumers; only the memory gate widens here).
const MEMORY_ONLY_ANSWER_ACTIONS = [
  // submit confirmations persist response_set/group_evidence verbatim.
  'experimental:confirmation_command',
  // probe answers persist answer_md verbatim.
  'experimental:probe_result',
] as const;

const LEARNER_ANSWER_SET: ReadonlySet<string> = new Set([
  ...LEARNER_ANSWER_ACTIONS,
  ...MEMORY_ONLY_ANSWER_ACTIONS,
]);

/**
 * Does this event carry the learner's verbatim answer text? Answer events stay
 * in the ledger and keep feeding every read face — the shared evidence SQL
 * above included — but infer:true extraction would rewrite the text into
 * durable "learner facts", so the memory owner alone bars them here. Kept
 * separate from NON_LEARNER_ACTIONS, which also feeds the evidence read side.
 */
export function isLearnerAnswerAction(action: string): boolean {
  return LEARNER_ANSWER_SET.has(action);
}

/** Narrow inference admission without changing Curator, brief or profile evidence. */
export function isMemoryExtractionEvent(input: {
  actor_kind: string;
  action: string;
  payload: unknown;
}): boolean {
  if (
    input.actor_kind !== 'user' ||
    isLearnerAnswerAction(input.action) ||
    input.action !== 'experimental:copilot_user_ask' ||
    !allowsDerivation(input.payload)
  ) {
    return false;
  }
  const payload = input.payload;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'user_message' in payload &&
    typeof payload.user_message === 'string' &&
    payload.user_message.trim().length > 0
  );
}

/**
 * The same classification as a WHERE fragment for event scans. Shares the private
 * action list with the row predicate so the two consumers cannot drift.
 */
export function learnerEvidenceSql() {
  return sql`NOT (${inArray(event.action, [...QUESTION_BANK_AUTHORING_ACTIONS])})`;
}
