import {
  GenesisExperimental,
  QuestionBlockRowSnapshot,
  type QuestionBlockRowSnapshotT,
} from '../schema/event/genesis';
import {
  EditQuestionBlockStructuredExperimental,
  QuestionBlockCreateExperimental,
  QuestionBlockLifecycleExperimental,
} from '../schema/event/question-block-events';
import type { FoldEvent } from './fold-event';

// ====================================================================
// foldQuestionBlock — the W3 structural fold for a single `question_block` row (YUK-471 Wave 3,
// design §5.2). PURE question_block reducer. The fold==row invariant core — with the epic's HARDEST
// twist: merge multi-row aggregation (ONE edit event affects several blocks).
// ====================================================================
//
// Projects the current structural state of ONE question_block (`blockId`) from the event log,
// mirroring the W1 foldKnowledgeNode (THE merge template) / W3-B1 foldArtifact patterns. Instead of
// mutating the `question_block` table in place, the OCR/rescue/docx creation sites append the BASE
// create event, the 5 structured-rewrite ops (updatePrompt / addOption / setQuestionType / splitStem
// / mergeQuestions in block-structured-edit.ts) append a single canonical edit event, and this fold
// REPRODUCES the row the imperative writers (applyExtractionResult / applyRescue / persistStructured
// / mergeQuestions) would have written. fold(events) == row is the checkable invariant the SoT flip
// rests on.
//
// ── BASE = create OR genesis, with RESCUE last-write-wins (design §5.2, fork #2) ────────────────
// The row's BASE/init state comes from EITHER:
//   - experimental:question_block_create — the RUNTIME creation base (OCR/rescue/docx/import), OR
//   - experimental:genesis               — the BACKFILL base (pre-W3 rows).
// BOTH carry the FULL initial QuestionBlockRowSnapshot in payload.row (full-snapshot rule: the fold
// CANNOT rebuild a row from the id-only ExtractSourceDocument payload). genesis is backfill-only and
// idempotent → FIRST BASE WINS (a duplicate seed never re-clobbers). question_block_create is
// DIFFERENT from artifact's create: `origin='rescue'` is a SECOND create event for the SAME blockId
// that OVERWRITES the whole row from its snapshot (design §5.2 reducer table: "last-write-wins,
// rescue 是同 blockId 第二条"). So create ALWAYS applies its payload.row verbatim — it is the only
// branch that intentionally overwrites an already-seeded base.
//
// ── THE HARD PART — merge multi-row aggregation (design §5.2, C4) ───────────────────────────────
// experimental:edit_question_block_structured is KEYED on the PRIMARY block (subject_id =
// primaryBlockId — the unique SoT anchor, the only block whose structured changed). Its
// affected_blocks[] carries the primary (role='primary') + (for merge_questions) N absorbed sources
// (role='merged_source'). So for foldQuestionBlock(blockId) the reducer does NOT filter the edit
// event on subject_id — it inspects each edit event's affected_blocks to find blockId's ROLE and
// applies the matching branch:
//   • blockId is the PRIMARY (entry.role==='primary'; here subject_id===blockId too, enforced by the
//     schema superRefine) → set structured = entry.structured VERBATIM (the after full tree;
//     superRefine guarantees non-null), figures = entry.figures ?? row.figures (the snapshot omits
//     figures unless the op re-pointed them, design §5.2), status = entry.status, version =
//     entry.version, updated_at = the EVENT's created_at. On op='merge_questions' also append the
//     absorbed source ids to merged_from_block_ids (reproduces the live writer's
//     [...primary.merged_from_block_ids, ...mergeIds], block-structured-edit.ts:505).
//   • blockId is a MERGED_SOURCE (entry.role==='merged_source'; the event is keyed on the PRIMARY,
//     so subject_id !== blockId and Q1 missed it — the IO-shell gather's Q2 jsonb-containment query
//     surfaces it) → apply ONLY the absorbed effect: status = entry.status ('ignored'), version =
//     entry.version (the live writer does NOT bump the absorbed block's version,
//     block-structured-edit.ts:513 — so the snapshot's version equals the unchanged value and the
//     fold takes it verbatim), updated_at = the EVENT's created_at. The reducer NEVER overwrites an
//     absorbed block's structured (it stays at its before-value — a merge does not re-author the
//     absorbed tree) and NEVER writes merged_into (no physical column; A2).
//   • blockId not in affected_blocks → skip (the edit did not touch this block).
//
// ── updated_at is EVENT-DERIVED (single-clock, like W2 / foldArtifact) ──────────────────────────
// updated_at is stamped from the EVENT's created_at on every edit, NOT read off a snapshot field
// (it is not a fold-input on the edit — only create/genesis seed it). This is the single-clock model
// W2 proved: the live writer must stamp the row's updated_at from the SAME `now` it writes the event
// at for byte-exact parity (design §3 F3 — mergeQuestions' two independent `new Date()` at :505/:513
// must be unified to one clock by C1).
//
// PURITY CONTRACT (identical to W1/W2/B1): no IO, no DB, no newId(), no Date.now() / new Date(). Same
// input → byte-identical output. The reducer NEVER mints ids or timestamps — it stamps updated_at
// from the relevant event's `created_at` and reads version off the event payload. Determinism is
// what makes fold(events) == row a checkable invariant.
//
// GATHER STRATEGY (design §5.2): Q1 (subject_kind='question_block' AND subject_id=blockId → genesis +
// question_block_create + edit-as-primary) + Q2 (the jsonb-containment reverse query that finds edit
// events absorbing blockId as a merged_source, where subject_id is the PRIMARY ≠ blockId). The IO
// shell (src/server/projections/question_block.ts) owns the gather; the reducer is correct on the
// union superset. NO rate caused_by chain (create/edit are direct, not propose→accept).
//
// ✅ ALL LIVE QUESTION_BLOCK MUTATORS ARE NOW FOLD-VISIBLE (YUK-471 W3-D — flip prerequisite MET;
// like foldArtifact, whose set went EMPTY after the W3-C1γ cutover). Every `subject_kind:'question_block'`
// write path now appends a self-sufficient event the branches below reproduce: question_block_create /
// genesis (base; rescue is a second create that last-write-wins) · edit_question_block_structured (the 5
// structured-rewrite ops, incl. the merge multi-row aggregation) · question_block_lifecycle (the LAST
// gap — the 5 formerly-eventless fold-truth mutators: reassignFigure → figures; runAutoEnrollForSession /
// import-enroll / import-ignore / revertAutoEnrolledBlock → status + imported_*). NOTHING outstanding for
// the question_block flip — its audit:projection can now go clean and W3-D is gate-able.
// (The legacy `job_events` `block.structured_edited` / `figure.reassigned` SSE transport rows are NOT
// `experimental:*` canonical actions and stay orthogonal — the fold ignores them.)

