export type ReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW';

export type ReconcileDecision = {
  new_index: number;
  action: ReconcileAction;
  old_index: number | null;
  confidence: number;
  reason: string;
  /**
   * Only meaningful for action=MERGE: the rewritten text that absorbs the new
   * memory into the existing one (becomes the surviving memory's payload.data).
   * parseReconcileResponse REQUIRES this when action=MERGE (else ReconcileParseError
   * → batch degrades to KEEP_BOTH) — never let `reason` stand in for merged text.
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
   * YUK-557 (Q1): mem0 Memory.search() fused score (pgvector cosine ⊕ BM25 ⊕
   * entity-boost, [0,1]) for this candidate — previously discarded. Consumed by
   * the second structural corroboration gate (passesStructuralCorroboration).
   * undefined = no score available (defensive) → that gate abstains (returns true).
   */
  score?: number;
};

/** Per-new-memory candidates: new_index → candidates found by search. */
export type CandidatesByNew = Map<number, CandidateEntry[]>;

type Warn = (message: string) => void;
const ignoreWarning: Warn = () => {};

// YUK-557 (Q1): 0.5 未经数据验证的保守地板值，非拟合结果（n=1 红线，spec Q1 论证 #4）。
// 明显高于 mem0 预过滤 0.1、明显低于"高置信度重复"直觉上限（0.8+）；本闸是加固层、
// 非主拦截层（主拦截仍是 0.6 confidence）。将来可用 llm_raw.referenced_score 真实分布回顾校准。
export const MERGE_RETRACT_SCORE_FLOOR = 0.5;

/**
 * YUK-557 (Q1) — second, non-LLM structural gate. MERGE/RETRACT_NEW must clear
 * BOTH the 0.6 confidence threshold (applyConfidenceThreshold) AND this floor on
 * the referenced candidate's mem0 fused score. SUPERSEDE/KEEP_BOTH are exempt
 * (softSupersede is reversible; the scarce structural signal is spent on the
 * irreversible destructive actions). score===undefined (no candidate to key on,
 * e.g. RETRACT_NEW noise with no neighbor) → this gate ABSTAINS (returns true);
 * the caller MUST then emit a "floor skipped (no score)" structured log (m8) so
 * that fail-open path stays visible/countable.
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
 * YUK-557 (Q1b) — deterministic per-kind execution gate. weakness/event MERGE is
 * always forbidden: those are mistake/error trajectories whose history has value
 * (prompt per-kind rule leans KEEP_BOTH; this hard-enforces it). High-similarity
 * wrong MERGE is exactly the hole passesStructuralCorroboration structurally
 * CANNOT plug (score is high precisely when the LLM is most overconfident), so a
 * kind-based guard is the only cheap close. Returns true = this kind forbids MERGE.
 */
export function kindForbidsMerge(kind: string): boolean {
  return kind === 'weakness' || kind === 'event';
}

/**
 * YUK-557 (F6) — the "hard-delete set": actions whose apply physically drops a
 * mem0 vector row (MERGE drops the absorbed new row; RETRACT_NEW drops the new
 * row). Distinct from `needsOldTarget` below (the "needs an existing old row"
 * set) — MERGE is in BOTH, RETRACT_NEW only here, SUPERSEDE only there. Used to
 * gate the score floor, the "floor skipped" log, the apply-time client
 * requirement, and the m7 client-less skip so they never drift apart.
 */
export function isHardDelete(action: ReconcileAction): boolean {
  return action === 'MERGE' || action === 'RETRACT_NEW';
}

