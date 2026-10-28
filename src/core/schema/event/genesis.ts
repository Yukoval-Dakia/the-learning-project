import { z } from 'zod';
import {
  AgentRef,
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  DeclaredStage,
  NoteVerificationResult,
} from '../business';
import { QuestionDraftDocument } from '../question-draft';
import { FigureRef, StructuredQuestion } from '../structured_question';

// Genesis backfill seed. Rows that existed before the projection's event log have
// no originating event, so backfill writes ONE system event per row whose payload is
// a full snapshot; the fold treats `experimental:genesis` as the seed that
// establishes the row's initial state, and `fold(genesis) == row` byte for byte.
//
// writeEvent's parseEvent barrier validates this dedicated schema. A malformed seed
// would corrupt the whole projection, so the generic event fallback rejects the
// reserved action (RESERVED_EXPERIMENTAL_ACTIONS) instead of accepting it loosely.
//
// actor_kind is pinned to 'system': the seed is a backfill row, not a user action.

// ---------- KnowledgeRowSnapshot ----------
//
// The projected (fold) shape of a `knowledge` row. EXCLUDES embed_* columns: those
// are derived maintenance state, not structural truth the fold reproduces. Dates are
// z.coerce.date() because the payload roundtrips through jsonb. Genesis and the node
// reducer share this one row shape so seed and fold cannot drift.

// NON-strict intentionally: live-row `.parse()` callers pass full `knowledge` rows
// carrying the derived embed_* columns, which this structural subset must strip, not
// reject. Wrong-entity dispatch is safe because the entity field sets are disjoint
// and the per-kind check asserts discriminating columns.
export const KnowledgeRowSnapshot = z.object({
  id: z.string().min(1),
  name: z.string(),
  domain: z.string().nullable(), // nullable column
  parent_id: z.string().nullable(), // nullable column
  merged_from: z.array(z.string()), // jsonb string[], default [] at the table
  archived_at: z.coerce.date().nullable(), // nullable timestamp
  proposed_by_ai: z.boolean(),
  approval_status: z.enum(['pending', 'approved', 'rejected']),
  // OPTIONAL for the same legacy-payload reason as GoalRowSnapshot.scope_mode (YUK-603
  // precedent): genesis payloads written before the column existed carry no role, and the
  // fold defaults 'kc' (mirrors the DB column default). Backfilled nodes get their role
  // from experimental:knowledge_role_update, never from a rewritten genesis.
  role: z.enum(['kc', 'goal', 'container']).optional(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  version: z.number().int(),
});
export type KnowledgeRowSnapshotT = z.infer<typeof KnowledgeRowSnapshot>;

// ---------- KnowledgeEdgeRowSnapshot ----------
//
// Projected shape of a `knowledge_edge` row. No `version` column. `created_by` is
// the AgentRef jsonb, kept loose because the reducer treats provenance as opaque.

// NON-strict for the same reason as KnowledgeRowSnapshot: live-row callers must
// strip, not reject, columns outside this structural subset.
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

// ---------- GoalRowSnapshot ----------
//
// Projected shape of a `goal` row. goal has no derived maintenance columns, so every
// column is fold truth and the full row IS the snapshot. `version` is carried
// verbatim; the reducer mirrors the imperative writes exactly (insert 0, accept and
// retract no bump, status/scope updates +1).
//
// `.strict()`: goal shares many columns with learning_item, and a non-strict object
// would strip unknown keys, letting a learning_item row false-pass the genesis parse
// barrier.
export const GoalRowSnapshot = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    subject_id: z.string().nullable(), // nullable column (cross-subject goals)
    scope_knowledge_ids: z.array(z.string()), // jsonb string[], default [] at the table
    // OPTIONAL: `.strict()` makes every key mandatory-by-presence, so a required new
    // key would reject historical genesis payloads written before the column existed.
    // Absent ⇒ the fold defaults 'explicit' (mirrors the DB column default).
    scope_mode: z.enum(['explicit', 'subject_live']).optional(),
    sequence_hint: z.number().int(), // AI-internal ordering, NOT progress
    // OPTIONAL+nullable for the same legacy-payload reason as scope_mode: absent ⇒
    // the fold materializes NULL. Curriculum constraint only, never θ̂ input.
    declared_stage: DeclaredStage.nullable().optional(),
    status: z.enum(['active', 'dormant', 'done']),
    source: z.string(), // provenance, set-once
    source_ref: z.string().nullable(), // nullable column (the propose event id)
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
    version: z.number().int(),
  })
  .strict();
export type GoalRowSnapshotT = z.infer<typeof GoalRowSnapshot>;

