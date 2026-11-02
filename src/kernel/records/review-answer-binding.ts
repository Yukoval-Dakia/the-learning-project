// Practice owns the immutable-original binding: capture reserves the attached
// original inside the chat acceptance transaction; consume submits it through the
// native review-answer operation. Callers hold no Practice import. Practice binds
// both operations at API and worker startup.

import type { Db, Tx } from '@/db/client';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import type { BoundReviewAnswer, ReviewAnswerAttachment } from '@/kernel/tools/review-answer';
import type { ToolContext } from '@/kernel/tools/types';

type ReviewAnswerReceipt = Awaited<ReturnType<NonNullable<ToolContext['reviewAnswer']>['submit']>>;

export interface ReviewAnswerBindingOperations {
  capture: (
    tx: Tx,
    input: { sessionId: string; originalRef: string; original: ReviewAnswerAttachment },
  ) => Promise<BoundReviewAnswer>;
  consume: (
    db: Db,
    binding: BoundReviewAnswer,
    context: { authorize: (tx: Tx) => Promise<void>; signal?: AbortSignal },
  ) => Promise<ReviewAnswerReceipt>;
}

let installed: ReviewAnswerBindingOperations | undefined;

export function installReviewAnswerBindingOperations(
  operations: ReviewAnswerBindingOperations,
): void {
  installed = operations;
}

function operations(): ReviewAnswerBindingOperations {
  if (!installed) {
    throw new HostOperationNotInstalledError(
      'review-answer binding operations are not installed; call installPracticeHostOperations at startup',
    );
  }
  return installed;
}

/** Caller's transaction; takes Practice's review-answer and evaluation-group locks in that order. */
export async function captureReviewAnswerBinding(
  tx: Tx,
  input: Parameters<ReviewAnswerBindingOperations['capture']>[1],
): Promise<BoundReviewAnswer> {
  return operations().capture(tx, input);
}

/** Authorizes inside its own transaction; no lock spans the judge/provider call. */
export async function consumeReviewAnswerBinding(
  db: Db,
  binding: BoundReviewAnswer,
  context: Parameters<ReviewAnswerBindingOperations['consume']>[2],
): Promise<ReviewAnswerReceipt> {
  return operations().consume(db, binding, context);
}
