// Learner-context host port (YUK-1794 B1). Agency owns the unified Context read
// API in `capabilities/agency/context`; kernel cannot import a capability, so the
// implementation is installed at startup (like review-due) and callers go through
// this port instead of a cross-capability edge.
//
// `view` names come from `@/ai/task-spec` CONTEXT_VIEWS — the same vocabulary the
// audit:context-consumers check validates TaskSpec `context` declarations against.

import type { ContextViewName } from '@/ai/task-spec';
import type { Db, Tx } from '@/db/client';
import { HostOperationNotInstalledError } from '@/kernel/host-operation';

type DbLike = Db | Tx;

export interface LearnerContextInput {
  readonly view: ContextViewName;
  readonly subjectId?: string;
  readonly scope?: string;
  readonly now?: Date;
}

/** The assembled startup segment plus the metadata needed to verify its budget. */
export interface LearnerContextResult {
  readonly view: ContextViewName;
  /** Rendered startup-segment markdown, trimmed to the view's token budget. */
  readonly markdown: string;
  /** Estimated prompt tokens of `markdown` (deterministic estimator, not a tokenizer). */
  readonly estimatedTokens: number;
  /** High-water mark of the steady section (ISO); the delta section covers events after it. */
  readonly asOf: string | null;
}

export type LearnerContextLoader = (
  db: DbLike,
  input: LearnerContextInput,
) => Promise<LearnerContextResult>;

let installed: LearnerContextLoader | undefined;

export function installLearnerContextLoader(loader: LearnerContextLoader): void {
  installed = loader;
}

/**
 * The one Context read API for non-agency consumers. A missing install is a host
 * wiring defect, not a read failure — callers that degrade on errors must rethrow
 * HostOperationNotInstalledError rather than hide it.
 */
export async function loadLearnerContext(
  db: DbLike,
  input: LearnerContextInput,
): Promise<LearnerContextResult> {
  if (!installed) {
    throw new HostOperationNotInstalledError(
      'learner-context loader is not installed; call installAgencyHostOperations at startup',
    );
  }
  return installed(db, input);
}