// ---------- MistakeVariantRowSnapshot ----------
//
// Projected shape of a `mistake_variant` row. No derived/embed columns and no
// `version` column. `cause_category` is fold-blind: variant_gen computes it at INSERT
// time and no downstream event carries it, so both base events (genesis and
// mistake_variant_create) snapshot the whole row. `updated_at` is event-chain
// keep-last.
//
// `.strict()` rejects a wrong or extra-field payload at the parse barrier.
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

// ---------- LearningItemRowSnapshot ----------
//
// Projected shape of a `learning_item` row. EXCLUDED (no write path / not fold truth):
// child_learning_item_ids (the tree is read via parent_learning_item_id), ai_score,
// due_at (FSRS state lives elsewhere), reviewed_at (derived from the log). `user_pinned`
// is retained so a seed carries its current value, but no action event mutates it yet,
// so later toggles read as drift until pin is event-sourced.
//
// `status` is free text on the table (not a pgEnum), so it stays z.string(): a status
// the fold reproduces must never fail to parse. archived/dismissed are timestamp
// columns, not statuses.
//
// `.strict()`: `content` + `knowledge_ids` discriminate learning_item from goal, so a
// sibling row cannot seed a learning_item genesis.
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

// ---------- ArtifactRowSnapshot ----------
//
// Projected shape of an `artifact` row. No derived columns, so the full row IS the
// snapshot. `body_blocks` is truth and `history` is row state (create/edit events
// carry the after-value via history_after).
//
// `.strict()` is safe because no live-row caller passes extra columns; it rejects a
// sibling row at the barrier. `intent_source` + `body_blocks` discriminate it.
//
// jsonb inner shapes reuse the canonical business schemas. attrs and tool_state stay
// opaque records because the row already validated them at write time. Dates are
// z.coerce.date() for the jsonb roundtrip.
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

// ---------- QuestionBlockRowSnapshot ----------
//
// Projected shape of a `question_block` row: the recursive `structured` tree plus
// figures, crop refs, status/merge/version.
//
// EXCLUDED: `extracted_prompt_md` — a legacy column, not fold truth (markdown views
// derive from `structured`). The parity helper omits it before `.parse()` so
// `.strict()` still protects the write path while live rows stay compatible.
//
// `.strict()`: `ingestion_session_id` + `page_spans` discriminate question_block.
// `structured`/`figures` reuse canonical schemas; page_spans keeps the raw 4-number
// bbox tolerant so a faithful backfill never false-rejects.
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
    // nullable jsonb — legacy StructuredQuestion tree 或 YUK-1468 v2 草稿文档
    structured: z.union([StructuredQuestion, QuestionDraftDocument]).nullable(),
    figures: z.array(FigureRef), // jsonb FigureRef[], notNull default []
    layout_quality: z.string(), // free text (notNull default 'structured')
    reference_md: z.string().nullable(), // nullable column
    wrong_answer_md: z.string().nullable(), // nullable column
    image_refs: z.array(z.string()), // jsonb string[], notNull default []
    crop_refs: z.array(z.string()), // jsonb string[], notNull default [] — A3: own truth column (F5)
    visual_complexity: z.string(), // free text (notNull default 'low')
    // real (notNull default 1). Mirrors the DB CHECK `question_block_extraction_confidence_range`
    // (BETWEEN 0 AND 1): a faithful backfilled row always satisfies it, so the bound never
    // false-rejects — it only rejects a writer bug at the genesis/create barrier (§10 B5).
    extraction_confidence: z.number().min(0).max(1),
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

// ---------- ItemCalibrationRowSnapshot ----------
//
// Projected shape of an `item_calibration` row. The table is backfilled, not
// event-sourced: rows are born from direct `applyItemPrior` INSERTs and recalibration
// UPDATEs, so the only event the fold sees is the genesis anchor (payload.row = the
// row's current values). The fold is anchor-only and carries every column verbatim.
//
// Post-anchor imperative writes are invisible to the log, so audit:projection reports
// the row as drift until it is re-anchored. That is the honest event=truth signal,
// not a false positive.
//
// `.strict()` rejects a wrong or extra-field payload; cdm_json / kt_json stay opaque.
export const ItemCalibrationRowSnapshot = z
  .object({
    id: z.string().min(1),
    question_id: z.string().min(1), // notNull; UNIQUE (item_calibration_question_unique) — the entity-distinguishing column
    b: z.number().nullable(), // hard-track IRT difficulty (logit scale), nullable column
    confidence: z.number().min(0).max(1).nullable(), // calibration confidence 0-1, nullable column
    track: z.string(), // 'hard' | 'soft' — free-text column (notNull default 'hard'), NOT a pgEnum
    source: z.string(), // provenance ('llm_prior' | 'fixed_anchor' | …), notNull set-once
    b_anchor: z.number().nullable(), // cold-start anchor b, nullable column
    b_calib: z.number().nullable(), // retired archival column (no longer in the effectiveB chain)
    calibration_n: z.number().int().min(0), // evidence folded into b_post
    calibration_weight: z.number().nullable(), // posterior precision = 1/posterior_variance
    last_calibrated_at: z.coerce.date().nullable(), // nullable timestamp
    // OPTIONAL so historical genesis anchors written before these columns existed
    // still parse at the reducer barrier. New anchors carry them; post-anchor batch
    // writes are the documented drift boundary above.
    b_post: z.number().nullable().optional(), // posterior mean (0 evidence ⇒ = b_anchor)
    posterior_variance: z.number().nullable().optional(), // posterior variance (≤ τ²)
    calibration_source: z.string().nullable().optional(), // 'prior' | 'joint' | 'legacy_calib'
    irt_a: z.number().nullable(), // soft placeholder (structurally unidentifiable)
    irt_c: z.number().nullable(), // soft placeholder
    cdm_json: z.record(z.string(), z.unknown()).nullable(), // soft placeholder jsonb — opaque
    kt_json: z.record(z.string(), z.unknown()).nullable(), // BKT forward sink jsonb — opaque
    created_at: z.coerce.date(),
    updated_at: z.coerce.date(),
  })
  .strict();
