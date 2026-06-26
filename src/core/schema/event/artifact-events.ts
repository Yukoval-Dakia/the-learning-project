import { z } from 'zod';
import {
  AgentRef,
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  NoteVerificationResult,
} from '../business';
import { ArtifactRowSnapshot } from './genesis';

// ====================================================================
// artifact action events — YUK-471 Wave 3 (artifact fold, design §3 #2/#3/#4)
// ====================================================================
//
// `artifact` is the widest fold-source surface of the epic (design §2.1): writers span 8 INSERT
// sites (6 files) + ~10 UPDATE sites, with event-provenance ranging from fully self-sufficient
// (`experimental:note_refine_apply`) to NO event at all (`note_generate` / `author_artifact`).
// Wave 3 closes the gap with three dedicated typed action events so every structural artifact
// mutation becomes fold-visible + self-sufficient. They are reserved experimental actions (see
// RESERVED_EXPERIMENTAL_ACTIONS in ./experimental.ts) so a malformed payload is rejected at the
// parseEvent barrier instead of falling through to the loose generic ExperimentalEvent (the fold
// trusts these as ground truth — a loose fallback could silently corrupt the projection, §10 B5).
//
// ADDITIVE / INERT (W3-A1): this lane defines the event CONTRACT + parse barrier only. The fold
// reducer (foldArtifact) is W3-B1; the writer rewrites (body-blocks-edit payload extension, the 8
// INSERT → create-event conversions, note_generate/note_verify status events, retract archive →
// lifecycle event) are W3-C1. Nothing here writes a row or wires a writer.
//
// FORK DECISIONS (design §0, proven correct by W2 as-built):
//   - SEPARATE runtime create event (`experimental:artifact_create`), NOT genesis-as-create —
//     genesis stays backfill-only (mirror MistakeVariantCreateExperimental, critic A4).
//   - full-snapshot body fold (each edit carries the AFTER body_blocks + previous_body_blocks for
//     revert), NOT op-replay (design fork #1).
//   - `GenerateArtifact` (known.ts) is KEPT AS-IS — it is the AI-intent business event (markdown
//     `body_md`, `outcome:'failure'` branch), NOT a fold-source. The dual-event collapse is the
//     OPEN owner decision §9.1; this lane does NOT touch it.
//
// Dedicated FILE (not known.ts) mirrors goal-events.ts / mistake-variant-events.ts / learning-
// item-events.ts — keeps the W2/W3 action events out of the busy known.ts union body.

// ── #2 experimental:body_blocks_edit (full-snapshot) ──────────────────────────
//
// design §3 #2 [P0]. Hand-edit (artifact_block_tree_editor) AND human inbox-accept
// (NOTE_REFINE_ACCEPT_ACTOR) both funnel here; the fold does LAST-WRITE-WINS on the carried AFTER
// snapshot (no applyNotePatch replay, the user_verified guard has no hook here — that hard boundary
// lives in the write gate, design §4.2). Carries the full post-edit body_blocks + previous (for
// revert; null = cold first write) + the after-history (F1 — otherwise the `history` column parity
// false-fails because a history push that is not in the payload cannot be reproduced).
//
// NEW action name (design §3 #2 "promote 出 artifact_body_blocks_edit"): the live writer
// (body-blocks-edit.ts:115) currently emits `experimental:artifact_body_blocks_edit` with a
// payload that LACKS body_blocks. Reusing that action name + reserving it would break every
// existing-on-disk edit event (they have no body_blocks → typed schema rejects, generic fallback
// rejects a reserved action). Picking the NEW `experimental:body_blocks_edit` lets old events keep
// their old action (parse via the loose generic, unchanged) while W3-C1 migrates the writer to the
// new self-sufficient action. `.strict()` payload so a typo fails loud at the barrier.
export const BodyBlocksEditExperimental = z
  .object({
    actor_kind: z.enum(['user', 'agent']),
    actor_ref: z.string().min(1), // 'artifact_block_tree_editor' | NOTE_REFINE_ACCEPT_ACTOR
    action: z.literal('experimental:body_blocks_edit'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string().min(1), // = artifact.id
    outcome: z.literal('success').nullable().optional(),
    payload: z
      .object({
        previous_artifact_version: z.number().int().nonnegative(),
        next_artifact_version: z.number().int().nonnegative(),
        // AFTER full snapshot (the value UPDATE'd in the same tx) — the fold reads it verbatim.
        body_blocks: ArtifactBodyBlocks,
        // BEFORE snapshot, for revert; null = cold first write (no prior body).
        previous_body_blocks: ArtifactBodyBlocks.nullable(),
        // F1: full after-history, else the `history` jsonb column parity false-fails.
        history_after: z.array(ArtifactHistoryEntry),
      })
      .strict(),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // version must advance (next > previous) — a non-advancing edit is a writer bug; the fold's
    // version-monotonicity invariant (design §7 W3-C3 F7) depends on it, so reject at the barrier.
    if (data.payload.next_artifact_version <= data.payload.previous_artifact_version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'next_artifact_version must be greater than previous_artifact_version',
        path: ['payload', 'next_artifact_version'],
      });
    }
  });
