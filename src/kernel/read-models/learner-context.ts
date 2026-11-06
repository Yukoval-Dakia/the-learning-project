// Learner-context host port (YUK-1794 B1). Agency owns the unified Context read
// API in `capabilities/agency/context`; kernel cannot import a capability, so the
// implementation is installed at startup (like review-due) and callers go through
// this port instead of a cross-capability edge.
//
// `view` names come from `@/ai/task-spec` CONTEXT_VIEWS — the same vocabulary the
// audit:context-consumers check validates TaskSpec `context` declarations against.

import type { ContextViewName } from '@/ai/task-spec';
import type { Db, Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

type DbLike = Db | Tx;

export interface LearnerContextInput {
  readonly view: ContextViewName;
  readonly now?: Date;
}

/** The assembled startup segment plus the metadata needed to verify its budget. */
export interface LearnerContextResult {
  readonly view: ContextViewName;
  /** Rendered startup-segment markdown, trimmed to the view's token budget. */
  readonly markdown: string;
  /** Estimated prompt tokens of `markdown` (deterministic estimator, not a tokenizer). */
  readonly estimatedTokens: number;
  /**
   * 裁剪遥测（无内容，只有单元名 + token 数）：哪些 unit 因预算被丢、丢前整段的
   * 估计 token。调用方落运行记录后可 SQL 查明细被裁频率。
   */
  readonly startupTrim?: {
    readonly droppedUnits: readonly string[];
    readonly tokensBeforeTrim: number;
  };
  /** High-water mark the delta section covers events after (ISO): the last
   *  Dreaming consolidation, or a fixed lookback bound when none has run yet. */
  readonly asOf: string;
  /** What `asOf` actually is: a real consolidation mark or the lookback fallback. */
  readonly asOfBasis: 'dreaming' | 'lookback';
}

export type LearnerContextLoader = (
  db: DbLike,
  input: LearnerContextInput,
) => Promise<LearnerContextResult>;

const LOADER_SLOT = 'kernel/read-models/learner-context:loader';

export function installLearnerContextLoader(loader: LearnerContextLoader): void {
  installHostOperation(LOADER_SLOT, loader);
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
  const loader = installedHostOperation<LearnerContextLoader>(LOADER_SLOT);
  if (!loader) {
    throw new HostOperationNotInstalledError(
      'learner-context loader is not installed; call installAgencyHostOperations at startup',
    );
  }
  return loader(db, input);
}
