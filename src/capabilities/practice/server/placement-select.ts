// Placement probe item selection — cold-start inc-B (YUK-468, PR-2a).
// docs/design/2026-06-20-cold-start-day-one-design.md §2 步骤3 / §5 inc-B (行 151-153).
//
// Picks the next question for a bounded placement probe over a goal's KG subgraph. The
// SCORING math is NOT reimplemented here — we hand the goal-subgraph candidates to the LIVE
// `collectCandidateSignals` (candidate-signals.ts), which folds in the production KLP/MFI
// switch (A3: cold-start KC evidence < EARLY_KLP_N → KLP posterior-weighted Fisher integral,
// warm KC → point MFI). This module only (1) finds the candidate questions touching the goal
// subgraph and (2) picks the max-information one — reusing the same selection signals the
// daily stream uses, so placement never forks the item-information definition.
//
// FRONTIER (MVP): candidates = active, non-draft questions whose knowledge_ids intersect the
// goal subgraph KC set. Walking the KG frontier ALONG prereq edges is inc-E
// (the prereq-propagation family — PREREQ_THETA_PROPAGATION_ENABLED / PREREQ_RISK_EMIT_ENABLED);
// until then the goal-subgraph ∩ KLP-information frontier is
// the bound. Subject scoping is a DERIVED axis (caller passes the effective-domain KC set via
// resolveSubjectKnowledgeIds) — NO subject root node (subject = view, not structure).
//
// PURE-ish: one bounded SELECT + the shared signal collection. No writes, no θ̂/FSRS mutation
// (those happen on answer via the existing /api/review/submit path — PR-2b wires the probe to
// it). Returns null when the goal subgraph has no eligible questions (cold DB) → the caller
// (start handler, PR-2b) dispatches quiz_gen to source starter questions (§6 Q3).