export type BodyBlocksEditExperimentalT = z.infer<typeof BodyBlocksEditExperimental>;

// ── #3 experimental:artifact_create (runtime creation BASE event) ─────────────
//
// design §3 #3 [P0]. The runtime-creation BASE event for an artifact row, unifying the 8 INSERT
// sites (design §2.1: make-paper / author-artifact / tool-quiz-core / quiz_gen / learning_intent
// ×3 / legacy-record-appliers). genesis is BACKFILL-ONLY; runtime creation writes this dedicated
// event carrying the FULL initial ArtifactRowSnapshot (full-snapshot rule: the fold cannot rebuild
// a row from an id-only event). Mirrors MistakeVariantCreateExperimental EXACTLY (critic A4): the
// reducer seeds the row from payload.row VERBATIM, then applies the caused_by chain.
//
// `.strict()` that matters is on ArtifactRowSnapshot (genesis.ts) so a wrong/sibling row shape is
// rejected. subject_id === payload.row.id is enforced by the superRefine (mirrors genesis/create
// coherence). NOTE the relationship to GenerateArtifact (known.ts): a single AI generation writes
// BOTH `generate` (intent/observability/evidence, has a `failure` branch) AND this `artifact_create`
// (fold anchor, only on a successful row landing), chained by caused_by_event_id, written same-tx
// for atomicity (design §3 #3 + driver decision §9 #5). This event does NOT absorb body_md.
export const ArtifactCreateExperimental = z
  .object({
    actor_kind: z.enum(['agent', 'user', 'system']),
    actor_ref: z.string().min(1),
    action: z.literal('experimental:artifact_create'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string().min(1), // = artifact.id (== payload.row.id)
    outcome: z.literal('success').nullable().optional(),
    payload: z
      .object({
        // FULL initial row snapshot (body_blocks / type / title / parent / knowledge_ids / tool_* /
        // status / history / timestamps). The reducer reads it VERBATIM as the row's base state —
        // same shape genesis carries.
        row: ArtifactRowSnapshot,
      })
      // `.strict()` payload wrapper (W3-C1β / CodeRabbit A1↔A2 consistency): A2's
      // QuestionBlockCreateExperimental wraps its payload in `.strict()` but A1's create did not, so
      // a writer that smuggled an extra payload key (besides `row`) would silently pass. Strict so a
      // stray key fails loud at the parseEvent barrier — the create writers emit EXACTLY `{ row }`.
      .strict(),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // subject_id must name the same row the snapshot reproduces (mirrors GenesisExperimental's
    // subject_id === row.id coherence check, so a create base seeds the row by its OWN id).
    if (data.subject_id !== data.payload.row.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'subject_id must equal payload.row.id (the create base seeds the row by its own id)',
        path: ['subject_id'],
      });
    }
  });
export type ArtifactCreateExperimentalT = z.infer<typeof ArtifactCreateExperimental>;

