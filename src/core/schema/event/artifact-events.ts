import { z } from 'zod';
import { ArtifactBodyBlocks, ArtifactHistoryEntry, NoteVerificationResult } from '../business';
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
    payload: z.object({
      // FULL initial row snapshot (body_blocks / type / title / parent / knowledge_ids / tool_* /
      // status / history / timestamps). The reducer reads it VERBATIM as the row's base state —
      // same shape genesis carries.
      row: ArtifactRowSnapshot,
    }),
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

// ── #4 experimental:artifact_lifecycle (archive / unarchive / status transitions) ──
//
// design §3 #4 [P1]. Drives `archived_at` / `generation_status` / `verification_status` /
// `verification_summary` / `version`. F1: this is the event that finally makes the currently-
// UNTRACKED mutations fold-visible — note_generate's generation_status='ready'/'failed'
// (note_generate.ts:209/241), note_verify's verification_status + verification_summary
// (note_verify.ts:161/339), and the retract archive (actions.ts:1275, the B2/C5 cross-wave
// coupling). Mirrors W2's GoalStatusUpdateExperimental + LearningItemArchiveExperimental.
//
// `.strict()` payload so a stray key fails loud. The superRefine enforces the op→field coupling so
// a `set_generation_status` that forgot to carry the new status (which the reducer would otherwise
// fold as `undefined`, corrupting the column) is rejected at the barrier (honest-reject, §10 B5).
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
        op: z.enum(['archive', 'unarchive', 'set_generation_status', 'set_verification_status']),
        // archive sets a timestamp; unarchive sets null. Optional/nullable so a status-only op omits it.
        archived_at: z.coerce.date().nullable().optional(),
        // free text columns on the table (NOT pgEnums) — generation_status / verification_status.
        generation_status: z.string().optional(),
        verification_status: z.string().optional(),
        verification_summary: NoteVerificationResult.nullable().optional(),
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
  });
export type ArtifactLifecycleExperimentalT = z.infer<typeof ArtifactLifecycleExperimental>;
