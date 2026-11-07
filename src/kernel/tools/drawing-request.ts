// compose_block 'drawing' delegation port — kernel owns the contract, the
// drawing capability installs the implementation at host startup (same slot
// pattern as kernel/judge). Keeping the value import on a kernel port is what
// lets compose-block stay inside the capability-boundary ratchet.

import type { Db } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';
import type { TurnSourceLedger } from './source-ledger';

export interface DrawingBlockIssue {
  code: string;
  path: string;
  detail: string;
}

export type DrawingRequestOutcome =
  | { status: 'ready'; drawing_id: string }
  | { status: 'unavailable'; issues: DrawingBlockIssue[] };

export interface DrawingRequestInput {
  db: Db;
  /** Owning conversation session — every drawing row is learner-scoped by it. */
  sessionId: string | undefined;
  taskRunId: string;
  causedByEventId?: string;
  actorRef: string;
  /** Server-bound source ledger; the drawing refuses unless its snapshot completes. */
  ledger?: TurnSourceLedger;
  /**
   * Server-bound: the turn is a restricted answer-reveal surface
   * (post-judgment answers legitimately visible), so bound question sources
   * are not re-gated on judged attempts.
   */
  answerOnly?: boolean;
}

export type DrawingRequestPort = (
  input: DrawingRequestInput,
  block: { brief: string; alt: string; caption?: string },
) => Promise<DrawingRequestOutcome>;

const SLOT = 'drawing.request';

export function installDrawingRequestPort(operation: DrawingRequestPort): void {
  installHostOperation(SLOT, operation);
}

export function drawingRequestPort(): DrawingRequestPort {
  const operation = installedHostOperation<DrawingRequestPort>(SLOT);
  if (!operation) {
    throw new HostOperationNotInstalledError(
      'drawing.request port is not installed — installDrawingHostOperations() must run at host startup',
    );
  }
  return operation;
}
