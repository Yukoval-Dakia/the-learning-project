import { z } from 'zod';
import {
  AgentRef,
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  NoteVerificationResult,
} from '../business';
import { FigureRef, StructuredQuestion } from '../structured_question';

// ====================================================================
// GenesisExperimental — pre-W1 row backfill seed (YUK-471 Wave 1, Codex #4)
// ====================================================================
//
// The first structural fold (PR-A1) projects `knowledge` / `knowledge_edge`
// rows from the event log. But every row that EXISTS before Wave 1 has no
// originating event — the fold would project an empty world. PR-A2's genesis
// backfill closes this gap by writing ONE system event per pre-W1 row whose
// payload is a full snapshot of that row, so `fold(genesis) == row` byte for
// byte. The node/edge reducers treat `experimental:genesis` as the seed action
// that establishes a row's initial projected state.
//
// HARD REQ 1 (mirror StateSnapshotExperimental, ./state-snapshot.ts §HARD REQ 1):
// this dedicated Zod schema is validated by writeEvent's parseEvent barrier. A
// malformed seed would silently corrupt the WHOLE projection (the fold trusts
// genesis as ground truth), so the generic ExperimentalEvent fallback REJECTS
// the reserved `experimental:genesis` action (see RESERVED_EXPERIMENTAL_ACTIONS
// in ./experimental.ts) — a malformed seed payload can never lose schema
// validation by falling through to the loose generic record.
//
// actor_kind pinned to `'system'` (mirror state-snapshot §6.3): the genesis
// seed is a system-emitted backfill row, not an agent or user action.

// ---------- KnowledgeRowSnapshot ----------
//
// The projected (fold) shape of a `knowledge` row. EXCLUDES embed_* columns
// (embedding / embed_model / embed_version / embed_content_hash) — those are
// DERIVED maintenance state (nightly embed_backfill / reparent recompute), NOT
// structural truth the fold reproduces. Every field below mirrors the column
// shape at src/db/schema.ts:54-103 (the structural subset).
//
// Dates are z.coerce.date() because the seed payload roundtrips through jsonb
// (ISO string on the way out, Date on the way back) — same precedent as
// FsrsStateSchema in ./blocks.ts:68. This schema is EXPORTED so the W1 node
// reducer imports it as the canonical projected-knowledge-row contract: genesis
// and the reducer share ONE row shape (no drift between seed and fold output).

// NON-strict, intentionally (A8 — original brief's REVERT path). This is a W1-LIVE schema with
// live-row `.parse()` callers: the proposals.db.test `liveSnapshot` helper and the projection
// parity sites parse a FULL `knowledge` DB row, which carries the DERIVED embed_* columns
// (embedding / embed_model / embed_version / embed_content_hash). Non-strict STRIPS those extras
// down to the structural subset; `.strict()` would instead throw `unrecognized_keys` and break
// those callers (proposals.db.test.ts fails). The genesis per-kind safeParse dispatch stays safe
// today WITHOUT strict here because the three entity field sets are disjoint — a wrong-entity row
// fails on missing required fields (a knowledge row lacks goal's scope_knowledge_ids / a goal row
// lacks `name`), and the B3 discriminating-column assertion is the real wrong-entity guard. Only
// add `.strict()` to a knowledge schema if a future higher-overlap sibling makes silent-stripping
// unsafe AND the live-row callers are first migrated to omit the derived columns.
export const KnowledgeRowSnapshot = z.object({
  id: z.string().min(1),
  name: z.string(),
  domain: z.string().nullable(), // nullable column
  parent_id: z.string().nullable(), // nullable column
  merged_from: z.array(z.string()), // jsonb string[], default [] at the table
  archived_at: z.coerce.date().nullable(), // nullable timestamp
  proposed_by_ai: z.boolean(),
  approval_status: z.enum(['pending', 'approved', 'rejected']),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  version: z.number().int(),
});
export type KnowledgeRowSnapshotT = z.infer<typeof KnowledgeRowSnapshot>;

