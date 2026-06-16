// YUK-164 OC-5 — shared auto-enroll review helpers.
//
// One place that BOTH AutoEnrolledPanel (slice 2) and VisionTab prefill (slice 3)
// import from, so the two UI surfaces share the wire-shape type + the pure
// seeding/formatting/gating logic without importing each other's components.
//
// All exports here are PURE (no React, no IO). This is deliberate: the prefill
// + banner-derivation + revert-gating logic is unit-tested directly on the
// node-only test stack (no jsdom / @testing-library), per the lane plan §1
// "Test-stack reality". Components only render markup; logic lives here.

// Form-value types mirror VisionTab's form unions so the seeded subset stays
// structurally compatible with `BlockFormState` (slice 3 spreads
// `SeededBlockForm` over it). The kind union is consolidated to
// @/core/schema/business (YUK-387 Step 0) — same 8-value UI-selectable subset.
import type { QuestionKindOptionId } from '@/core/schema/business';

type QuestionKindId = QuestionKindOptionId;
type CauseCategoryId = string;

// ---------------------------------------------------------------------------
// Wire shape — what GET /api/ingestion/[id]/blocks returns as
// `auto_enroll_observation` per row.
//
// This is the FROZEN wire shape the panel + prefill build against. `mistake_draft`
// is surfaced by slice 1's extension to `toAutoEnrollObservation`
// (src/capabilities/ingestion/api/blocks.ts). The pinned key names below match the
// source schemas verbatim (lane plan §4): `wrong_answer` (NOT `outcome`), and the
// cause subset is `{ primary_category, analysis_md }` (CauseSchema has no
// `user_notes`). Fields the route cannot resolve come back `null`.
// ---------------------------------------------------------------------------

/** The `mistake_draft` subset slice 1 surfaces off the observed event payload. */
export interface AutoEnrollMistakeDraft {
  // The judge's outcome verdict. Source field is `wrong_answer` (mistake_enroll.ts),
  // surfaced verbatim — do NOT rename to `outcome`.
  wrong_answer: 'failure' | 'partial' | 'success' | 'unanswered' | null;
  difficulty: number | null;
  // Pinned cause subset: CauseSchema's { primary_category, analysis_md } only.
  cause: { primary_category: string | null; analysis_md: string | null } | null;
}

export interface AutoEnrollObservation {
  event_id: string;
  // event.outcome column passthrough (distinct from mistake_draft.wrong_answer).
  outcome: string | null;
  mode: string | null;
  route: string | null;
  confidence: number | null;
  threshold: number | null;
  reasoning: string | null;
  suggested_knowledge_ids: string[];
  // Surfaced by slice 1. `null` when the event payload carried no mistake_draft.
  mistake_draft: AutoEnrollMistakeDraft | null;
  observed_at: string;
}

/**
 * Minimal block shape the helpers below need. Both the panel rows and VisionTab's
 * BlockRow are supersets of this — callers pass their own richer row and it
 * structurally satisfies this. `status` is the 4-state question_block union; only
 * `auto_enrolled` rows are revertable (the rest stay observe-only).
 */
export interface AutoEnrollBlockLike {
  status: 'draft' | 'imported' | 'ignored' | 'auto_enrolled';
  auto_enroll_observation: AutoEnrollObservation | null;
}

// ---------------------------------------------------------------------------
// Confidence formatting — mono `confidence X.XX`, used by the panel row.
// ---------------------------------------------------------------------------

/**
 * Format a 0..1 confidence as the mono `confidence X.XX` label (loom:205).
 * `null`/non-finite → a stable placeholder so the row never renders `NaN`.
 */
export function formatConfidence(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'confidence —';
  return `confidence ${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Banner derivation + revert gating — both derive from the SAME blocks data
// source (lane plan §3 P2-3 hard contract), never from the session-list count.
// ---------------------------------------------------------------------------

/**
 * Show the observe-only banner when NONE of the loaded blocks for the selected
 * session are `auto_enrolled` (flag OFF / observe-only production). When any
 * loaded block IS enrolled (flag ON), drop the banner.
 *
 * Derived from the loaded blocks — the SAME source as the per-row revert gate —
 * so banner and per-row affordances stay consistent within one refetch
 * (the session-list `auto_enrolled_count` is cached separately and can lag).
 */
export function shouldShowObserveBanner(
  blocks: ReadonlyArray<Pick<AutoEnrollBlockLike, 'status'>>,
): boolean {
  return blocks.every((b) => b.status !== 'auto_enrolled');
}

/** A block is revertable only when its block status is `auto_enrolled`. */
export function isRevertable(block: Pick<AutoEnrollBlockLike, 'status'>): boolean {
  return block.status === 'auto_enrolled';
}

// ---------------------------------------------------------------------------
// Prefill — pure seed of a block's form values from its auto_enroll_observation.
// Extracted as a pure fn so slice 3's seed `useEffect` is a one-line call and the
// mapping is unit-testable without a DOM.
// ---------------------------------------------------------------------------

/**
 * The subset of VisionTab's `BlockFormState` that prefill seeds. VisionTab spreads
 * this over today's hardcoded defaults, so any field omitted here keeps its
 * existing default. Kept structurally compatible with `BlockFormState` (slice 3).
 */
export interface SeededBlockForm {
  knowledge_ids: string[];
  cause_primary: CauseCategoryId | '';
  cause_notes: string;
  question_kind: QuestionKindId;
  difficulty: number;
}

/** Today's defaults when a block carries no AI observation (regression baseline). */
const DEFAULT_SEED: SeededBlockForm = {
  knowledge_ids: [],
  cause_primary: '',
  cause_notes: '',
  question_kind: 'short_answer',
  difficulty: 3,
};

/**
 * Map a block's `auto_enroll_observation` to seeded form values:
 *  - suggested_knowledge_ids → knowledge_ids
 *  - mistake_draft.difficulty → difficulty
 *  - mistake_draft.cause.primary_category → cause_primary
 *  - mistake_draft.cause.analysis_md → cause_notes (NOT a `user_notes` field — that
 *    does not exist on CauseSchema; analysis_md is the judge's cause text)
 *
 * When no observation (or no mistake_draft / null cause), falls back to today's
 * defaults. `cause_primary` + `knowledge_ids` are seeded together so the in-
 * component self-heal effect (VisionTab.tsx:543-547) admits the seeded cause.
 */
export function seedBlockForm(block: {
  auto_enroll_observation: AutoEnrollObservation | null;
}): SeededBlockForm {
  const obs = block.auto_enroll_observation;
  if (!obs) return { ...DEFAULT_SEED };

  const draft = obs.mistake_draft;
  const cause = draft?.cause ?? null;

  return {
    knowledge_ids: [...obs.suggested_knowledge_ids],
    cause_primary:
      typeof cause?.primary_category === 'string' && cause.primary_category.length > 0
        ? cause.primary_category
        : '',
    cause_notes: typeof cause?.analysis_md === 'string' ? cause.analysis_md : '',
    question_kind: DEFAULT_SEED.question_kind,
    // Clamp to the import contract's 1..5 (import route Zod: int().min(1).max(5)).
    // The judge's difficulty has no upstream guarantee of being in range, and an
    // out-of-range seed would sit in the form and 400 on submit (range slider won't
    // re-clamp unless dragged). Round first so a float seed lands on an int.
    difficulty:
      typeof draft?.difficulty === 'number' && Number.isFinite(draft.difficulty)
        ? Math.min(5, Math.max(1, Math.round(draft.difficulty)))
        : DEFAULT_SEED.difficulty,
  };
}
