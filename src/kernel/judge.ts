// Judge host port. Cross-domain callers (agency probe answers, ingestion capture)
// invoke the five wrappers below; Practice's composition installs the real grading
// implementations into the process-wide slot. Same fail-fast contract as the other
// host ports: an uninstalled call throws HostOperationNotInstalledError, never a
// silent fallback. The kernel owns only the port and its DTOs — evaluation,
// submission and activation contracts live in @/core/schema/assessment.
import type {
  ActivateEvaluationIntentT,
  ActivateEvaluationResult,
  AssessmentAttemptCaptureT,
  ContractAttemptOutcome,
  GradingEntryPoint,
  PendingStateT,
  SaveSubmissionRequest,
  SaveSubmissionResult,
  SubmissionRecordT,
} from '@/core/schema/assessment';
import type { JudgeWorkflowInputT } from '@/core/schema/event/judge-operational-events';
import type { Db, Tx } from '@/db/client';
import type { assessment_issuance, question_revision } from '@/db/schema';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from './host-operation';

/** What a formal-attempt preview returns: frozen submission plus its unactivated candidate. */
export interface FormalAttemptPreview {
  issuance: typeof assessment_issuance.$inferSelect;
  revision: typeof question_revision.$inferSelect;
  candidate: ContractAttemptOutcome;
  submission: SubmissionRecordT;
  /** This commit replayed an already-accepted submission; its request-side claim fields are not new evidence. */
  replayed: boolean;
  /** Assistance receipt sealed into the submission event; null for historical receipts without a snapshot. */
  assistance: {
    status: 'independent' | 'assisted' | 'unknown';
    event_ids: string[];
    max_dose: number | null;
    kinds: Array<'hint' | 'solution' | 'chat_context'>;
    phase: 'before_submit' | 'after_submit' | null;
  } | null;
  automatic_commit: boolean;
  activation_intent: {
    evaluation_id: string;
    expected_effective_id: string | null;
    expected_generation: number;
  };
}

export interface JudgePreviewOptions {
  selfReport?: boolean;
  candidateId?: string;
  expectedSubmissionIds?: string[];
  modelAdmission?: 'durable';
  judgeExecution?: JudgeWorkflowInputT;
  /** A superseded accepted original must finish without another paid judgment. */
  hold?: PendingStateT;
}

export interface JudgeCommitOptions {
  activationIntent?: ActivateEvaluationIntentT;
  expectedHead?: Pick<ActivateEvaluationIntentT, 'expected_effective_id' | 'expected_generation'>;
  selfReport?: boolean;
  modelAdmission?: 'durable';
  judgeExecution?: JudgeWorkflowInputT;
  userRating?: 'again' | 'hard' | 'good' | 'easy';
  capture?: AssessmentAttemptCaptureT;
  signal?: AbortSignal;
  requireUnassistedModelEvidence?: boolean;
  beforeActivate?: (tx: Tx) => Promise<void>;
  onActivated?: (tx: Tx, prepared: FormalAttemptPreview, attemptId: string) => Promise<void>;
}

export type FormalAttemptCommitResult =
  | ({ status: 'review_required'; attempt_id: string } & FormalAttemptPreview)
  | ({
      status: 'effective';
      attempt_id: string;
      activation: ActivateEvaluationResult;
    } & FormalAttemptPreview);

export interface WithdrawCapturedOccurrenceInput {
  originalAttemptEventId: string;
  correctionEventId: string;
  blockId: string;
  sessionId: string;
  now: Date;
}

export interface JudgeOperations {
  previewFormalAttempt: (
    database: Db,
    entry: GradingEntryPoint,
    questionId: string,
    request: SaveSubmissionRequest,
    signal?: AbortSignal,
    options?: JudgePreviewOptions,
  ) => Promise<FormalAttemptPreview>;
  commitFormalAttempt: (
    database: Db,
    entry: GradingEntryPoint,
    questionId: string,
    request: SaveSubmissionRequest,
    options?: JudgeCommitOptions,
  ) => Promise<FormalAttemptCommitResult>;
  recordFormalAttemptCapture: (
    tx: Tx,
    entry: GradingEntryPoint,
    questionId: string,
    submission: SubmissionRecordT,
    candidateId: string | null,
    capture?: AssessmentAttemptCaptureT,
  ) => Promise<void>;
  saveSubmission: (db: Db | Tx, request: SaveSubmissionRequest) => Promise<SaveSubmissionResult>;
  withdrawCapturedOccurrence: (tx: Tx, input: WithdrawCapturedOccurrenceInput) => Promise<void>;
}

const OPERATIONS_SLOT = 'kernel/judge:operations';

/** Practice composition installs the grading implementations before serving. */
export function installJudgeOperations(operations: JudgeOperations): void {
  installHostOperation(OPERATIONS_SLOT, operations);
}

function operations(): JudgeOperations {
  const installed = installedHostOperation<JudgeOperations>(OPERATIONS_SLOT);
  if (!installed) {
    throw new HostOperationNotInstalledError(
      'judge operations are not installed; call installPracticeHost at startup',
    );
  }
  return installed;
}

/** Formal entry input already carries the issuance served to the learner. */
export async function previewFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  signal?: AbortSignal,
  options: JudgePreviewOptions = {},
): Promise<FormalAttemptPreview> {
  return operations().previewFormalAttempt(database, entry, questionId, request, signal, options);
}

/** The response and candidate are immutable; activation is the only learning writer. */
export async function commitFormalAttempt(
  database: Db,
  entry: GradingEntryPoint,
  questionId: string,
  request: SaveSubmissionRequest,
  options: JudgeCommitOptions = {},
): Promise<FormalAttemptCommitResult> {
  return operations().commitFormalAttempt(database, entry, questionId, request, options);
}

/** One immutable participation anchor, including while a durable run is queued. */
export async function recordFormalAttemptCapture(
  tx: Tx,
  entry: GradingEntryPoint,
  questionId: string,
  submission: SubmissionRecordT,
  candidateId: string | null,
  capture: AssessmentAttemptCaptureT = {},
): Promise<void> {
  return operations().recordFormalAttemptCapture(
    tx,
    entry,
    questionId,
    submission,
    candidateId,
    capture,
  );
}

export async function saveSubmission(
  db: Db | Tx,
  request: SaveSubmissionRequest,
): Promise<SaveSubmissionResult> {
  return operations().saveSubmission(db, request);
}

/** Withdraw an ingestion occurrence atomically; immutable originals remain readable. */
export async function withdrawCapturedOccurrence(
  tx: Tx,
  input: WithdrawCapturedOccurrenceInput,
): Promise<void> {
  return operations().withdrawCapturedOccurrence(tx, input);
}
