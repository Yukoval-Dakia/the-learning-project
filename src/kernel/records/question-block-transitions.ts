import { eq, sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { question_block } from '@/db/schema';
import { writeQuestionBlockLifecycleEvent } from './question-block-lifecycle-event';
import { projectQuestionBlockGuarded } from './question-block-projection';

type QuestionBlockTransition =
  | {
      kind: 'auto_enroll' | 'complete_import';
      blockId: string;
      questionId: string;
      attemptEventId: string | null;
    }
  | { kind: 'ignore_source' | 'restore_after_revert'; blockId: string }
  | {
      kind: 'complete_submit';
      draft: { id: string; version: number };
      questionId: string;
      actor: { kind: 'agent' | 'user' | 'system'; ref: string };
    };

type TransitionValues = {
  touched: {
    status: 'auto_enrolled' | 'imported' | 'ignored' | 'draft' | 'submitted';
    imported_question_id?: string | null;
    imported_attempt_event_id?: string | null;
  };
  actor: { kind: 'agent' | 'user' | 'system'; ref: string };
};

function transitionValues(transition: QuestionBlockTransition): TransitionValues {
  switch (transition.kind) {
    case 'auto_enroll':
      return {
        touched: {
          // Distinct from human 'imported' so auto-enrollment stays revertible.
          status: 'auto_enrolled',
          imported_question_id: transition.questionId,
          imported_attempt_event_id: transition.attemptEventId,
        },
        actor: { kind: 'agent', ref: 'workflow_judge' },
      };
    case 'complete_import':
      // Fold-visible additive double-write carrying status, imports, and version.
      return {
        touched: {
          status: 'imported',
          imported_question_id: transition.questionId,
          imported_attempt_event_id: transition.attemptEventId,
        },
        actor: { kind: 'user', ref: 'block_import' },
      };
    case 'ignore_source':
      // Fold-visible ignore. Only status and version are carried, so the fold leaves
      // imported_* unchanged.
      return {
        touched: { status: 'ignored' },
        actor: { kind: 'user', ref: 'block_import' },
      };
    case 'restore_after_revert':
      // Fold-visible reset: explicit nulls clear both import links, and the bumped
      // version lets foldQuestionBlock reproduce the row.
      return {
        touched: {
          status: 'draft',
          imported_question_id: null,
          imported_attempt_event_id: null,
        },
        actor: { kind: 'user', ref: 'self' },
      };
    case 'complete_submit':
      return {
        touched: { status: 'submitted', imported_question_id: transition.questionId },
        actor: transition.actor,
      };
  }
}

/**
 * Persist a transition already accepted by the caller's business guards. The caller
 * supplies its transaction, locks and clock; this operation owns the row/history pair.
 */
export async function applyQuestionBlockTransition(
  tx: Tx,
  transition: QuestionBlockTransition,
  now: Date,
): Promise<void> {
  const { touched, actor } = transitionValues(transition);
  let blockId: string;
  let nextVersion: number;
  if (transition.kind === 'complete_submit') {
    blockId = transition.draft.id;
    nextVersion = transition.draft.version + 1;
  } else {
    blockId = transition.blockId;
    const [{ version }] = await tx
      .update(question_block)
      .set({
        ...touched,
        updated_at: now,
        version: sql`${question_block.version} + 1`,
      })
      .where(eq(question_block.id, blockId))
      .returning({ version: question_block.version });
    nextVersion = version;
  }

  // Fold-visible additive double-write in the same tx; carries everything
  // foldQuestionBlock needs to reproduce the row.
  await writeQuestionBlockLifecycleEvent(tx, {
    blockId,
    op: 'set_status',
    status: touched.status,
    importedQuestionId: touched.imported_question_id,
    importedAttemptEventId: touched.imported_attempt_event_id,
    nextVersion,
    actorKind: actor.kind,
    actorRef: actor.ref,
    now,
  });
  if (transition.kind === 'complete_submit') {
    await projectQuestionBlockGuarded(tx, blockId);
  }
}
