// Practice owns the assessment behind a conversation confirmation: question
// selection and issuance, the immutable original and its native submission, and the
// read of authoritative rows and receipts for recovery. Copilot owns the occurrence and
// learner choices and calls these three operations. Practice binds them at API and
// worker startup.

import type { GroupEvidenceT, ResponseSetT } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

export type ConfirmationIssueResult =
  | { status: 'issued'; issuance_id: string }
  | { status: 'blocked'; reason: string };

export interface ConfirmationSubmitInput {
  occurrenceId: string;
  sessionId: string;
  commandId: string;
  responseSet: ResponseSetT;
  groupEvidence: GroupEvidenceT[];
  authorize: (tx: Tx) => Promise<void>;
  signal: AbortSignal;
}

/** Projection only; `submission` is null until the original is accepted. */
export interface ConfirmationAssessment {
  result: 'issued' | 'pending' | 'effective' | 'failed_pending' | 'review_required';
  submission: object | null;
}

export interface ConversationConfirmationAssessmentOperations {
  issue: (
    tx: Tx,
    input: { occurrenceId: string; sessionId: string; learningItemId: string },
  ) => Promise<ConfirmationIssueResult>;
  submit: (db: Db, input: ConfirmationSubmitInput) => Promise<ConfirmationAssessment | null>;
  read: (db: Db | Tx, occurrenceId: string) => Promise<ConfirmationAssessment | null>;
}

const OPERATIONS_SLOT = 'kernel/records/conversation-confirmation-assessment:operations';

export function installConversationConfirmationAssessment(
  operations: ConversationConfirmationAssessmentOperations,
): void {
  installHostOperation(OPERATIONS_SLOT, operations);
}

function operations(): ConversationConfirmationAssessmentOperations {
  const installed =
    installedHostOperation<ConversationConfirmationAssessmentOperations>(OPERATIONS_SLOT);
  if (!installed) {
    throw new HostOperationNotInstalledError(
      'conversation confirmation assessment is not installed; call installPracticeHost at startup',
    );
  }
  return installed;
}

/** Caller holds its session lock; issuance, binding and conservative help are one commit. */
export async function issueConversationConfirmation(
  tx: Tx,
  input: Parameters<ConversationConfirmationAssessmentOperations['issue']>[1],
): Promise<ConfirmationIssueResult> {
  return operations().issue(tx, input);
}

/** Reserves the original once, then submits through the native transport outside the caller's transaction. */
export async function submitConversationConfirmation(
  db: Db,
  input: ConfirmationSubmitInput,
): Promise<ConfirmationAssessment | null> {
  return operations().submit(db, input);
}

/** Reads authoritative rows and receipts only; never issues, submits or judges. */
export async function readConversationConfirmation(
  db: Db | Tx,
  occurrenceId: string,
): Promise<ConfirmationAssessment | null> {
  return operations().read(db, occurrenceId);
}
