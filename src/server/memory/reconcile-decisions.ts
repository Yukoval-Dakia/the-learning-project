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

type Warn = (message: string) => void;
const ignoreWarning: Warn = () => {};

// Conservative floor, not fitted: clearly above mem0's 0.1 pre-filter and well below
// a high-confidence duplicate. This gate is reinforcement, not the primary 0.6
// confidence filter; revisit with the real llm_raw.referenced_score distribution.
export const MERGE_RETRACT_SCORE_FLOOR = 0.5;

/**
 * Second, non-LLM structural gate: destructive actions must also clear the score
 * floor of the referenced candidate. SUPERSEDE/KEEP_BOTH are exempt because a
 * soft supersede is reversible. A missing score abstains, and the caller must log
 * that fail-open path.
 */
export function passesStructuralCorroboration(
  action: ReconcileAction,
  referencedCandidateScore: number | undefined,
): boolean {
  if (action !== 'MERGE' && action !== 'RETRACT_NEW') return true;
  if (referencedCandidateScore === undefined) return true;
  return referencedCandidateScore >= MERGE_RETRACT_SCORE_FLOOR;
}

/**
 * Weakness/event MERGE is always forbidden: mistake trajectories keep historical
 * value, and a high similarity score is exactly when the LLM is most confidently
 * wrong, so the score gate cannot catch this. Returns true when the kind forbids MERGE.
 */
export function kindForbidsMerge(kind: string): boolean {
  return kind === 'weakness' || kind === 'event';
}

/**
 * Actions whose apply physically drops a mem0 row: MERGE (absorbs the new row) and
 * RETRACT_NEW (drops it). Kept separate from needsOldTarget so gates, logging, and
 * the client requirement cannot drift apart.
 */
export function isHardDelete(action: ReconcileAction): boolean {
  return action === 'MERGE' || action === 'RETRACT_NEW';
}

/**
 * Actions that reference an existing candidate: SUPERSEDE marks it, MERGE rewrites
 * it. Drives bad-target degrade and the write-ahead prev_metadata capture.
 */
export function needsOldTarget(action: ReconcileAction): boolean {
  return action === 'SUPERSEDE' || action === 'MERGE';
}

function downgradeToKeepBoth(
  prefix: string,
  orig: string,
): { action: ReconcileAction; reason: string } {
  return { action: 'KEEP_BOTH', reason: `${prefix}. ${orig}` };
}

/**
 * Score for the RETRACT_NEW null-old_index fallback. max is permissive to an
 * entity-boosted outlier, but this path is the noise/duplicate fallback where the
 * floor aborts to the safe skip alternative anyway.
 */
function topCandidateScore(cands: CandidateEntry[]): number | undefined {
  const scores = cands.map((c) => c.score).filter((s): s is number => typeof s === 'number');
  return scores.length > 0 ? Math.max(...scores) : undefined;
}

/** Ordered synthesis keeps the original recommendation separate from the allowed action. */
export function applyDecisionGates(
  d: ReconcileDecision,
  newMem: NewMemoryEntry | undefined,
  cands: CandidateEntry[],
  warn: Warn = ignoreWarning,
) {
  const oldMem = d.old_index != null ? cands[d.old_index] : undefined;
  // An unresolved old_index is invalid for every action, including RETRACT_NEW
  // (which is not in needsOldTarget): otherwise a bogus index could reach a
  // deletion path on the fallback/abstain route.
  const invalidOldIndex = d.old_index != null && !oldMem;
  const badTarget =
    !newMem ||
    invalidOldIndex ||
    (needsOldTarget(d.action) && !oldMem) ||
    (d.action === 'RETRACT_NEW' && !newMem);

  // Unified synthesis: bad target → per-kind → score floor → final. Every
  // downgrade rewrites reason together with action so the WAL cannot diverge.
  let action: ReconcileAction = d.action;
  let reason = d.reason;

  // 1) bad target: out-of-range or unresolved old index
  if (badTarget) {
    ({ action, reason } = downgradeToKeepBoth(
      `out-of-range index downgraded from ${d.action}`,
      d.reason,
    ));
  }

  // 2) per-kind: weakness/event forbid MERGE
  if (action === 'MERGE' && newMem && kindForbidsMerge(newMem.kind)) {
    ({ action, reason } = downgradeToKeepBoth(
      `Per-kind guard (kind=${newMem.kind} forbids MERGE); downgraded from MERGE`,
      reason,
    ));
    warn(
      `[memory_reconcile] per-kind MERGE suppressed (kind=${newMem.kind}) new_index=${d.new_index}`,
    ); // Q3 detection
  }

  // 3) score floor: MERGE uses the referenced candidate's score. RETRACT_NEW uses
  // it too when present, and only falls back to the max candidate score when there
  // is no referenced candidate (old_index null). A referenced candidate without a
  // score abstains instead of borrowing the max.
  let referencedScore: number | undefined;
  if (action === 'MERGE') {
    referencedScore = oldMem?.score;
  } else if (action === 'RETRACT_NEW') {
    referencedScore = oldMem ? oldMem.score : topCandidateScore(cands);
  }
  const corroborated = passesStructuralCorroboration(action, referencedScore);
  // Only MERGE/RETRACT_NEW can fail corroboration, so this also implies a hard delete.
  if (!corroborated) {
    ({ action, reason } = downgradeToKeepBoth(
      `Low structural corroboration (score=${referencedScore}); downgraded from ${action}`,
      reason,
    ));
    warn(
      `[memory_reconcile] score-floor downgrade (score=${referencedScore}) new_index=${d.new_index}`,
    ); // Q3 detection
  } else if (isHardDelete(action) && referencedScore === undefined) {
    warn(
      `[memory_reconcile] score-floor skipped (no candidate score) action=${action} new_index=${d.new_index}`,
    ); // m8
  }

  // 4) Model output is advisory. Memory text is user-authored and therefore an
  // untrusted prompt boundary; no recommendation may rewrite or delete a stored
  // memory without a separate human-approval surface. Preserve the recommendation
  // in llm_raw, but make the WAL action non-destructive.
  if (action !== 'KEEP_BOTH') {
    const recommendedAction = action;
    ({ action, reason } = downgradeToKeepBoth(
      `Human approval required; blocked model-recommended ${recommendedAction}`,
      reason,
    ));
    warn(
      `[memory_reconcile] destructive recommendation blocked action=${recommendedAction} new_index=${d.new_index}`,
    );
  }

  return { action, reason, oldMem, referencedScore, corroborated };
}

export function deduplicateDecisions(
  decisions: ReconcileDecision[],
  warn: Warn = ignoreWarning,
): ReconcileDecision[] {
  const seenNewIndex = new Set<number>();
  const uniqueDecisions = decisions.filter((d) => {
    if (seenNewIndex.has(d.new_index)) {
      warn(
        `[memory_reconcile] duplicate new_index ${d.new_index} dropped (action=${d.action}); first decision wins`,
      );
      return false;
    }
    seenNewIndex.add(d.new_index);
    return true;
  });

  return uniqueDecisions;
}