// ---------- KnowledgeEdgeRowSnapshot ----------
//
// The projected (fold) shape of a `knowledge_edge` row (src/db/schema.ts:1052-1081).
// NO `version` column on this table (unlike `knowledge`). `created_by` is the
// AgentRef jsonb — kept loose here (z.record) so the seed never re-validates the
// envelope the row already persisted; the reducer treats it as opaque provenance.
// EXPORTED for the W1 edge reducer (same single-row-contract rationale as above).

// NON-strict, intentionally (A8 REVERT — same rationale as KnowledgeRowSnapshot): a W1-LIVE schema
// whose live-row `.parse()` callers must STRIP, not reject, columns absent from this structural
// subset. The disjoint-field-set + B3 discriminating-column dispatch is the wrong-entity guard.
export const KnowledgeEdgeRowSnapshot = z.object({
  id: z.string().min(1),
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: z.string(), // 5 core enum | experimental:* — Zod-validated upstream at propose time
  weight: z.number().finite(), // real, default 1 — reject NaN/Infinity (genesis is ground truth)
  created_by: z.record(z.string(), z.unknown()), // AgentRef jsonb (opaque provenance)
  reasoning: z.string().nullable(), // nullable column
  created_at: z.coerce.date(),
  archived_at: z.coerce.date().nullable(), // nullable timestamp
});
export type KnowledgeEdgeRowSnapshotT = z.infer<typeof KnowledgeEdgeRowSnapshot>;

// ---------- GoalRowSnapshot (YUK-471 Wave 2 — goal entity fold) ----------
//
// The projected (fold) shape of a `goal` row (src/db/schema.ts:1177-1206). goal has NO
// derived maintenance columns (no embed_*), so EVERY column is structural fold truth — the
// full row IS the snapshot (design §1①). `version` is carried verbatim (mirrors
// KnowledgeRowSnapshot); the goal reducer's per-event version behavior MIRRORS the historical
// imperative writes EXACTLY (insertGoal → 0, accept → no bump, retract → no bump, the
// status/scope updates → +1). See src/core/projections/goal.ts for the per-site rationale.
//
// `.strict()` (critic B3): GoalRowSnapshot and the future LearningItemRowSnapshot share many
// columns (id/title/status/source/source_ref/created_at/updated_at/version). A non-strict Zod
// object strips unknown keys, so `GoalRowSnapshot.safeParse(learningItemRow)` could FALSE-PASS
// at the genesis parse barrier. `.strict()` rejects unknown keys so a wrong-entity row can
// never seed a goal genesis. Dates are z.coerce.date() (jsonb ISO-string roundtrip — same
// precedent as KnowledgeRowSnapshot).
export const GoalRowSnapshot = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subject_id: z.string().nullable(), // nullable column (cross-subject goals)
    scope_knowledge_ids: z.array(z.string()), // jsonb string[], default [] at the table
    sequence_hint: z.number().int(), // AI-internal ordering, NOT progress (ND-4)
    status: z.enum(['active', 'dormant', 'done']),
    source: z.string(), // provenance, set-once
    source_ref: z.string().nullable(), // nullable column (the propose event id)
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    version: z.number().int(),
  })
  .strict();
export type GoalRowSnapshotT = z.infer<typeof GoalRowSnapshot>;