export type ItemCalibrationRowSnapshotT = z.infer<typeof ItemCalibrationRowSnapshot>;

// ---------- GenesisExperimental ----------
//
// Field-level parity with the other reserved experimental schemas lets parseEvent
// route to this branch deterministically.
//
// `subject_kind` is the row's table; `subject_id` is the row id. `payload.row` is a
// plain union of the row shapes (they share no literal discriminant). The superRefine
// below enforces subject_kind ↔ row-shape coherence and subject_id === row.id.
//
// Field-sniffing cannot distinguish overlapping entities (goal and learning_item
// share id/title/status/source/...), so the superRefine safeParses per subject_kind
// and asserts discriminating columns. Add new fold entities to
// SNAPSHOT_BY_SUBJECT_KIND + DISCRIMINATING_COLUMNS.
// Per-subject_kind canonical snapshot schema. The superRefine safeParses payload.row
// against the schema for the declared subject_kind; a mismatch (wrong shape or an
// unknown key a .strict() schema rejects) fails the parse barrier.
const SNAPSHOT_BY_SUBJECT_KIND = {
  knowledge: KnowledgeRowSnapshot,
  knowledge_edge: KnowledgeEdgeRowSnapshot,
  goal: GoalRowSnapshot,
  mistake_variant: MistakeVariantRowSnapshot,
  learning_item: LearningItemRowSnapshot,
  artifact: ArtifactRowSnapshot,
  question_block: QuestionBlockRowSnapshot,
  item_calibration: ItemCalibrationRowSnapshot,
} as const;

// Columns that MUST be present to discriminate the row as the named entity even after a
// shape-compatible safeParse; this closes any residual overlap between sibling shapes.
const DISCRIMINATING_COLUMNS: Record<string, readonly string[]> = {
  goal: ['scope_knowledge_ids', 'sequence_hint'],
  // mistake_variant is the only entity carrying parent_question_id.
  mistake_variant: ['parent_question_id'],
  // learning_item shares title/status/source with goal, so the goal-lacking columns
  // content + knowledge_ids discriminate it.
  learning_item: ['content', 'knowledge_ids'],
  // artifact is the only entity carrying intent_source + body_blocks.
  artifact: ['intent_source', 'body_blocks'],
  // question_block is the only entity carrying ingestion_session_id + page_spans; both
  // are notNull, so a faithful row always has them.
  question_block: ['ingestion_session_id', 'page_spans'],
  // item_calibration is the only entity carrying question_id + track; both are notNull.
  item_calibration: ['question_id', 'track'],
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
      'item_calibration',
    ]),
    subject_id: z.string().min(1), // = the projected row id
    outcome: z.literal('success').nullable().optional(),
    payload: z.object({
      // Plain union (the row shapes share no literal discriminant). The superRefine
      // below enforces that the shape matches subject_kind and subject_id === row.id,
      // so fold(genesis) == row holds.
      row: z.union([
        KnowledgeRowSnapshot,
        KnowledgeEdgeRowSnapshot,
        GoalRowSnapshot,
        MistakeVariantRowSnapshot,
        LearningItemRowSnapshot,
        ArtifactRowSnapshot,
        QuestionBlockRowSnapshot,
        ItemCalibrationRowSnapshot,
      ]),
    }),
    // baseOptionalFields parity (mirror the other reserved schemas):
    caused_by_event_id: z.string().optional(),
    task_run_id: z.string().optional(),
    cost_micro_usd: z.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    // The union does not enforce that the row matches subject_kind. Re-validate against
    // the schema for the declared kind so a mismatch is rejected at the boundary.
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
