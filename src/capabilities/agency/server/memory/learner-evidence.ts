// Shared evidence reads retain real attempts, including those on agent lanes.
// Question-bank authoring is audit history; Mem0 inference has a separate,
// narrower gate so it cannot restrict Curator, brief or profile evidence.

import { eq, inArray, sql } from 'drizzle-orm';
import { allowsDerivation } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
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

/** Agent output must never feed itself back into learner memory. */
export function shouldExtractToMemory(input: { actor_kind: string }): boolean {
  return input.actor_kind === 'user';
}

export type MemoryIngestAdmission =
  | { kind: 'inferred' }
  | { kind: 'verbatim'; claim: string; conjectureId: string }
  | { kind: 'excluded' };

export type MemorySourceSessionState =
  | { readonly present: false; readonly deletionRequested: false; readonly deleted: false }
  | {
      readonly present: true;
      readonly deletionRequested: boolean;
      readonly deleted: boolean;
    };

/** Ingest and operator recovery share one decision, separate from general evidence. */
export function memoryIngestAdmission(input: {
  actor_kind: string;
  action: string;
  subject_kind: string;
  payload: unknown;
  session_id: string | null | undefined;
  session_state: MemorySourceSessionState;
}): MemoryIngestAdmission {
  const sourceAllowsSessionState =
    input.session_id !== undefined &&
    (input.session_id === null
      ? !input.session_state.present
      : input.session_state.present &&
        !input.session_state.deletionRequested &&
        !input.session_state.deleted);
  if (
    !shouldExtractToMemory(input) ||
    isLearnerAnswerAction(input.action) ||
    !allowsDerivation(input.payload) ||
    !sourceAllowsSessionState
  ) {
    return { kind: 'excluded' };
  }
  const payload = input.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    return { kind: 'excluded' };
  if (input.action === COPILOT_USER_ASK_ACTION) {
    if (input.session_id === null) return { kind: 'excluded' };
    return 'user_message' in payload &&
      typeof payload.user_message === 'string' &&
      payload.user_message.trim().length > 0
      ? { kind: 'inferred' }
      : { kind: 'excluded' };
  }
  if (
    input.action === 'rate' &&
    input.subject_kind === 'event' &&
    'rating' in payload &&
    payload.rating === 'accept' &&
    'corrected_by_owner' in payload &&
    payload.corrected_by_owner === true &&
    'corrected_claim_md' in payload &&
    typeof payload.corrected_claim_md === 'string' &&
    'conjecture_id' in payload &&
    typeof payload.conjecture_id === 'string'
  ) {
    const claim = payload.corrected_claim_md.trim();
    const conjectureId = payload.conjecture_id.trim();
    if (claim && conjectureId) return { kind: 'verbatim', claim, conjectureId };
  }
  return { kind: 'excluded' };
}

/** Owner-level source read: one event, live purpose, and live session deletion state. */
export async function readMemorySourceAdmission(
  db: Db | Tx,
  sourceId: string,
): Promise<MemoryIngestAdmission> {
  if ((await readEventDerivationPolicy(db, sourceId)) !== 'allow') return { kind: 'excluded' };
  const rows = await db
    .select({
      actor_kind: event.actor_kind,
      action: event.action,
      subject_kind: event.subject_kind,
      payload: event.payload,
      session_id: event.session_id,
    })
    .from(event)
    .where(eq(event.id, sourceId))
    .limit(1);
  const row = rows[0];
  if (!row) return { kind: 'excluded' };
  const sessionRows = row.session_id
    ? await db
        .select({
          deletionRequestedAt: learning_session.deletion_requested_at,
          deletedAt: learning_session.deleted_at,
        })
        .from(learning_session)
        .where(eq(learning_session.id, row.session_id))
        .limit(1)
    : [];
  const sessionState: MemorySourceSessionState = row.session_id
    ? sessionRows[0]
      ? {
          present: true,
          deletionRequested: sessionRows[0].deletionRequestedAt !== null,
          deleted: sessionRows[0].deletedAt !== null,
        }
      : { present: false, deletionRequested: false, deleted: false }
    : { present: false, deletionRequested: false, deleted: false };
  return memoryIngestAdmission({ ...row, session_state: sessionState });
}

/**
 * The same classification as a WHERE fragment for event scans. Shares the private
 * action list with the row predicate so the two consumers cannot drift.
 */
export function learnerEvidenceSql() {
  return sql`NOT (${inArray(event.action, [...QUESTION_BANK_AUTHORING_ACTIONS])})`;
}