/**
 * YUK-557 (F6) — the "needs an existing old row" set: actions that reference and
 * act on an existing candidate (SUPERSEDE marks it, MERGE rewrites it). Drives
 * bad-target degrade (no resolvable old row → KEEP_BOTH) and the write-ahead
 * prev_metadata capture (only these two have an old payload to snapshot).
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
 * YUK-557 (Q1) — max candidate score for the RETRACT_NEW null-old_index fallback.
 * outlier-permissive approximation: `max` is the statistic MOST sensitive to a
 * single entity-boosted candidate spiking to ~0.99, so it biases toward PASSING
 * the floor. Acceptable because the null-old_index path is the noise∪duplicate
 * fallback where floor-skip (undefined → gate abstains + log) is the safe
 * alternative. No scored candidates → undefined (caller logs "floor skipped").
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
  // YUK-557 (PR #699 CR-4): an explicitly-provided old_index that fails to
  // resolve to a candidate (LLM-hallucinated out-of-range index) is invalid
  // for EVERY action — fail-safe downgrade to KEEP_BOTH before any deletion
  // decision. Without this, RETRACT_NEW (NOT in needsOldTarget) would let a
  // bogus old_index slip past badTarget and delete the new memory on a top-
  // score/abstain path. Pairs with F3/V3: after this guard the RETRACT_NEW
  // topCandidateScore fallback only ever sees the legal old_index===null state.
  const invalidOldIndex = d.old_index != null && !oldMem;
  const badTarget =
    !newMem ||
    invalidOldIndex ||
    (needsOldTarget(d.action) && !oldMem) ||
    (d.action === 'RETRACT_NEW' && !newMem);

  // Unified synthesis: badTarget → per-kind (Q1b) → score-floor (Q1) →
  // final. Every downgrade routes through downgradeToKeepBoth so
  // action↔reason never diverge in the WAL (F6 / Lens A A5-1/A5-2).
  let action: ReconcileAction = d.action;
  let reason = d.reason;

  // 1) bad-target degrade (out-of-range / unresolved old index → KEEP_BOTH)
  if (badTarget) {
    ({ action, reason } = downgradeToKeepBoth(
      `out-of-range index downgraded from ${d.action}`,
      d.reason,
    ));
  }

  // 2) per-kind gate (Q1b): weakness/event forbid MERGE
  if (action === 'MERGE' && newMem && kindForbidsMerge(newMem.kind)) {
    ({ action, reason } = downgradeToKeepBoth(
      `Per-kind guard (kind=${newMem.kind} forbids MERGE); downgraded from MERGE`,
      reason,
    ));
    warn(
      `[memory_reconcile] per-kind MERGE suppressed (kind=${newMem.kind}) new_index=${d.new_index}`,
    ); // Q3 detection
  }

  // 3) score floor (Q1): MERGE keys on the referenced candidate's score;
  // RETRACT_NEW keys on the referenced candidate, else the topCandidateScore
  // fallback ONLY when there is NO referenced candidate (old_index=null). A
  // referenced candidate that carries no score must NOT fall through to max —
  // it abstains (undefined → gate passes) + logs m8, symmetric with MERGE
  // (F3: max fallback is authorized only for old_index=null).
  // OCR (PR #699, triggers.ts:743) — if/else chain (repo bans nested
  // ternaries; semantics unchanged): MERGE keys on the referenced candidate;
  // RETRACT_NEW keys on the referenced candidate, else the topCandidateScore
  // fallback ONLY when there is NO referenced candidate (old_index===null);
  // every other action abstains (undefined).
  let referencedScore: number | undefined;
  if (action === 'MERGE') {
    referencedScore = oldMem?.score;
  } else if (action === 'RETRACT_NEW') {
    referencedScore = oldMem ? oldMem.score : topCandidateScore(cands);
  }
  const corroborated = passesStructuralCorroboration(action, referencedScore);
  // !corroborated already implies isHardDelete(action): passesStructural-
  // Corroboration only returns false for MERGE/RETRACT_NEW (dead action
  // conjunct removed, F6/V7).
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

  // 4) YUK-690 execution policy: model output is advisory only. Memory
  // events are user-authored text and therefore an untrusted prompt
  // boundary; no LLM recommendation may supersede, rewrite or delete a
  // stored memory without a separate human-approval surface. Preserve the
  // original decision in llm_raw below, but deterministically make the WAL
  // action non-destructive.
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
