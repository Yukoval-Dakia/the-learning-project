// Host port for the bounded wrong-answer blocks an intervention author quotes.
// Agency owns the probe-evidence loader; practice calls this port so the two
// capabilities do not import each other. A missing install is a host wiring
// defect, not an empty evidence read.

import type { Db, Tx } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

type DbLike = Db | Tx;

export interface LearnerEvidenceRef {
  kind: string;
  id: string;
}

/** Closed verdict projected onto one quoted wrong answer. */
export interface LearnerEvidenceJudgement {
  result: 'incorrect' | 'correct' | 'ungradable' | 'unknown';
  coarse_outcome: string | null;
  target_error_match: 'matched' | 'not_matched' | 'ambiguous' | null;
}

/** Owner note wins over the judge write-up; both arrive already delimited. */
export interface LearnerEvidenceCause {
  category: string | null;
  source: 'user' | 'agent' | null;
  attribution_md: string | null;
}

/**
 * One evidence ref resolved far enough to quote. Free text is already truncated
 * and delimited by the probe-evidence loader. `answer_image_count` records a
 * photo answer without attaching bytes: the author task stays text-only.
 */
export interface LearnerEvidenceBlock {
  ref: LearnerEvidenceRef;
  source: 'failure_attempt' | 'probe_result';
  question_id: string | null;
  question_prompt_md: string | null;
  parent_question_prompt_md: string | null;
  answer_md: string | null;
  answer_image_count: number;
  judgement: LearnerEvidenceJudgement;
  cause: LearnerEvidenceCause | null;
}

export interface LearnerEvidenceLoad {
  blocks: LearnerEvidenceBlock[];
  /**
   * Raw prompts of the quoted wrong questions. The author compares a transfer
   * prompt against these and does not send this list to the model; the model
   * already sees the delimited prompts on each block.
   */
  missed_prompt_md: string[];
  /** Refs that are not a quotable wrong answer (missing row, edited prompt, other kind). */
  unresolved_ref_count: number;
  /**
   * Quotable wrong answers past the block cap. Their text is not sent, but their
   * prompts still reject a transfer that repeats the original question.
   */
  omitted_ref_count: number;
}

export type LearnerEvidenceLoader = (
  db: DbLike,
  refs: readonly LearnerEvidenceRef[],
) => Promise<LearnerEvidenceLoad>;

const LOADER_SLOT = 'kernel/read-models/learner-evidence:loader';

export function installLearnerEvidenceLoader(loader: LearnerEvidenceLoader): void {
  installHostOperation(LOADER_SLOT, loader);
}

export async function loadLearnerEvidence(
  db: DbLike,
  refs: readonly LearnerEvidenceRef[],
): Promise<LearnerEvidenceLoad> {
  const loader = installedHostOperation<LearnerEvidenceLoader>(LOADER_SLOT);
  if (!loader) {
    throw new HostOperationNotInstalledError(
      'learner-evidence loader is not installed; call installAgencyHostOperations at startup',
    );
  }
  return loader(db, refs);
}