import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
import { QuestionKind } from '@/core/schema/business';
import type { SelectionCandidateSignal } from '@/core/selection-signals';
import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';
import { and, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { type CandidateInput, collectCandidateSignals } from './candidate-signals';

type DbLike = Db | Tx;

/**
 * YUK-480 — resolve the learner's self-reported subject `leanings` (effective-domain subject ids
 * from the Welcome screen) into the union of their KC sets, for use as `preferKnowledgeIds` in
 * selectNextPlacementItem. subject=view: each leaning resolves through the effective-domain axis
 * (resolveSubjectKnowledgeIds) — NO subject root node. Picks up newly-bridged KCs live (same
 * resolve-fresh rationale as placement-start's empty-frozen-scope re-resolve). Empty/omitted
 * leanings → empty set → no preference (selection is byte-identical to no-leaning).
 *
 * Kept SEPARATE from selectNextPlacementItem so the selector stays subject-agnostic (it takes a
 * plain KC set); both the /start and /next routes call this adapter then hand the result in.
 *
 * Takes the top-level `Db` (not a Tx): the leaning→KC derivation is an INDEPENDENT read over the
 * knowledge table (subject effective-domain axis), not part of the session-lock serialization, so
 * /next resolves it on the top-level client outside the row-lock tx — the locked session row is
 * already in hand (session.leanings).
 */
export async function resolveLeaningPreferenceKcs(
  db: Db,
  leanings: readonly string[] | null | undefined,
): Promise<string[]> {
  const subjects = Array.from(
    new Set((leanings ?? []).map((s) => s.trim()).filter((s) => s.length > 0)),
  );
  if (subjects.length === 0) return [];
  const sets = await Promise.all(subjects.map((s) => resolveSubjectKnowledgeIds(db, s)));
  return Array.from(new Set(sets.flat()));
}

/** DB question.kind (text, possibly dirty) → enum QuestionKindT or undefined. Same safe-parse
 * idiom as stream-store.ts:resolveEnumKind / the softmax side — kind only affects family-key
 * + recall routing in the signal layer, so an unrecognized value degrades to undefined, never
 * throws. */
function toEnumKind(kind: string | null | undefined): CandidateInput['kind'] {
  const parsed = QuestionKind.safeParse(kind);
  return parsed.success ? (parsed.data as CandidateInput['kind']) : undefined;
}

/**
 * Bound the candidate pool read. A placement probe needs the best-information item, not the
 * whole bank; 200 covers any realistic single-goal subgraph while capping the signal-
 * collection cost. If a subgraph ever exceeds this, the cap simply samples the first 200 by
 * scan order — acceptable for an MVP frontier (inc-E's prereq walk will scope tighter).
 */
const PLACEMENT_CANDIDATE_LIMIT = 200;

export interface SelectPlacementItemInput {
  /** the goal subgraph KC set (effective-domain derived; caller supplies, NOT a subject root). */
  knowledgeIds: readonly string[];
  /** questions already served/answered in THIS probe — excluded so the probe never repeats. */
  excludeQuestionIds?: readonly string[];
  /**
   * YUK-480 — leaning-preferred KC set (resolved from the learner's self-reported subject
   * leanings via resolveLeaningPreferenceKcs). A candidate whose knowledge_ids intersect this
   * set is PREFERRED in selection ORDER — it ranks above non-matching candidates regardless of
   * info score, but WITHIN a preference tier the max-information pick + id tie-break are
   * unchanged, and the REPORTED score/scoreKind stay the TRUE psychometric value (the preference
   * never rewrites the information score). This is a pure presentation-ordering preference
   * (owner-supplied fixed input, n=1 admissible §0.2 cat 1/2); it NEVER feeds θ̂/p(L)/FSRS
   * (§3 red line 4). Empty/omitted → ALL candidates tier-equal → selection is BYTE-IDENTICAL to
   * the no-preference path (regression anchor). In the common single-subject probe every
   * candidate matches (or none does) → uniform tier → no reordering; it only reorders a probe
   * pool that genuinely spans multiple subjects toward the leaning ones.
   */
  preferKnowledgeIds?: readonly string[];
}

export interface PlacementSelection {
  questionId: string;
  /** the information score that won (KLP cold / MFI warm). */
  score: number;
  /**
   * which criterion produced `score` (provenance). Sourced from the signal layer's own
   * scoreKind so it stays in sync as the criterion set grows (e.g. A4 added 'klp_grid',
   * YUK-436) — do NOT re-narrow this to a literal subset.
   */
  scoreKind: SelectionCandidateSignal['scoreKind'];
}

/**
 * Select the next placement-probe question over the goal subgraph, or null when none is
 * eligible (cold DB → caller sources via quiz_gen).
 *
 * Pick = the candidate with the MAX information score (collectCandidateSignals' `mfiScore`,
 * which is KLP for cold KCs / MFI for warm). Candidates with no score (no KC anchor or no b)
 * are skipped. Ties break deterministically by question id (stable, replay-safe).
 */
export async function selectNextPlacementItem(
  db: DbLike,
  input: SelectPlacementItemInput,
): Promise<PlacementSelection | null> {
  const kcs = Array.from(
    new Set((input.knowledgeIds ?? []).map((k) => k.trim()).filter((k) => k.length > 0)),
  );
  if (kcs.length === 0) return null;

  const exclude = Array.from(
    new Set((input.excludeQuestionIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
  );

  // YUK-480 — leaning preference set (empty → no preference → byte-identical to today). Used
  // ONLY to order selection (a candidate touching a leaning KC ranks above non-matching ones);
  // it does NOT alter the information score nor any θ̂/p(L) write.
  const prefer = new Set(
    (input.preferKnowledgeIds ?? []).map((k) => k.trim()).filter((k) => k.length > 0),
  );

  // Questions touching ANY goal-subgraph KC (jsonb @> containment, GIN-indexed — mirrors
  // candidate-signals.ts:267), excluding container-only drafts (draft_status='draft' must
  // never enter a probe pool — same NULL≡active handling as due-list.ts:236).
  const kcContainment = sql.join(
    kcs.map((kc) => sql`${question.knowledge_ids} @> ${JSON.stringify([kc])}::jsonb`),
    sql` OR `,
  );
  const notDraft = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));
  const whereClause =
    exclude.length > 0
      ? and(sql`(${kcContainment})`, notDraft, notInArray(question.id, exclude))
      : and(sql`(${kcContainment})`, notDraft);

  const rows = await db
    .select({
      id: question.id,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
      kind: question.kind,
      source: question.source,
    })
    .from(question)
    .where(whereClause)
    // ORDER BY id so the LIMIT truncation is DETERMINISTIC: when a subgraph exceeds the cap,
    // the SAME 200 questions are scanned every replay (keeps the replay-safe pick stable even
    // at the >200 boundary, not just within a fixed candidate set). id has a primary-key index.
    .orderBy(question.id)
    .limit(PLACEMENT_CANDIDATE_LIMIT);

  if (rows.length === 0) return null;

  // refId → its KC set, so the leaning-preference tier can be computed per candidate signal
  // (SelectionCandidateSignal carries refId but not knowledge_ids). Empty `prefer` → never read.
  const kcsByQuestion = new Map(rows.map((r) => [r.id, r.knowledge_ids ?? []]));
  const matchesLeaning = (questionId: string): boolean => {
    if (prefer.size === 0) return false;
    const kcs = kcsByQuestion.get(questionId) ?? [];
    return kcs.some((k) => prefer.has(k));
  };

  const candidates: CandidateInput[] = rows.map((r) => ({
    refKind: 'question',
    refId: r.id,
    // probe = exploring the learner's frontier; 'frontier' is the SelectionCandidateSignal role.
    role: 'frontier',
    kind: toEnumKind(r.kind),
    knowledgeIds: r.knowledge_ids,
    difficulty: r.difficulty,
    source: r.source,
  }));

  const signals = await collectCandidateSignals(db, candidates);

  // Pick order = leaning tier (YUK-480) ▸ max information score ▸ id tie-break. The leaning tier
  // is the TOP key: a candidate touching a leaning KC outranks any non-matching one. WITHIN a
  // tier the existing max-info pick + stable id tie-break are untouched, so with an empty
  // `prefer` (every candidate tier-equal at false) this is byte-identical to the pre-YUK-480
  // selection. The reported score/scoreKind stay the TRUE info value — the preference reorders
  // WHICH candidate wins, it never rewrites the psychometric score nor touches θ̂/p(L).
  let best: PlacementSelection | null = null;
  let bestPrefers = false;
  for (const s of signals) {
    if (s.mfiScore === undefined) continue;
    const prefers = matchesLeaning(s.refId);
    const better =
      best === null ||
      (prefers && !bestPrefers) ||
      (prefers === bestPrefers &&
        (s.mfiScore > best.score || (s.mfiScore === best.score && s.refId < best.questionId)));
    if (better) {
      best = { questionId: s.refId, score: s.mfiScore, scoreKind: s.scoreKind };
      bestPrefers = prefers;
    }
  }
  return best;
}
