import { z } from 'zod';
import { FigureRef, StructuredQuestion } from '../structured_question';
import { QuestionBlockRowSnapshot } from './genesis';

// ====================================================================
// question_block action events — YUK-471 Wave 3 (question_block fold, design §3 #5/#6)
// ====================================================================
//
// `question_block.structured` is the BIGGEST self-sufficiency gap of the epic (design §0/§2.2): its
// 5 structured-rewrite functions (updatePrompt / addOption / setQuestionType / splitStem /
// mergeQuestions, + reassignFigure re-pointing figures) all UPDATE the row then write a `job_events`
// row (`block.structured_edited`) whose payload is ONLY `{op, node_id}` — NOT in the canonical
// `event` table, NOT in the KnownEvent union, NOT replayable. Wave 3 closes the gap with two
// dedicated typed action events so every structured edit + every block creation becomes
// fold-visible + self-sufficient on the canonical log. They are reserved experimental actions (see
// RESERVED_EXPERIMENTAL_ACTIONS in ./experimental.ts) so a malformed payload is rejected at the
// parseEvent barrier instead of falling through to the loose generic ExperimentalEvent (the fold
// trusts these as ground truth — a loose fallback could silently corrupt the projection, §10 B5).
//
// ADDITIVE / INERT (W3-A2): this lane defines the event CONTRACT + parse barrier ONLY. The fold
// reducer (foldQuestionBlock) is W3-B2; the writer rewrites (persistStructured → canonical event,
// the OCR/rescue/docx INSERT → create-event conversions, applyRescue crop_refs fix) are W3-C1. The
// `job_events` SSE transport layer (1+N progress rows) stays UNCHANGED — it is orthogonal to the
// canonical log. Nothing here writes a row or wires a writer.
//
// FORK DECISIONS (design §0, proven correct by W2 as-built):
//   - SEPARATE runtime create event (`experimental:question_block_create`), NOT genesis-as-create —
//     genesis stays backfill-only (mirror MistakeVariantCreateExperimental / ArtifactCreate, A4).
//   - full-snapshot fold (each edit carries the AFTER structured tree per affected block), NOT
//     op-replay (design fork #1). merge folds via affected_blocks[] (A2 — there is NO `merged_into`
//     physical column; the reverse "merged into whom" relation is expressed FORWARD by the primary's
//     merged_from_block_ids, never persisted on the absorbed row).

// ── AffectedBlockSnapshot (A2 — NO merged_into physical column) ────────────────
//
// design §3 #5 / §5.2. ONE entry per block touched by a structured edit. A single-block edit
// (update_prompt / add_option / set_question_type / split_stem) carries exactly
// ONE entry (role='primary'). A merge carries the primary (role='primary', the merged-AFTER full
// tree) + N absorbed sources (role='merged_source', status flips to 'ignored').
//
//   - primary      → structured = the merged/after FULL tree (non-null); figures = primary's figures
//                    (the reducer reads `snap.figures ?? row.figures`, so figures MAY be omitted/null
//                    and the fold falls back to the current row value — design §5.2 reducer table).
//   - merged_source → structured = the operation-BEFORE value (optional, for undo); the reducer reads
//                    only status/version/updated_at from a merged_source (structured stays before).
//
// `.strict()` (A2 fail-loud): a stray key — most importantly a `merged_into_block_id` — is REJECTED
// at the barrier. That field has NO physical column (schema.ts question_block lacks it); the reducer
// must NEVER write it, and the create barrier structurally forbids it from ever entering the payload.
export const AffectedBlockSnapshot = z
  .object({
    block_id: z.string().min(1),
    role: z.enum(['primary', 'merged_source']),
    // primary = merged/after full tree; merged_source = operation-before value (undo, optional).
    structured: StructuredQuestion.nullable(),
    // only the primary carries figures; the reducer falls back to row.figures when absent (§5.2).
    figures: z.array(FigureRef).nullable().optional(),
    version: z.number().int(),
    status: z.string(), // free text on the table ('draft' | 'ignored' | …)
    // ★ NO merged_into_block_id — no physical column; .strict() above rejects it (A2).
  })
  .strict();
export type AffectedBlockSnapshotT = z.infer<typeof AffectedBlockSnapshot>;