// ── #4 experimental:artifact_lifecycle (archive / unarchive / status / attrs transitions) ──
//
// design §3 #4 [P1]. Drives `archived_at` / `generation_status` / `verification_status` /
// `verification_summary` / `attrs` / `generated_by` / `verified_by` / `history` / `version`. F1:
// this is the event that finally makes the currently-UNTRACKED mutations fold-visible —
// note_generate's generation_status (+ verification_status='queued' + generated_by), note_verify's
// verification_status + verification_summary (+ verified_by), the retract archive (actions.ts, the
// B2/C5 cross-wave coupling), AND the two attrs mutators (W3-C1γ `set_attrs`: updateArtifactTool's
// interactive html + hub-dismiss's suppressed_block_refs). Mirrors W2's GoalStatusUpdateExperimental
// + LearningItemArchiveExperimental.
//
// W3-C1γ FULL-ROW PARITY (design §2.1 "无排除列"): the artifact snapshot has NO excluded columns, so
// a lifecycle write that ALSO touches a provenance column (note_generate → generated_by, note_verify
// → verified_by) or a history-pushing one (updateArtifactTool → history) must carry that column too,
// else the W3-C3 full-row parity false-fails it. So this payload is a SUPERSET of the design's
// narrow op fields: `attrs` (set_attrs), `generated_by`/`verified_by` (provenance alongside a status
// op), `history_after` (an attrs op that also pushes a history entry). All optional/presence-based —
// a writer carries EXACTLY the columns its UPDATE touched; the reducer applies whatever is carried.
//
// `.strict()` payload so a stray key fails loud. The superRefine enforces the op→required-field
// coupling so a `set_generation_status`/`set_verification_status`/`archive`/`unarchive`/`set_attrs`
// that forgot its mandatory target value (which the reducer would otherwise fold as `undefined`,
// corrupting the column) is rejected at the barrier (honest-reject, §10 B5). The optional provenance/
// history fields have NO required coupling — they ride alongside whichever op the writer chose.
export const ArtifactLifecycleExperimental = z
  .object({
    actor_kind: z.enum(['user', 'agent', 'system']),
    actor_ref: z.string().min(1),
    action: z.literal('experimental:artifact_lifecycle'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string().min(1), // = artifact.id
    outcome: z.literal('success').nullable().optional(),
    payload: z
      .object({
        op: z.enum([
          'archive',
          'unarchive',
          'set_generation_status',
          'set_verification_status',
          // W3-C1γ — `artifact.attrs` mutators (updateArtifactTool html / hub-dismiss suppress).
          // attrs is a fold-truth jsonb column; the reducer replaces it wholesale (last-write-wins).
          'set_attrs',
        ]),
        // archive sets a timestamp; unarchive sets null. Optional/nullable so a status-only op omits it.
        archived_at: z.coerce.date().nullable().optional(),
        // free text columns on the table (NOT pgEnums) — generation_status / verification_status.
        generation_status: z.string().optional(),
        verification_status: z.string().optional(),
        verification_summary: NoteVerificationResult.nullable().optional(),
        // W3-C1γ — the full new `attrs` jsonb (set_attrs op). Required-when-set_attrs via superRefine.
        attrs: z.record(z.string(), z.unknown()).optional(),
        // W3-C1γ — provenance columns a status write co-mutates (note_generate→generated_by,
        // note_verify→verified_by). Carried alongside the status op so full-row parity holds.
        generated_by: AgentRef.nullable().optional(),
        verified_by: AgentRef.nullable().optional(),
        // W3-C1γ — full after-history when the UPDATE pushed a history entry (updateArtifactTool).
        // Absent ⇒ the writer left `history` untouched (the reducer keeps the running value).
        history_after: z.array(ArtifactHistoryEntry).optional(),
        next_version: z.number().int().nonnegative(),
      })
      .strict(),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // op→field coupling: the status ops MUST carry their non-empty target value, else the reducer
    // would fold an `undefined` over a notNull column.
    if (
      data.payload.op === 'set_generation_status' &&
      (data.payload.generation_status === undefined || data.payload.generation_status.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "generation_status (non-empty) is required when op='set_generation_status'",
        path: ['payload', 'generation_status'],
      });
    }
    if (
      data.payload.op === 'set_verification_status' &&
      (data.payload.verification_status === undefined ||
        data.payload.verification_status.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verification_status (non-empty) is required when op='set_verification_status'",
        path: ['payload', 'verification_status'],
      });
    }
    // archive/unarchive op→field coupling (OCR major): the fold trusts archived_at as ground truth,
    // so the create barrier must reject a malformed archive (missing/null timestamp) OR an unarchive
    // that fails to explicitly null it — else the reducer folds `undefined` over the column.
    if (
      data.payload.op === 'archive' &&
      (data.payload.archived_at === undefined || data.payload.archived_at === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "archived_at (non-null Date) is required when op='archive'",
        path: ['payload', 'archived_at'],
      });
    }
    if (data.payload.op === 'unarchive' && data.payload.archived_at !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "archived_at must be explicitly null when op='unarchive'",
        path: ['payload', 'archived_at'],
      });
    }
    // W3-C1γ — set_attrs MUST carry the new `attrs` object (the fold trusts it as ground truth; a
    // set_attrs that fold an `undefined` over the notNull jsonb column would corrupt it).
    if (data.payload.op === 'set_attrs' && data.payload.attrs === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attrs (the full new attrs object) is required when op='set_attrs'",
        path: ['payload', 'attrs'],
      });
    }
  });
export type ArtifactLifecycleExperimentalT = z.infer<typeof ArtifactLifecycleExperimental>;