// ---------- MistakeVariantRowSnapshot (YUK-471 Wave 2 — mistake_variant entity fold) ----------
//
// The projected (fold) shape of a `mistake_variant` row (src/db/schema.ts:1145-1162). NO
// derived/embed columns, so EVERY column is structural fold truth (design §2①). NO `version`
// column on this table (like knowledge_edge — the row has no optimistic-concurrency counter).
//
// `cause_category` is the FOLD-BLIND field (design §2 + critic A4): variant_gen computes it at
// INSERT time (effectiveCauseForFailureAttempt) and NO downstream event carries it. The
// compensation is that BOTH base events — `experimental:genesis` (backfill) AND
// `experimental:mistake_variant_create` (runtime creation, critic A4) — snapshot the WHOLE row
// INCLUDING cause_category, so the fold reproduces it from its base. `updated_at` is event-chain
// keep-last (each accept/verify/dismiss/retract stamps it); the base seeds the initial value.
//
// `.strict()` (critic B3): mistake_variant is well-distinguished by `parent_question_id`
// (no sibling entity has it), but .strict() still rejects a wrong/extra-field payload at the
// genesis/create parse barrier so a malformed snapshot can never silently seed the projection.
// Dates are z.coerce.date() (jsonb ISO-string roundtrip — same precedent as the other snapshots).
export const MistakeVariantRowSnapshot = z
  .object({
    id: z.string().min(1),
    parent_question_id: z.string().min(1), // notNull column; the goal-distinguishing column
    variant_question_id: z.string().nullable(), // nullable until accept materializes the question
    proposal_event_id: z.string().nullable(), // nullable column (the variant_question propose id)
    status: z.enum(['draft', 'active', 'broken', 'dismissed']),
    failure_reasons: z.array(z.string()), // jsonb string[], default [] at the table
    cause_category: z.string().nullable(), // FOLD-BLIND field — carried by the base event only
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
export type MistakeVariantRowSnapshotT = z.infer<typeof MistakeVariantRowSnapshot>;

// ---------- LearningItemRowSnapshot (YUK-471 Wave 2 — learning_item entity fold) ----------
//
// The projected (fold) shape of a `learning_item` row (src/db/schema.ts:304-343). This entity
// has the MOST EXCLUDED columns of the W2 trio (design §3①). EXCLUDED from the snapshot (no
// write path / derived state the fold does NOT own):
//   - child_learning_item_ids — always [], no UPDATE path (the tree is read via
//     parent_learning_item_id, never the child array); excluded so the fold does not assert it.
//   - ai_score — no write path (read-only derived placeholder).
//   - due_at — no write path (FSRS due_at lives on material_fsrs_state, not here).
//   - reviewed_at — no write path (read path derives it from the event log).
// RETAINED but PARITY-SKIP at the imperative writers: `user_pinned` is in the snapshot (so a
// genesis seed carries its current value VERBATIM and fold(genesis)==row holds for a backfilled
// row) but NO action event drives a later change to it — the fold can only ever reproduce its
// SEED value, so a runtime toggle would (correctly) read as drift until pin is event-sourced.
// Keeping it in the snapshot (rather than excluding) means a freshly-created/backfilled row
// still parity-checks on it; the "skip" is that no W2 event mutates it.
//
// `status` is a FREE TEXT column on the table (src/server/learning-items/queries.ts:9 — NOT a
// pgEnum; values seen: pending / in_progress / done / resting / active). So the snapshot uses
// `z.string()` (NOT an enum) — a status the fold reproduces from the imperative writers
// (complete→'done', relearn→'in_progress', the INSERT default 'pending') must never fail to
// parse. archived/dismissed are NOT statuses — they are timestamp columns (archived_at /
// dismissed_at), set independently of status.
//
// Each learning_item folds INDEPENDENTLY (no cross-tree fold): child_learning_item_ids is
// excluded, so the hub does not depend on child state; parent_learning_item_id is just a
// snapshot field that the genesis carries verbatim and no event mutates.
//
// `.strict()` (critic B3): the DISCRIMINATING column vs the sibling entities is `content` +
// `knowledge_ids` (goal has scope_knowledge_ids + sequence_hint, NOT content/knowledge_ids;
// mistake_variant has parent_question_id). .strict() rejects a wrong/extra-field payload at the
// genesis parse barrier so a sibling row can never seed a learning_item genesis. Dates are
// z.coerce.date() (jsonb ISO-string roundtrip — same precedent as the other snapshots).
export const LearningItemRowSnapshot = z
  .object({
    id: z.string().min(1),
    source: z.string(), // provenance, set-once (learning_intent / ai_dream / …)
    source_ref: z.string().nullable(), // nullable column (the originating proposal/event id)
    title: z.string(),
    content: z.string(), // notNull, default '' at the table — the goal-distinguishing column
    knowledge_ids: z.array(z.string()), // jsonb string[], default [] — the goal-distinguishing column
    primary_artifact_id: z.string().nullable(), // nullable pointer (ADR-0027 — not DB-unique)
    parent_learning_item_id: z.string().nullable(), // nullable self-ref (tree parent; snapshot-only)
    status: z.string(), // FREE TEXT column (pending|in_progress|done|resting|active) — NOT an enum
    user_pinned: z.boolean(), // snapshot-RETAINED but no event drives a later change (parity-skip)
    completed_at: z.coerce.date().nullable(), // nullable timestamp (set by complete, cleared by relearn)
    dismissed_at: z.coerce.date().nullable(), // nullable timestamp (always null today; retained)
    archived_at: z.coerce.date().nullable(), // nullable timestamp (set by archive/retract)
    archived_reason: z.string().nullable(), // nullable column (archive reason)
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    version: z.number().int(),
  })
  .strict();
export type LearningItemRowSnapshotT = z.infer<typeof LearningItemRowSnapshot>;

// ---------- ArtifactRowSnapshot (YUK-471 Wave 3 — artifact entity fold) ----------
//
// The projected (fold) shape of an `artifact` row (src/db/schema.ts:422-445). artifact has NO
// derived/embed maintenance columns (unlike `knowledge`), so EVERY one of its 22 columns is
// structural fold truth — the full row IS the snapshot (design §5.1, no excluded columns).
// `body_blocks` IS the truth (full-snapshot body fold, fork #1) and `history` is part of the row
// state (append log, but the create/edit events carry the after-value via `history_after`).
//
// `.strict()` (design §5.1 + critic B3): artifact has NO live-row `.parse()` caller passing extra
// columns (no embed_* derived columns to strip — that was the KnowledgeRowSnapshot NON-strict
// reason), so .strict() is safe AND rejects a wrong/sibling row at the genesis/create parse
// barrier. The DISCRIMINATING columns vs the W2 siblings are `intent_source` + `body_blocks`
// (no goal / mistake_variant / learning_item row carries either).
//
// jsonb inner shapes: `body_blocks` / `verification_summary` / `history` / `generated_by` /
// `verified_by` reuse the canonical business schemas (they ARE the fold truth the reducer reads).
// `attrs` (open JsonObject) and `tool_state` (validated at every write point — business.ts ToolState
// barrier) are kept OPAQUE (z.record) so the seed never re-validates a blob the row already
// persisted — mirrors the KnowledgeEdgeRowSnapshot `created_by` opaque-provenance precedent.
// Dates are z.coerce.date() (jsonb ISO-string roundtrip — same precedent as the other snapshots).
export const ArtifactRowSnapshot = z
  .object({
    id: z.string().min(1),
    type: z.string(), // notNull (note / tool_quiz / …)
    title: z.string(), // notNull
    parent_artifact_id: z.string().nullable(), // nullable self-ref
    knowledge_ids: z.array(z.string()), // jsonb string[], default [] at the table
    intent_source: z.string(), // notNull — the artifact-distinguishing column
    source: z.string(), // notNull provenance
    source_ref: z.string().nullable(), // nullable column (the originating proposal/event id)
    body_blocks: ArtifactBodyBlocks.nullable(), // nullable jsonb — the artifact-distinguishing column
    attrs: z.record(z.string(), z.unknown()), // open JsonObject (notNull default {}) — opaque
    tool_kind: z.string().nullable(), // nullable column
    tool_state: z.record(z.string(), z.unknown()).nullable(), // ToolState jsonb — opaque (write-validated)
    generation_status: z.string(), // free text (notNull default 'pending') — NOT a pgEnum
    verification_status: z.string(), // free text (notNull default 'not_required') — NOT a pgEnum
    verification_summary: NoteVerificationResult.nullable(), // nullable jsonb
    generated_by: AgentRef.nullable(), // nullable AgentRef jsonb
    verified_by: AgentRef.nullable(), // nullable AgentRef jsonb
    history: z.array(ArtifactHistoryEntry), // jsonb log (notNull default [])
    archived_at: z.coerce.date().nullable(), // nullable timestamp (archive/unarchive)
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    version: z.number().int(),
  })
  .strict();
export type ArtifactRowSnapshotT = z.infer<typeof ArtifactRowSnapshot>;

// ---------- QuestionBlockRowSnapshot (YUK-471 Wave 3 — question_block entity fold) ----------
//
// The projected (fold) shape of a `question_block` row (src/db/schema.ts question_block pgTable,
// design §5.2). question_block's structural truth is the recursive `structured` StructuredQuestion
// tree + `figures` + `crop_refs` + status/merge/version — every column below mirrors the table.
//
// EXCLUDED: `extracted_prompt_md` (the LEGACY deprecated column, schema.ts — DROP deferred to Step
// 11.5). It is NOT fold truth (markdown views derive from `structured` at render time, ADR-0002),
// so the snapshot omits it. The `.strict()` + omit协调 (design §5.2): a live `question_block` DB row
// STILL carries `extracted_prompt_md`, so the W3-C3 parity helper omits that legacy column BEFORE
// `.parse()` — that way `.strict()` protects the truth at the genesis/create WRITE path (a stray
// key fails loud) while the parity比对 stays compatible (mirrors the genesis docblock guidance:
// live-row callers migrate去 the derived/legacy columns first, then `.strict()` is safe).
//
// `.strict()` (design §5.2 + critic B3): question_block is well-distinguished from the other fold
// entities by `ingestion_session_id` + `page_spans` (no sibling carries either column), and
// `.strict()` rejects a wrong/extra-field payload at the genesis/create parse barrier so a malformed
// snapshot can never silently seed the projection.
//
// jsonb inner shapes: `structured` reuses the canonical recursive StructuredQuestion schema and
// `figures` reuses FigureRef (they ARE the fold truth the reducer reads). `page_spans` is the
// extraction-coordinate envelope (page_index + bbox + optional role) — kept structured but tolerant
// (the inner bbox is the raw 4-number object the OCR persisted, NOT re-validated against the 0-1
// normalized BBox refinements, so a faithfully-backfilled row never false-rejects). Dates are
// z.coerce.date() (jsonb ISO-string roundtrip — same precedent as the other snapshots).
const PageSpan = z.object({
  page_index: z.number().int().min(0),
  bbox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  role: z.string().optional(),
});

export const QuestionBlockRowSnapshot = z
  .object({
    id: z.string().min(1),
    ingestion_session_id: z.string().min(1), // notNull — the question_block-distinguishing column
    source_document_id: z.string().nullable(), // nullable column
    source_asset_ids: z.array(z.string()), // jsonb string[], default [] at the table
    page_spans: z.array(PageSpan), // jsonb array, default [] — the question_block-distinguishing column
    structured: StructuredQuestion.nullable(), // nullable jsonb — the recursive StructuredQuestion tree
    figures: z.array(FigureRef), // jsonb FigureRef[], notNull default []
    layout_quality: z.string(), // free text (notNull default 'structured')
    reference_md: z.string().nullable(), // nullable column
    wrong_answer_md: z.string().nullable(), // nullable column
    image_refs: z.array(z.string()), // jsonb string[], notNull default []
    crop_refs: z.array(z.string()), // jsonb string[], notNull default [] — A3: own truth column (F5)
    visual_complexity: z.string(), // free text (notNull default 'low')
    extraction_confidence: z.number(), // real (notNull default 1; DB CHECK 0..1) — verbatim, no re-validate
    status: z.string(), // free text (notNull default 'draft') — 'draft' | 'ignored' | …
    knowledge_hint: z.string().nullable(), // nullable column
    merged_from_block_ids: z.array(z.string()), // jsonb string[], notNull default []
    imported_question_id: z.string().nullable(), // nullable column
    imported_attempt_event_id: z.string().nullable(), // nullable column
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    version: z.number().int(),
    // EXCLUDED: extracted_prompt_md (legacy deprecated, omitted — see docblock above).
  })
  .strict();
export type QuestionBlockRowSnapshotT = z.infer<typeof QuestionBlockRowSnapshot>;

// ---------- GenesisExperimental ----------
//
// Field-level parity with the existing reserved experimental schemas
// (UserCauseExperimental / RecordCaptureExperimental / MemoryBriefRefreshExperimental /
// StateSnapshotExperimental): actor_kind literal, action literal, subject literals,
// optional base fields. This parity is what lets parseEvent route to this branch
// deterministically and reject malformed payloads instead of falling through to
// the loose generic.
//
// `subject_kind` is the row's table; `subject_id` is the row id. `payload.row`
// is the snapshot, a PLAIN `z.union` of the row shapes (NOT a discriminated
// union — the row shapes share no literal discriminant). The subject_kind ↔
// row-shape coherence is enforced POST-PARSE by the superRefine cross-check
// below, so a wrong snapshot shape under a given subject_kind still fails at the
// schema boundary.
//
// PER-KIND DISPATCH (YUK-471 Wave 2, critic B3 — REFACTOR from field-sniffing):
// W1 had only two members and distinguished the edge by `'from_knowledge_id' in row`
// (field-sniffing). Wave 2 grows the union (goal joins, mistake_variant + learning_item
// follow) with HIGH field overlap (goal + the future learning_item both have
// id/title/status/source/source_ref/created_at/updated_at/version). Field-sniffing cannot
// safely tell them apart, so the superRefine now does an EXPLICIT per-subject_kind
// `SpecificSnapshot.safeParse(row)`. GoalRowSnapshot is `.strict()` (new entity, no live-row
// `.parse()` caller passing extra columns); KnowledgeRowSnapshot / KnowledgeEdgeRowSnapshot are
// intentionally NON-strict (W1-LIVE schemas whose live-row callers strip derived embed_* columns —
// see their docblocks). The dispatch stays safe because the three entity field sets are DISJOINT
// (a wrong-entity row fails on a missing required field), reinforced by the
// discriminating-column assertion below (a goal row MUST carry the goal-specific
// `scope_knowledge_ids` + `sequence_hint` columns) so a sibling-entity row that happens to be
// shape-compatible can never false-pass. subject_id === row.id is preserved. The
// `SNAPSHOT_BY_SUBJECT_KIND` map + `DISCRIMINATING_COLUMNS` are the shared extension point:
// mistake_variant + learning_item lanes add their entry here.

// Per-subject_kind canonical snapshot schema. The superRefine safeParses payload.row against
// the schema for the declared subject_kind — a mismatch (wrong shape under a subject_kind, or
// an unknown key a .strict() schema rejects) fails the parse barrier.
const SNAPSHOT_BY_SUBJECT_KIND = {
  knowledge: KnowledgeRowSnapshot,
  knowledge_edge: KnowledgeEdgeRowSnapshot,
  goal: GoalRowSnapshot,
  mistake_variant: MistakeVariantRowSnapshot,
  learning_item: LearningItemRowSnapshot,
  artifact: ArtifactRowSnapshot,
  question_block: QuestionBlockRowSnapshot,
} as const;

// Columns that MUST be present on a row to discriminate it as the named entity, even after a
// shape-compatible safeParse. A sibling row could be GoalRowSnapshot-compatible after
// `.strict()` only if it carried EXACTLY goal's columns — these are the goal-only columns, so
// requiring them closes any residual overlap window (critic B3).
const DISCRIMINATING_COLUMNS: Record<string, readonly string[]> = {
  goal: ['scope_knowledge_ids', 'sequence_hint'],
  // mistake_variant is uniquely identified by parent_question_id (no sibling entity carries it),
  // so requiring it closes any residual shape-overlap window (critic B3).
  mistake_variant: ['parent_question_id'],
  // learning_item shares title/status/source/source_ref/version with goal, so the goal-LACKING
  // columns `content` + `knowledge_ids` discriminate it (goal has scope_knowledge_ids +
  // sequence_hint, NOT content/knowledge_ids). Requiring both closes any residual overlap window.
  learning_item: ['content', 'knowledge_ids'],
  // artifact is uniquely identified by `intent_source` + `body_blocks` (no W2 sibling entity
  // carries either column), so requiring them closes any residual shape-overlap window (design §5.1).
  artifact: ['intent_source', 'body_blocks'],
  // question_block is uniquely identified by `ingestion_session_id` + `page_spans` (no other fold
  // entity carries either column), so requiring them closes any residual shape-overlap window
  // (design §5.2). Both are notNull on the table, so the key is always present on a faithful row.
  question_block: ['ingestion_session_id', 'page_spans'],
};

export const GenesisExperimental = z
  .object({
    actor_kind: z.literal('system'), // backfill is an internal seed writer
    actor_ref: z.string().min(1), // e.g. 'genesis-backfill'
    action: z.literal('experimental:genesis'),
    subject_kind: z.enum([
      'knowledge',
      'knowledge_edge',
      'goal',
      'mistake_variant',
      'learning_item',
      'artifact',
      'question_block',
    ]),
    subject_id: z.string().min(1), // = the projected row id
    outcome: z.literal('success').nullable().optional(),
    payload: z.object({
      // PLAIN union of the row shapes (NOT discriminated — they share no literal
      // discriminant). The cross-check (payload.row shape matches subject_kind via
      // per-kind safeParse, and subject_id === row.id) is enforced post-parse by the
      // superRefine below so fold(genesis) == row holds.
      row: z.union([
        KnowledgeRowSnapshot,
        KnowledgeEdgeRowSnapshot,
        GoalRowSnapshot,
        MistakeVariantRowSnapshot,
        LearningItemRowSnapshot,
        ArtifactRowSnapshot,
        QuestionBlockRowSnapshot,
      ]),
    }),
    // baseOptionalFields parity (mirror the other reserved schemas):
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // The payload.row was parsed by the union, so `data.payload.row` is one of the snapshot
    // shapes — but the union does NOT enforce it matches `subject_kind`. Re-validate the row
    // against the schema for the DECLARED subject_kind (per-kind safeParse, critic B3) so a
    // subject_kind/row mismatch is rejected at the schema boundary.
    const row = data.payload.row as Record<string, unknown>;
    const schema = SNAPSHOT_BY_SUBJECT_KIND[data.subject_kind];
    const reparsed = schema.safeParse(row);
    if (!reparsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payload.row must be a ${data.subject_kind} row when subject_kind='${data.subject_kind}'`,
        path: ['payload', 'row'],
      });
    }
    // Discriminating-column assertion: even a shape-compatible row must carry the entity's
    // distinguishing columns so a sibling entity cannot false-pass.
    for (const col of DISCRIMINATING_COLUMNS[data.subject_kind] ?? []) {
      if (!(col in row)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `payload.row for subject_kind='${data.subject_kind}' must carry the discriminating column '${col}'`,
          path: ['payload', 'row', col],
        });
      }
    }
    if (data.subject_id !== row.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subject_id must equal payload.row.id (fold seeds the row by its own id)',
        path: ['subject_id'],
      });
    }
  });
export type GenesisExperimentalT = z.infer<typeof GenesisExperimental>;
