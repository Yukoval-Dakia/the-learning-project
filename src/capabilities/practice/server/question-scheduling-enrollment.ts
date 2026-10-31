import type { Tx } from '@/db/client';
import { withoutNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import {
  type UpsertFsrsStateInput,
  enrollFsrsStateIfAbsent,
  initialSchedulingState,
} from '@/kernel/records/material-fsrs-state-write';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { SYNTHETIC_SUBJECT_ROOT_RE } from './placement-scope';

interface SchedulingEnrollmentEvidence {
  evidenceEventId: string;
  now: Date;
}

async function contentKnowledgeIds(tx: Tx, knowledgeIds: readonly string[]): Promise<string[]> {
  // Seed roots (id pattern) and YUK-1600 goal/container roles are both non-content:
  // neither may enroll a knowledge-level FSRS card.
  return withoutNonKcKnowledgeIds(
    tx,
    knowledgeIds.filter((id) => !SYNTHETIC_SUBJECT_ROOT_RE.test(id)),
  );
}

function initialEnrollment(
  subjectKind: FsrsSubjectKind,
  subjectId: string,
  evidence: SchedulingEnrollmentEvidence,
): UpsertFsrsStateInput {
  return {
    subject_kind: subjectKind,
    subject_id: subjectId,
    ...initialSchedulingState(subjectId, evidence.now),
    last_review_event_id: evidence.evidenceEventId,
  };
}

/**
 * Enroll a question that the caller has already promoted in this transaction.
 * The caller must hold the global learning-state write lock before its original
 * scope/row locks; this operation neither opens a transaction nor publishes events.
 */
export async function enrollPromotedQuestionScheduling(
  tx: Tx,
  input: SchedulingEnrollmentEvidence & {
    questionId: string;
    knowledgeIds: readonly string[];
  },
): Promise<void> {
  const rawKnowledgeIds = [...new Set(input.knowledgeIds)];
  // Branch on raw labels: roots-only is labeled and enrolls zero cards. Only
  // genuinely unlabeled questions receive a question-level fallback card.
  const subjectKind = rawKnowledgeIds.length > 0 ? 'knowledge' : 'question';
  const subjectIds =
    rawKnowledgeIds.length > 0
      ? await contentKnowledgeIds(tx, rawKnowledgeIds)
      : [input.questionId];
  for (const subjectId of subjectIds) {
    // Keep the existing read/parse contract: invalid stored state throws, while
    // a valid existing schedule is left untouched without initializing a card.
    const existing = await getFsrsState(tx, subjectKind, subjectId);
    if (existing) continue;
    await upsertFsrsState(tx, initialEnrollment(subjectKind, subjectId, input));
  }
}

/**
 * Enroll newly added knowledge attribution in the caller's existing transaction,
 * after its global learning-state write lock and original row locks. The caller
 * retains the draft guard and writes the attribution event using the returned IDs.
 */
export async function enrollAddedKnowledgeScheduling(
  tx: Tx,
  input: SchedulingEnrollmentEvidence & { knowledgeIds: readonly string[] },
): Promise<string[]> {
  const enrolledKnowledgeIds: string[] = [];
  // Preserve input order and CAS insertion: do not read/parse existing cards or
  // turn a concurrent review's schedule into an enrollment upsert.
  for (const knowledgeId of await contentKnowledgeIds(tx, input.knowledgeIds)) {
    const enrolled = await enrollFsrsStateIfAbsent(
      tx,
      initialEnrollment('knowledge', knowledgeId, input),
    );
    if (enrolled) enrolledKnowledgeIds.push(knowledgeId);
  }
  return enrolledKnowledgeIds;
}