// ── #4b experimental:note_refine_undo (self-sufficient body RESTORE) ───────────────────────────────
//
// W3-C1γ. The live undo (undoNoteRefineApplyEvent, note-refine-apply.ts) restores a PRIOR body —
// it UPDATEs body_blocks = the apply event's `previous_body_blocks`, version = +1, updated_at = now
// (it does NOT touch `history`). The pre-existing undo event carried only bookkeeping (undone_event_id
// + version pointers), so the fold could not reproduce the restored body. This self-sufficient form
// CARRIES the restored body_blocks + next_artifact_version + after-history so foldArtifact reproduces
// the restore VERBATIM (full-snapshot rule, mirrors body_blocks_edit — NO op-replay, the restore is a
// last-write-wins body replace). Also backs ADR-0040 §1 "unified undo = the fold auto-restores".
//
// BACK-COMPAT (deliberate, ≠ A1's body_blocks_edit rename): the existing writer ALREADY emits
// `experimental:note_refine_undo`, so — unlike A1 which picked a NEW action name (body_blocks_edit)
// leaving old `artifact_body_blocks_edit` events on a DIFFERENT, unreserved action — here the action
// name is REUSED. Reserving it (below) makes the parseEvent barrier fail-loud on the ENVELOPE for
// every undo event; but `getEvents`/`getEventById` STRICT-parse historical rows on READ (queries.ts:
// 800) and would THROW on a pre-C1γ loose undo event (which lacks the fold fields) if those fields
// were required. So the three fold fields are OPTIONAL: an old loose undo event (bookkeeping only)
// STILL validates here (no read-path throw), while the migrated writer ALWAYS emits them so every NEW
// undo is self-sufficient. The reducer folds the restore ONLY when body_blocks is carried; a legacy
// undo (no body) sits on a pre-W3 artifact (no create/genesis anchor → fold-null) so skipping it is
// harmless. `.strict()` still rejects any UNDECLARED key.
export const NoteRefineUndoExperimental = z
  .object({
    actor_kind: z.enum(['user', 'agent', 'system']),
    actor_ref: z.string().min(1),
    action: z.literal('experimental:note_refine_undo'),
    subject_kind: z.literal('artifact'),
    subject_id: z.string().min(1), // = artifact.id
    outcome: z.literal('success').nullable().optional(),
    payload: z
      .object({
        // ── existing bookkeeping (kept verbatim — listNoteRefineChanges + the already-undone guard
        //    read undone_event_id off the raw payload, NOT via parseEvent). ──
        artifact_id: z.string().min(1),
        undone_event_id: z.string().min(1),
        restored_from_artifact_version: z.number().int().nonnegative(),
        restored_to_artifact_version: z.number().int().nonnegative(),
        source_previous_artifact_version: z.number().int().nullable().optional(),
        // ── W3-C1γ self-sufficient fold fields (optional for read-path back-compat; the migrated
        //    writer always emits them). ──
        // The RESTORED body (= the apply event's previous_body_blocks). nullable: an apply over a
        // null base could restore null — but the undo writer rejects a null previous_body_blocks, so
        // in practice this is a real doc.
        body_blocks: ArtifactBodyBlocks.nullable().optional(),
        // = restored_to_artifact_version (the version the undo UPDATE stamped). Folded VERBATIM.
        next_artifact_version: z.number().int().nonnegative().optional(),
        // Full after-history. The undo leaves history UNCHANGED, so this is the row's CURRENT history
        // (carried so the fold reproduces the `history` column rather than guessing).
        history_after: z.array(ArtifactHistoryEntry).optional(),
      })
      .strict(),
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // If the self-sufficient body is carried, next_artifact_version MUST accompany it (the reducer
    // needs both to reproduce the restore — a half-carried payload would fold an undefined version).
    if (
      data.payload.body_blocks !== undefined &&
      data.payload.next_artifact_version === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'next_artifact_version is required when body_blocks (the restored body) is carried',
        path: ['payload', 'next_artifact_version'],
      });
    }
    // W3-C3 FLIP-GATE HARDENING — the self-sufficiency DISCRIMINATOR. The migrated writer
    // (undoNoteRefineApplyEvent) ALWAYS emits the full triple { body_blocks, next_artifact_version,
    // history_after }; an OLD loose undo (pre-C1γ) carries NONE of them. So the presence of EITHER
    // self-sufficient marker (next_artifact_version OR history_after) DISCRIMINATES "this is a NEW
    // self-sufficient undo" — and a NEW undo MUST carry the restored body, else the reducer would fold
    // an undefined body and silently drop the restore (a fold≠row gap the C3 parity assert would only
    // catch post-hoc). Reject the non-self-sufficient NEW form at the parse barrier instead (fail-loud).
    // Old loose events (no marker) are EXEMPT, preserving the read-path back-compat the schema header
    // documents (getEvents STRICT-parses historical rows — a required body would throw on a legacy undo).
    if (
      data.payload.body_blocks === undefined &&
      (data.payload.next_artifact_version !== undefined || data.payload.history_after !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'body_blocks (the restored body) is required when next_artifact_version or history_after ' +
          'is carried — a self-sufficient undo must carry the body it restores (W3-C3 flip-gate)',
        path: ['payload', 'body_blocks'],
      });
    }
  });
export type NoteRefineUndoExperimentalT = z.infer<typeof NoteRefineUndoExperimental>;