// ── #5 experimental:edit_question_block_structured (single canonical, multi-row after) ──
//
// design §3 #5 [P0]. The 5 structured-rewrite ops (update_prompt / add_option / set_question_type /
// split_stem / merge_questions) ALL fold through the full AFTER snapshot carried
// in affected_blocks[] — the fold does LAST-WRITE-WINS, no op-replay. subject_id = the primary
// block id (the UNIQUE SoT anchor — only the primary changed its structured). A merge that produced
// 1+N job_events rows collapses to ONE canonical event here (solves C4); the absorbed rows ride in
// affected_blocks as role='merged_source' (solves A2 — true after-state, NO merged_into).
//
// NEW action name (design §3 #5, §5.2 gather Q2): the live writer emits the legacy `job_events`
// `block.structured_edited` (a transport row, NOT a canonical event). This canonical action is
// distinct — W3-C1 migrates persistStructured to ALSO write this event same-tx. `.strict()` payload
// so a typo fails loud at the barrier; the superRefine enforces the SoT-anchor coherence so a
// malformed multi-row payload (no primary / two primaries / anchor mismatch / null after-tree) is
// rejected before it can corrupt the fold (honest-reject, §10 B5).
export const EditQuestionBlockStructuredExperimental = z
  .object({
    actor_kind: z.enum(['agent', 'user']),
    actor_ref: z.string().min(1), // e.g. 'question_block_structured_editor'
    action: z.literal('experimental:edit_question_block_structured'),
    subject_kind: z.literal('question_block'),
    subject_id: z.string().min(1), // = the PRIMARY block id (the unique SoT anchor)
    outcome: z.literal('success').nullable().optional(),
    payload: z
      .object({
        op: z.enum([
          'update_prompt',
          'add_option',
          'set_question_type',
          'split_stem',
          'merge_questions',
          // NOTE: reassign_figure is intentionally NOT an op here. The live writer emits figure
          // re-pointing as a SEPARATE `figure.reassigned` job event (block-structured-edit.ts:615),
          // NOT through persistStructured / block.structured_edited — so it is not one of this
          // canonical action's ops (design §3 #5 lists exactly these 5). Whether figure-reassignment
          // becomes its own fold-source event is a W3-C1 / follow-up decision (YUK-471), out of A2 scope.
        ]),
        // ONE entry per touched block. min(1): a single-block edit has length 1; a merge has the
        // primary + N merged_sources (design §3 #5).
        affected_blocks: z.array(AffectedBlockSnapshot).min(1),
      })
      .strict(),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    const primaries = data.payload.affected_blocks.filter((b) => b.role === 'primary');
    // EXACTLY one primary: subject_id names the single SoT anchor (only the primary changed its
    // structured). Zero ⇒ no anchor for the fold; two ⇒ ambiguous after-tree. Both are writer bugs.
    if (primaries.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'affected_blocks must contain EXACTLY one role="primary" (the SoT anchor)',
        path: ['payload', 'affected_blocks'],
      });
      return; // the checks below dereference the single primary
    }
    const primary = primaries[0];
    // subject_id must equal the primary block id (design §3 #5: subject_id = primaryBlockId, the
    // unique SoT anchor). A mismatch would anchor the canonical event on a block the edit did not own.
    if (data.subject_id !== primary.block_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subject_id must equal the primary affected_block.block_id (the SoT anchor)',
        path: ['subject_id'],
      });
    }
    // The primary carries the AFTER full tree — the reducer sets row.structured = snap.structured
    // VERBATIM (no fallback, design §5.2). A null primary tree would fold a null over the column, so
    // an edit's primary MUST carry the post-edit structured tree.
    if (primary.structured === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the primary affected_block must carry a non-null structured (the after tree)',
        path: ['payload', 'affected_blocks'],
      });
    }
  });
export type EditQuestionBlockStructuredExperimentalT = z.infer<
  typeof EditQuestionBlockStructuredExperimental
>;

// ── #6 experimental:question_block_create (OCR/rescue/docx/import creation BASE) ──
//
// design §3 #6 [P1]. The runtime-creation BASE event for a question_block row, unifying the OCR
// (applyExtractionResult INSERT N rows), rescue (applyRescue structured overwrite), and docx
// ingestion paths. genesis is BACKFILL-ONLY; runtime creation writes this dedicated event carrying
// the FULL initial QuestionBlockRowSnapshot (full-snapshot rule: the fold cannot rebuild a row from
// the existing `ExtractSourceDocument` payload, which only stores structured_block_ids — IDs, no
// content). Mirrors MistakeVariantCreateExperimental / ArtifactCreate (critic A4): the reducer seeds
// the row from payload.row VERBATIM.
//
// `origin` (design §3 #6): provenance discriminator. `rescue` is a SECOND full-snapshot event for the
// SAME blockId — the reducer is last-write-wins, so a rescue overwrites structured/figures of an
// already-created block (design §5.2 reducer table). C1 also fixes applyRescue to write the derived
// `crop_refs = figures.map(asset_id)` so the rescue event carries the correct value and parity passes
// (F5 / driver §9 #3). `.strict()` that matters is on QuestionBlockRowSnapshot (genesis.ts) so a
// wrong/sibling row shape is rejected; subject_id === payload.row.id is enforced by the superRefine.
export const QuestionBlockCreateExperimental = z
  .object({
    actor_kind: z.enum(['agent', 'user', 'system']),
    actor_ref: z.string().min(1),
    action: z.literal('experimental:question_block_create'),
    subject_kind: z.literal('question_block'),
    subject_id: z.string().min(1), // = question_block.id (== payload.row.id)
    outcome: z.literal('success').nullable().optional(),
    payload: z.object({
      // FULL initial row snapshot (structured / figures / crop_refs / page_spans / status / …). The
      // reducer reads it VERBATIM as the row's base state — same shape genesis carries.
      row: QuestionBlockRowSnapshot,
      // creation provenance; rescue = overwrite of an existing blockId (fold last-write-wins, §5.2).
      origin: z.enum(['ocr', 'rescue', 'docx', 'import']),
    }),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // subject_id must name the same row the snapshot reproduces (mirrors GenesisExperimental /
    // MistakeVariantCreateExperimental: the create base seeds the row by its OWN id).
    if (data.subject_id !== data.payload.row.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'subject_id must equal payload.row.id (the create base seeds the row by its own id)',
        path: ['subject_id'],
      });
    }
  });
export type QuestionBlockCreateExperimentalT = z.infer<typeof QuestionBlockCreateExperimental>;
