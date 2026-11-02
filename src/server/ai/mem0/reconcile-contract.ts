// Input/output contract of the Mem0 reconcile judge. Kept apart from the judge so the
// pipeline can name its types and parse error without loading the paid GLM call.
import type { DirectProviderOperationContext } from '../direct-provider-attempt';
import type { Env } from './llm-config';

export type ReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW';

export type ReconcileDecision = {
  new_index: number;
  action: ReconcileAction;
  old_index: number | null;
  confidence: number;
  reason: string;
  /**
   * MERGE only: the rewritten text that absorbs the new memory. The parser requires
   * it for MERGE; reason is never a substitute for merged text.
   */
  merged_text?: string | null;
};

/** A new memory with its extracted text and metadata for the prompt. */
export type NewMemoryEntry = {
  index: number;
  kind: string;
  text: string;
  memory_id: string;
  /** epoch-ms of the new memory (threaded from the ingest event) for recency. */
  created_ms: number;
};

/** An existing candidate memory for the prompt. */
export type CandidateEntry = {
  index: number;
  text: string;
  memory_id: string;
  created_ms?: number;
  /**
   * mem0's fused search score for this candidate. The structural corroboration
   * gate uses it; undefined means no score, so that gate abstains.
   */
  score?: number;
};

/** Per-new-memory candidates: new_index → candidates found by search. */
export type CandidatesByNew = Map<number, CandidateEntry[]>;

export class ReconcileParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'ReconcileParseError';
  }
}

export type ReconcileJudgeOptions = {
  env?: Env;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  providerAttempt?: DirectProviderOperationContext;
  beforeRequest?: () => Promise<void>;
};

export type ReconcileJudge = (
  newMems: NewMemoryEntry[],
  candidatesByNew: CandidatesByNew,
  opts?: ReconcileJudgeOptions,
) => Promise<ReconcileDecision[]>;