// toParseInput — reconstruct the Zod parse input from the flat FoldEvent columns (mirrors every
// sibling reducer). Each typed branch feeds this to its dedicated schema so a malformed payload is
// rejected at the reducer boundary rather than trusted (the fold treats these events as ground
// truth — a loose fallback could silently corrupt the projection).
function toParseInput(fe: FoldEvent): unknown {
  return {
    actor_kind: fe.actor_kind,
    actor_ref: fe.actor_ref,
    action: fe.action,
    subject_kind: fe.subject_kind,
    subject_id: fe.subject_id,
    outcome: fe.outcome,
    payload: fe.payload,
    caused_by_event_id: fe.caused_by_event_id ?? undefined,
  };
}

// Stable (created_at asc, id asc) comparator — the canonical event read order (identical tiebreak
// to every sibling reducer).
function byCreatedThenId(a: FoldEvent, b: FoldEvent): number {
  const ta = a.created_at.getTime();
  const tb = b.created_at.getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function warnMalformed(action: string, eventId: string, error: unknown): void {
  console.warn('foldQuestionBlock: skipping malformed event', { action, event_id: eventId, error });
}

// seedRow — clone the snapshot into the running row so the reducer NEVER mutates the input event's
// payload object (purity). Every array column is copied; the nested `structured` jsonb tree (and the
// FigureRef objects) are REPLACED wholesale by edits, never mutated in place, so a shallow array
// copy is enough for determinism (same input → same output graph).
function seedRow(snapshot: QuestionBlockRowSnapshotT): QuestionBlockRowSnapshotT {
  return {
    ...snapshot,
    source_asset_ids: [...snapshot.source_asset_ids],
    page_spans: [...snapshot.page_spans],
    figures: [...snapshot.figures],
    image_refs: [...snapshot.image_refs],
    crop_refs: [...snapshot.crop_refs],
    merged_from_block_ids: [...snapshot.merged_from_block_ids],
  };
}

/**
 * Pure structural fold of a single `question_block` row from the event log.
 *
 * @param blockId  the question_block row id to project.
 * @param events   ALL candidate events (flat FoldEvent rows). The reducer internally SELECTS which
 *                 affect `blockId` (incl. merge events where blockId is an absorbed merged_source and
 *                 the event is keyed on a DIFFERENT primary) — callers pass a superset (the IO shell
 *                 narrows via the Q1+Q2 gather first, but the reducer must be correct on a superset).
 * @returns the projected row, or `null` if `blockId` was never created/seeded.
 */
export function foldQuestionBlock(
  blockId: string,
  events: FoldEvent[],
): QuestionBlockRowSnapshotT | null {
  const ordered = [...events].sort(byCreatedThenId);

  let row: QuestionBlockRowSnapshotT | null = null;

  for (const fe of ordered) {
    // ---------- BASE: experimental:question_block_create (runtime create OR rescue overwrite) ----------
    // LAST-WRITE-WINS, NOT first-base-wins (unlike artifact's create): a rescue (origin='rescue') is a
    // SECOND create event for the SAME blockId that overwrites the whole row from its snapshot
    // (design §5.2). So this branch ALWAYS applies payload.row verbatim. The envelope filter
    // (subject_kind + subject_id) + the schema superRefine (subject_id === payload.row.id) pin the
    // overwrite to blockId's own row.
    if (
      fe.subject_kind === 'question_block' &&
      fe.subject_id === blockId &&
      fe.action === 'experimental:question_block_create'
    ) {
      const c = QuestionBlockCreateExperimental.safeParse(toParseInput(fe));
      if (!c.success) {
        warnMalformed('experimental:question_block_create', fe.id, c.error);
        continue;
      }
      row = seedRow(c.data.payload.row);
      continue;
    }

    // ---------- BASE: experimental:genesis (backfill seed of a pre-W3 row) ----------
    // FIRST BASE WINS — the backfill seed is idempotent (one per row); a duplicate genesis (or a
    // genesis arriving after a runtime create already seeded the row) must not re-clobber the base.
    if (
      fe.subject_kind === 'question_block' &&
      fe.subject_id === blockId &&
      fe.action === 'experimental:genesis'
    ) {
      if (row !== null) continue; // FIRST BASE WINS
      const g = GenesisExperimental.safeParse(toParseInput(fe));
      if (!g.success) {
        warnMalformed('experimental:genesis', fe.id, g.error);
        continue;
      }
      // The envelope is a generic genesis (subject_kind already filtered to 'question_block' above);
      // the genesis superRefine guarantees its payload.row is a question_block snapshot, but re-parse
      // defensively against QuestionBlockRowSnapshot (mirror sibling reducers).
      const seed = QuestionBlockRowSnapshot.safeParse(g.data.payload.row);
      if (!seed.success) {
        warnMalformed('experimental:genesis(row)', fe.id, seed.error);
        continue;
      }
      row = seedRow(seed.data);
      continue;
    }

    // ---------- edit_question_block_structured — multi-row aggregation (THE HARD PART, C4) ----------
    // NOT filtered on subject_id: the edit event is keyed on the PRIMARY block, so when blockId is
    // an absorbed merged_source the event's subject_id is a DIFFERENT block. The reducer inspects
    // affected_blocks to find blockId's ROLE and applies the matching branch (see the docblock).
    if (
      fe.action === 'experimental:edit_question_block_structured' &&
      fe.subject_kind === 'question_block'
    ) {
      // From here a base must exist (the edit mutates an already-seeded row).
      if (row === null) continue;
      const e = EditQuestionBlockStructuredExperimental.safeParse(toParseInput(fe));
      if (!e.success) {
        warnMalformed('experimental:edit_question_block_structured', fe.id, e.error);
        continue;
      }
      const blocks = e.data.payload.affected_blocks;
      const entry = blocks.find((b) => b.block_id === blockId);
      if (entry === undefined) continue; // this edit did not touch blockId

      if (entry.role === 'primary') {
        // The primary carries the AFTER full tree VERBATIM (superRefine guarantees non-null). figures
        // fall back to the current row value when the snapshot omits them (design §5.2 — only ops
        // that re-point figures carry them). On a merge, append the absorbed source ids to
        // merged_from_block_ids (reproduces block-structured-edit.ts:505); other ops leave it as-is.
        const absorbedIds =
          e.data.payload.op === 'merge_questions'
            ? blocks.filter((b) => b.role === 'merged_source').map((b) => b.block_id)
            : [];
        row = {
          ...row,
          structured: entry.structured,
          figures: entry.figures ?? row.figures,
          status: entry.status,
          version: entry.version,
          merged_from_block_ids:
            absorbedIds.length > 0
              ? [...row.merged_from_block_ids, ...absorbedIds]
              : row.merged_from_block_ids,
          updated_at: fe.created_at,
        };
        continue;
      }

      // role === 'merged_source': blockId was ABSORBED by the merge. Apply ONLY the absorbed effect —
      // status flips to 'ignored' (entry.status), version = entry.version VERBATIM (the live writer
      // does NOT bump the absorbed block's version — block-structured-edit.ts:513 — so the snapshot
      // carries the unchanged value), updated_at = the event time. The reducer NEVER overwrites the
      // absorbed block's structured (it stays at its before-value) and NEVER writes a merged_into
      // (no physical column; A2 — the reverse relation lives FORWARD on the primary's
      // merged_from_block_ids).
      row = {
        ...row,
        status: entry.status,
        version: entry.version,
        updated_at: fe.created_at,
      };
      continue;
    }

    // ---------- question_block_lifecycle — the 5 (formerly eventless) fold-truth mutators (W3-D) ----------
    // Mirrors artifact_lifecycle: PRESENCE-BASED apply of the after-values the previously-eventless
    // writers carry — reassignFigure → figures (op='reassign_figures'); runAutoEnrollForSession /
    // import-enroll / import-ignore / revertAutoEnrolledBlock → status + imported_* (op='set_status').
    // KEYED on subject_id === blockId (unlike the structured edit, this never aggregates a
    // merged_source from a different primary), so the simple envelope filter suffices. A writer carries
    // EXACTLY the columns its UPDATE touched; an undefined field ⇒ the column was left untouched → the
    // fold keeps the running value (so the ignore sweep, which omits imports, never clears them). The
    // imported_* fields honor an explicit carried null as a clear (revert). version = next_version
    // VERBATIM (the writer's bump rule); updated_at = the event time (single-clock, like every edit).
    if (
      fe.action === 'experimental:question_block_lifecycle' &&
      fe.subject_kind === 'question_block' &&
      fe.subject_id === blockId
    ) {
      // From here a base must exist (the lifecycle mutates an already-seeded row; a pre-W3 block with
      // no create/genesis anchor folds null and the mutation is skipped, mirroring every edit branch).
      if (row === null) continue;
      const l = QuestionBlockLifecycleExperimental.safeParse(toParseInput(fe));
      if (!l.success) {
        warnMalformed('experimental:question_block_lifecycle', fe.id, l.error);
        continue;
      }
      const p = l.data.payload;
      const next: QuestionBlockRowSnapshotT = {
        ...row,
        version: p.next_version,
        updated_at: fe.created_at,
      };
      // reassign_figures replaces the figures array wholesale (last-write-wins; the clone keeps the
      // reducer pure — never aliases the event payload's array). superRefine guarantees it is carried
      // for op='reassign_figures'.
      if (p.figures !== undefined) next.figures = [...p.figures];
      if (p.status !== undefined) next.status = p.status;
      // imported_*: a carried null is an explicit clear (revert) and is honored; undefined leaves it
      // (the ignore sweep). superRefine guarantees a non-empty status accompanies a set_status.
      if (p.imported_question_id !== undefined) next.imported_question_id = p.imported_question_id;
      if (p.imported_attempt_event_id !== undefined) {
        next.imported_attempt_event_id = p.imported_attempt_event_id;
      }
      row = next;
    }
  }

  return row;
}
