import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type {
  AgentRef,
  ArtifactBodyBlocks,
  ArtifactHistoryEntry,
  FsrsState,
  NoteVerificationResult,
  Provenance,
  Rubric,
  ToolState,
} from '../core/schema/business';
import type { FigureRefT, StructuredQuestionT } from '../core/schema/structured_question';
// A4 (YUK-436) — persisted shadow shape for mastery_state.theta_grid_json (type-only,
// erased at compile; the actual grid math lives in src/core/theta-grid.ts).
import type { ThetaGridPosterior as ThetaGridPosteriorJson } from '../core/theta-grid';
import type { SerializedQueuedPatch } from '../server/artifacts/presence/types';
import { vector } from './vector';

// Drizzle schema (Postgres) — single source of truth.
// Per architecture-review.md § Stack Pivot: Postgres types throughout;
// json columns are jsonb; booleans + timestamps native.
//
// JSON column types come from src/core/schema/business.ts. Importing the
// inferred types (not the schemas) keeps this module zod-free at runtime;
// generated.ts wraps these tables with drizzle-zod for validation.

type AgentRefT = z.infer<typeof AgentRef>;
type ArtifactBodyBlocksT = z.infer<typeof ArtifactBodyBlocks>;
type ArtifactHistoryEntryT = z.infer<typeof ArtifactHistoryEntry>;
type FsrsStateT = z.infer<typeof FsrsState>;
type NoteVerificationResultT = z.infer<typeof NoteVerificationResult>;
type ProvenanceT = z.infer<typeof Provenance>;
type RubricT = z.infer<typeof Rubric>;
type ToolStateT = z.infer<typeof ToolState>;

type JsonObject = Record<string, unknown>;

// Phase 1c.1 Step 1.2 (Lane A): DROPped base_mastery / ai_delta_mastery / last_active_at
// per ADR-0012 — mastery is now a derived PG view (knowledge_mastery, declared below).
export const knowledge = pgTable('knowledge', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain'),
  parent_id: text('parent_id'),
  merged_from: jsonb('merged_from').$type<string[]>().notNull().default([]),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  proposed_by_ai: boolean('proposed_by_ai').notNull().default(false),
  // RESERVED-FOR-FUTURE (YUK-422 — owner decided to document, not drop). This enum
  // is INERT today: every row is auto-approved and NOTHING reads it.
  //   (a) Only 'approved' has a write path — all 6 writers hardcode it (seed.ts,
  //       knowledge/proposals.ts ×2, orchestrator/learning_intent.ts ×2,
  //       scripts/seed-synthetic.ts) and the column + KnowledgeInsert both default
  //       to 'approved'. 'pending' / 'rejected' have NO writer and are unreachable
  //       by design — they are reserved for an unbuilt AI-review/approval flow where
  //       AI-proposed knowledge would land as 'pending' → be reviewed → become
  //       'approved' or 'rejected', and reads would then filter to approved-only.
  //   (b) There are ZERO readers today: no query filters on this column and nothing
  //       gates behaviour on it, so the per-enum-value reachability gap is intentional
  //       (column-level audit:schema passes via the 'approved' write; there is no
  //       per-enum-value audit). Revisit when the AI-review flow lands.
  //   (c) Tracked in docs/design/2026-05-15-data-assumptions.md (appendix
  //       'knowledge.approval_status' + §6.5 R2).
  approval_status: text('approval_status', {
    enum: ['pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('approved'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
  // YUK-383 Phase 0 — semantic retrieval substrate. Nullable: NULL is the default
  // for every existing/new row; the only write path is the idempotent nightly
  // embed_backfill job (UPDATE ... SET embedding/embed_model/embed_version WHERE
  // embedding IS NULL). dims=1024 MUST match EMBED_DIMS (src/server/ai/embed.ts).
  // embed_version bump triggers a background re-embed. Transparent to all current
  // reads (zero behaviour change). See plan 2026-06-16-phase0-retrieval-substrate.
  embedding: vector(1024),
  embed_model: text('embed_model'),
  embed_version: integer('embed_version'),
  // YUK-393 — re-embed-on-change freshness. sha256 of the embed-source text
  // (knowledgeEmbedText, which now folds EFFECTIVE-DOMAIN — see src/server/ai/
  // embed-source.ts). Nullable: existing non-NULL-embedding rows get a NULL hash
  // at migration time and recompute it on the next reparent (the only KC content
  // mutation). Write paths: embed_backfill stamps it at fill time; applyReparent
  // recomputes it on a cross-domain move and NULLs `embedding` when it differs
  // (next backfill re-embeds). Compared (not read for behaviour) — staleness is
  // detected by hash mismatch, never by reading the column value directly.
  embed_content_hash: text('embed_content_hash'),
});

// YUK-454 increment-1 (ADR-0036 身份层) — misconception identity-table skeleton.
// DORMANT in L1: no writer, NO route/job/copilotTool/manifest wiring. The write
// path is gated behind the ADR-0034 consistency gate (promotion flow). Mirrors
// the `knowledge` node conventions above (id/created_at/updated_at/archived_at/
// proposed_by_ai), with these deliberate RED LINES:
//   - ADR-0035 SOFT track: NO theta_*/b/p(L)/mastery/FSRS/difficulty columns
//     ever live here. `weight` is a CONFIDENCE-only salience signal, NOT mastery.
//   - subject=view: NO subject/domain column (subject is derived, never stored).
//   - archived_at is the ONLY time dimension — explicitly NO valid_at/invalid_at
//     (bi-temporal edges are the DEFERRED misconception_edge slice).
//   - created_at/updated_at are caller-supplied (NO defaultNow, house convention).
//   - the embedding triplet is OMITTED in L1 — it lands with the promotion-flow
//     dedup (semantic near-dup detection) when that slice ships.
export const misconception = pgTable('misconception', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  reasoning: text('reasoning'),
  weight: real('weight').default(1),
  created_by: jsonb('created_by').$type<AgentRefT>().notNull(),
  proposed_by_ai: boolean('proposed_by_ai').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  archived_at: timestamp('archived_at', { withTimezone: true }),
});

export const source_asset = pgTable('source_asset', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  storage_key: text('storage_key').notNull(),
  mime_type: text('mime_type').notNull(),
  byte_size: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  provenance: jsonb('provenance').$type<ProvenanceT>().notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const source_document = pgTable('source_document', {
  id: text('id').primaryKey(),
  title: text('title'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  body_md: text('body_md'),
  provenance: jsonb('provenance').$type<ProvenanceT>().notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

// Phase 1c.1 Step 9.J — `ingestion_session` table DROPped. Sessions now live
// in `learning_session(type='ingestion')` (ADR-0008). The `question_block.
// ingestion_session_id` text column is preserved (no FK enforced; points at
// learning_session.id post-migration).

export const question_block = pgTable(
  'question_block',
  {
    id: text('id').primaryKey(),
    ingestion_session_id: text('ingestion_session_id').notNull(),
    source_document_id: text('source_document_id'),
    source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
    page_spans: jsonb('page_spans')
      .$type<
        Array<{
          page_index: number;
          bbox: { x: number; y: number; width: number; height: number };
          role?: string;
        }>
      >()
      .notNull()
      .default([]),
    // 2026-05-14: deviation from plan Step 0.4 —— plan 原文要求 DROP COLUMN，但
    // 当前 cascade.ts / ingestion route / import route 仍写此列，若现在 DROP 则
    // typecheck + 测试在 Step 1-10 之间全断。改为 nullable（行为：新代码不写、
    // 老代码继续写），DROP 推迟到 Step 11.5 legacy route 迁完之后。
    extracted_prompt_md: text('extracted_prompt_md'),
    // structured 是 Tencent Mark Agent 返回的递归 StructuredQuestion 树
    structured: jsonb('structured').$type<StructuredQuestionT>(),
    // figures: 题目附带的图（FigureRef[]）
    figures: jsonb('figures').$type<FigureRefT[]>().notNull().default([]),
    layout_quality: text('layout_quality').notNull().default('structured'),
    reference_md: text('reference_md'),
    wrong_answer_md: text('wrong_answer_md'),
    image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
    crop_refs: jsonb('crop_refs').$type<string[]>().notNull().default([]),
    visual_complexity: text('visual_complexity').notNull().default('low'),
    extraction_confidence: real('extraction_confidence').notNull().default(1),
    status: text('status').notNull().default('draft'),
    knowledge_hint: text('knowledge_hint'),
    merged_from_block_ids: jsonb('merged_from_block_ids').$type<string[]>().notNull().default([]),
    imported_question_id: text('imported_question_id'),
    imported_attempt_event_id: text('imported_attempt_event_id'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    check(
      'question_block_extraction_confidence_range',
      sql`${t.extraction_confidence} BETWEEN 0 AND 1`,
    ),
  ],
);

export const question = pgTable(
  'question',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    prompt_md: text('prompt_md').notNull(),
    reference_md: text('reference_md'),
    rubric_json: jsonb('rubric_json').$type<RubricT>(),
    choices_md: jsonb('choices_md').$type<string[]>(),
    judge_kind_override: text('judge_kind_override'),
    // YUK-390 kind Step 3 — answer-class VERIFICATION axis (4 值 exact/keyword/
    // semantic/steps), materialized by `deriveAnswerClass` (core/schema/answer-class.ts)
    // for retrieval filtering + the kind two-axis reshape. DISTINCT from
    // judge_kind_override (the 8-value dispatch ROUTE override) — this column never
    // feeds route-resolve, so judge routing (+ profile-aware unit_dimension/
    // multimodal_direct) is unchanged (A5-safe). Write path: answer_class_backfill
    // job (NULL-only, idempotent). On-write@insert + re-derive@edit are a deferred
    // follow-up (deriveAnswerClass is pure+cheap; see job SCOPE comment).
    answer_class: text('answer_class'),
    visual_complexity: text('visual_complexity'),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    difficulty: integer('difficulty').notNull().default(3),
    source: text('source').notNull(),
    source_ref: text('source_ref'),
    draft_status: text('draft_status'),
    variant_depth: integer('variant_depth').notNull().default(0),
    root_question_id: text('root_question_id'),
    parent_variant_id: text('parent_variant_id'),
    // T-QP (YUK-165, ADR-0014 §1) — `question_part` composition axis. A part is a
    // `question` row tagged `kind='question_part'` and linked to its parent here
    // (mirrors the variant parent-ref precedent above; new axis = composition, not
    // variant lineage). Nullable: NULL on a plain/root question, set only on parts.
    // `part_index` orders parts within a parent. Written by the part-creation owner
    // `src/server/questions/parts.ts` (createQuestionPart). Because a part IS a
    // question, it gets FSRS state + flows through the existing fsrs_question
    // due/review path unchanged — independent scheduling falls out of independent
    // question rows. Parent-level aggregation scheduling is DEFERRED (ADR-0014 line
    // 250). See docs/superpowers/plans/2026-05-30-yuk165-question-part-lane.md.
    parent_question_id: text('parent_question_id'),
    part_index: integer('part_index'),
    created_by: jsonb('created_by').$type<AgentRefT>(),
    metadata: jsonb('metadata').$type<JsonObject>(),
    // M-1 (2026-05-21): first-class multimodal carriers.
    // `metadata.prompt_image_refs` is the legacy simple-image-ref path (still
    // written by ingestion for backwards-compatible readers; new code SHOULD
    // read from `image_refs` instead). See docs/superpowers/specs/2026-05-21-
    // math-mvp-vision-design.md §4 + docs/adr/0002 revision 2026-05-21.
    figures: jsonb('figures').$type<FigureRefT[]>().notNull().default([]),
    image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
    // `structured` is the recursive StructuredQuestion tree (stem/sub/standalone);
    // nullable for non-structured questions (variant_gen / embedded_check / etc).
    structured: jsonb('structured').$type<StructuredQuestionT | null>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
    // YUK-383 Phase 0 — semantic retrieval substrate. Nullable: NULL default for
    // every existing/new row; only write path is the idempotent nightly
    // embed_backfill job (UPDATE ... WHERE embedding IS NULL). dims=1024 MUST match
    // EMBED_DIMS (src/server/ai/embed.ts). Transparent to all current reads (zero
    // behaviour change). See plan 2026-06-16-phase0-retrieval-substrate.
    embedding: vector(1024),
    embed_model: text('embed_model'),
    embed_version: integer('embed_version'),
    // YUK-393 — re-embed-on-change freshness. sha256 of questionEmbedText
    // (prompt_md/reference_md/choices_md join). OD-2=a: question embed text does
    // NOT fold effective-domain — only the content-hash column is added here.
    // Nullable: existing non-NULL-embedding rows get a NULL hash at migration time
    // and recompute it on the next edit. Write paths: embed_backfill stamps it at
    // fill time; editQuestion (src/server/questions/write.ts) recomputes it when
    // prompt_md/reference_md/choices_md change and NULLs `embedding` on mismatch
    // (next backfill re-embeds). Compared, never read for behaviour.
    embed_content_hash: text('embed_content_hash'),
  },
  (t) => [
    check('question_difficulty_range', sql`${t.difficulty} BETWEEN 1 AND 5`),
    // YUK-383 Phase 0 — GIN index on the knowledge_ids JSONB array to accelerate
    // KC-containment lookups (which questions carry a given KC), consumed by the
    // Phase 1 matcher. knowledge_ids is jsonb (NOT text[]), so this uses the
    // jsonb_path_ops operator class — same precedent as event_payload_idx
    // (drizzle/0005), NOT event_affected_scopes_idx (that index is on a native
    // text[] column using array_ops, a different index family). jsonb_path_ops
    // produces a smaller/faster index than the default jsonb_ops for pure
    // element containment. The Phase-1 matcher MUST write the containment shape
    // the planner can use against this opclass:
    //   SELECT id FROM question WHERE knowledge_ids @> '["<kc>"]'::jsonb
    // (jsonb_path_ops supports @> only — not key/path existence operators).
    index('question_knowledge_ids_gin').using('gin', sql`${t.knowledge_ids} jsonb_path_ops`),
  ],
);

// Phase 1c.1 Step 9.J — `mistake` and `review_event` tables DROPped per
// ADR-0006 v2: failure attempts are events (action='attempt', outcome='failure'),
// reviews are events (action='review'). FSRS state projection lives in
// `material_fsrs_state` declared below.

export const learning_item = pgTable(
  'learning_item',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    source_ref: text('source_ref'),
    title: text('title').notNull(),
    content: text('content').notNull().default(''),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    primary_artifact_id: text('primary_artifact_id'),
    parent_learning_item_id: text('parent_learning_item_id'),
    child_learning_item_ids: jsonb('child_learning_item_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text('status').notNull().default('pending'),
    user_pinned: boolean('user_pinned').notNull().default(false),
    ai_score: real('ai_score'),
    due_at: timestamp('due_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    archived_reason: text('archived_reason'),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    // ai_score is nullable; CHECK accepts NULL by default.
    check('learning_item_ai_score_range', sql`${t.ai_score} BETWEEN 0 AND 1`),
    // ADR-0027 (YUK-203 P1) — the YUK-171 1:1 uniqueIndex on primary_artifact_id was
    // dropped: a note(artifact) is now a first-class knowledge-labeled entity and a
    // learning_item only *references* it. primary_artifact_id stays as a nullable
    // "primary/representative" pointer (no longer DB-unique; one artifact may be the
    // primary of more than one item). A plain index is kept for owner-lookup reads.
    // See docs/adr/0027-note-artifact-decouple-from-learning-item-ownership.md.
    index('learning_item_primary_artifact_idx').on(t.primary_artifact_id),
  ],
);

export const learning_record = pgTable(
  'learning_record',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title'),
    content_md: text('content_md').notNull().default(''),
    source: text('source').notNull(),
    capture_mode: text('capture_mode').notNull(),
    activity_kind: text('activity_kind').notNull(),
    processing_status: text('processing_status').notNull().default('raw'),
    origin_event_id: text('origin_event_id'),
    subject_id: text('subject_id'),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
    question_id: text('question_id'),
    attempt_event_id: text('attempt_event_id'),
    learning_item_id: text('learning_item_id'),
    artifact_id: text('artifact_id'),
    source_document_id: text('source_document_id'),
    asset_refs: jsonb('asset_refs').$type<string[]>().notNull().default([]),
    payload: jsonb('payload').$type<JsonObject>().notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('learning_record_kind_created_idx').on(t.kind, t.created_at.desc()),
    index('learning_record_question_idx').on(t.question_id),
    index('learning_record_attempt_idx').on(t.attempt_event_id),
    index('learning_record_origin_event_idx').on(t.origin_event_id),
  ],
);

export const memory_brief_note = pgTable(
  'memory_brief_note',
  {
    id: text('id').primaryKey(),
    scope_key: text('scope_key').notNull(),
    subject_id: text('subject_id'),
    recent_week_md: text('recent_week_md').notNull().default(''),
    recent_months_md: text('recent_months_md').notNull().default(''),
    long_term_md: text('long_term_md').notNull().default(''),
    recent_week_evidence_ids: jsonb('recent_week_evidence_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    recent_months_evidence_ids: jsonb('recent_months_evidence_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    long_term_evidence_ids: jsonb('long_term_evidence_ids').$type<string[]>().notNull().default([]),
    // P5.3 (YUK-183) — evidence-decay freshness score over long_term_evidence_ids
    // (SoT event.created_at). nullable; null = unjudgeable (no known backing
    // timestamps, knownCount === 0), distinct from a scored 0. `real` (not
    // doublePrecision): matches the project float type + is the only float the
    // audit:schema parser recognizes. Render-annotation signal only — no row
    // mutation. Spec §5.
    long_term_freshness_score: real('long_term_freshness_score'),
    source_event_id: text('source_event_id'),
    latest_evidence_at: timestamp('latest_evidence_at', { withTimezone: true }),
    evidence_count: integer('evidence_count').notNull().default(0),
    refreshed_at: timestamp('refreshed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [uniqueIndex('memory_brief_note_scope_key_unique').on(t.scope_key)],
);

// 激活 — C 档 AI 主动产出落点（per ADR-0006 v2 + Phase 1c.1）。
// Phase 1c.1 brainstorm（2026-05-14 → ADR-0006 v2）拍板保留：作为 Note / 长答案 /
// 工具产物等 AI 主动产出的统一落地表。write path 已 ship（ADR-0020 §8 body_blocks
// 三态 SOT）：NoteGenerateTask（note_generate handler）生成 / editArtifactBodyBlocks
// （body-blocks-edit.ts）用户编辑 / persistNoteRefineApply（note-refine-apply.ts）AI
// Living Note patch / persistHubLinkDismiss（hub-dismiss.ts）。单 owner 写入约束见
// tests/integration/step9-invariant-audit.ts allowlist。
export const artifact = pgTable('artifact', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  parent_artifact_id: text('parent_artifact_id'),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  intent_source: text('intent_source').notNull(),
  source: text('source').notNull(),
  source_ref: text('source_ref'),
  body_blocks: jsonb('body_blocks').$type<ArtifactBodyBlocksT>(),
  attrs: jsonb('attrs').$type<JsonObject>().notNull().default({}),
  tool_kind: text('tool_kind'),
  tool_state: jsonb('tool_state').$type<ToolStateT>(),
  generation_status: text('generation_status').notNull().default('pending'),
  verification_status: text('verification_status').notNull().default('not_required'),
  verification_summary: jsonb('verification_summary').$type<NoteVerificationResultT>(),
  generated_by: jsonb('generated_by').$type<AgentRefT>(),
  verified_by: jsonb('verified_by').$type<AgentRefT>(),
  history: jsonb('history').$type<ArtifactHistoryEntryT[]>().notNull().default([]),
  archived_at: timestamp('archived_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(0),
});

export const artifact_block_ref = pgTable(
  'artifact_block_ref',
  {
    from_artifact_id: text('from_artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    from_block_id: text('from_block_id').notNull(),
    to_artifact_id: text('to_artifact_id')
      .notNull()
      .references(() => artifact.id),
    to_block_id: text('to_block_id'),
    // YUK-95 P5 (Wave 7 D4): discriminator so the generic cross_link
    // write-through (`syncBlockRefsForArtifact`) never clobbers the
    // embedded_check quiz rows that `embedded_check_generate` owns. New rows
    // default to 'cross_link'; the embedded_check writer sets 'embedded_check'.
    ref_kind: text('ref_kind').notNull().default('cross_link'),
  },
  (t) => [
    uniqueIndex('artifact_block_ref_unique').on(
      t.from_artifact_id,
      t.from_block_id,
      t.to_artifact_id,
      sql`COALESCE(${t.to_block_id}, '')`,
    ),
    index('artifact_block_ref_to_idx').on(t.to_artifact_id, t.to_block_id),
  ],
);

// U5 (YUK-203) — `answer` revived as the paper answer-sheet draft layer
// (ADR-0029 决定 #3: 既有原语复用, NOT a new table — RL2). Link columns are
// loose-coupled plain text refs (no FK — matches event.task_run_id /
// learning_record.artifact_id precedent, Q4 ruling): orphan-cleanup cron and
// artifact soft-delete must not be blocked by an FK.
//
// Draft grain is PER-SLOT `(session_id, question_id, part_ref)` (Q5): a
// composite question with parts gets one row per part; atomic questions have
// part_ref=null. The autosave partial unique index (drizzle/0028, hand-written)
// guarantees ONE live draft per slot. submitted_at is now nullable: null=live
// draft, set=frozen. Frozen rows are append-only history — re-submission (after
// abandon→reopen) writes a NEW row and never mutates a frozen one (§4.5).
//
// learning_item_id stays nullable/unused for paper answers (DEFER per Map §B3).
export const answer = pgTable('answer', {
  id: text('id').primaryKey(),
  question_id: text('question_id').notNull(),
  learning_item_id: text('learning_item_id'),
  input_kind: text('input_kind').notNull(),
  content_md: text('content_md').notNull().default(''),
  image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
  vision_extracted: text('vision_extracted'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  // U5 — null = live draft, set = frozen at submit. DROP NOT NULL in 0028.
  submitted_at: timestamp('submitted_at', { withTimezone: true }),
  // U5 link columns (loose refs, no FK):
  session_id: text('session_id'),
  paper_artifact_id: text('paper_artifact_id'),
  // StructuredQuestion.id of the part this answer targets; null for atomic Qs.
  part_ref: text('part_ref'),
  // back-ref to the attempt/review event written at freeze
  event_id: text('event_id'),
  // mutable working-state stamp on each autosave
  autosaved_at: timestamp('autosaved_at', { withTimezone: true }),
});
// U5 — the autosave partial unique index `answer_draft_slot_uk`
// (session_id, question_id, COALESCE(part_ref,'')) WHERE submitted_at IS NULL
// is declared in the hand-written migration drizzle/0028_u5_paper_answer_links.sql
// (drizzle-kit doesn't emit partial-index WHERE / COALESCE expression-indexes at
// this version — same pattern as the event outbox index, see above). Not in the
// table-def index array so db:generate doesn't try to re-emit it incompletely.

// Phase 1c.1 Step 1.4 (Lane A): judgment + user_appeal tables DROPped per
// data-assumptions §O2. judging is now an event (action='judge',
// subject_kind='event') per ADR-0006 v2.

export const completion_evidence = pgTable('completion_evidence', {
  id: text('id').primaryKey(),
  learning_item_id: text('learning_item_id').notNull(),
  path: text('path').notNull(),
  evidence_json: jsonb('evidence_json').$type<JsonObject>().notNull().default({}),
  decided_at: timestamp('decided_at', { withTimezone: true }).notNull(),
});

// Phase 1c.1 Step 9.J — `dreaming_proposal` table DROPped. Proposals live as
// event(action='propose', subject_kind='knowledge') (Lane B ProposeKnowledge)
// plus experimental:knowledge_<mutation> namespace events.

export const ai_task_runs = pgTable(
  'ai_task_runs',
  {
    id: text('id').primaryKey(),
    task_kind: text('task_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    input_hash: text('input_hash').notNull(),
    status: text('status').notNull().default('running'),
    finish_reason: text('finish_reason'),
    usage_json: jsonb('usage_json')
      .$type<{ inputTokens: number; outputTokens: number }>()
      .notNull()
      .default({ inputTokens: 0, outputTokens: 0 }),
    cost_usd: real('cost_usd'),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_task_runs_task_kind_idx').on(t.task_kind, t.started_at.desc()),
    index('ai_task_runs_status_idx').on(t.status, t.started_at.desc()),
  ],
);

export const tool_call_log = pgTable('tool_call_log', {
  id: text('id').primaryKey(),
  // Intentional loose coupling — NO hard FK to ai_task_runs.id. task_run_id is
  // written during the run (frequently before the ai_task_runs row is committed),
  // so a real FK would break INSERTs. Treated as a free-form text correlation id.
  task_run_id: text('task_run_id').notNull(),
  task_kind: text('task_kind').notNull(),
  tool_name: text('tool_name').notNull(),
  // YUK-79 (Foundation D M1): DomainTool registry classification.
  // null = pre-registry runner.ts auto-mirror (existing path).
  // 'read' | 'propose' | 'write' = tool registered via src/server/ai/tools.
  effect: text('effect'),
  input_json: jsonb('input_json').$type<JsonObject>(),
  output_json: jsonb('output_json').$type<JsonObject>(),
  // YUK-79: hard-fail capture (timeout / parse error / unsupported input).
  // Soft-fail (empty result) uses output_json + summary, not error_reason.
  error_reason: text('error_reason'),
  iteration: integer('iteration').notNull(),
  latency_ms: real('latency_ms').notNull(),
  // YUK-359: always 0 by design — NOT a stub. DomainTools are local DB
  // operations with no LLM cost; the few tools that inline-nest a runTask
  // (e.g. author_question → QuestionAuthorTask) have their LLM cost recorded
  // authoritatively in cost_ledger (keyed by the nested task's own run id), so
  // recording it here too would double-count. Cost reports (/api/cost/today)
  // read cost_ledger, never this column. The per-turn→nested-task attribution
  // chain (which copilot turn drove which LLM spend) is the real gap, tracked
  // in YUK-204, not solvable by filling this column.
  cost: real('cost').notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
  // YUK-79: FK to event when mirrorEvent policy fires.
  // Lane D writes this when the bridge mirrors a tool_use into the event log.
  mirrored_event_id: text('mirrored_event_id'),
});

export const cost_ledger = pgTable(
  'cost_ledger',
  {
    id: text('id').primaryKey(),
    // Intentional loose coupling — NO hard FK to ai_task_runs.id. task_run_id is
    // nullable and is often written before the ai_task_runs row exists, so a real
    // FK would break INSERTs. Treated as a free-form text correlation id.
    task_run_id: text('task_run_id'),
    task_kind: text('task_kind').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    cost: real('cost').notNull(),
    // YUK-359: `cost` 是原始计费值（evidence-first，不写入折算）；币种由本列标记。
    // 历史行 + runner(mimo USD) 默认 'USD'；GLM-OCR / memory(GLM/百炼) 写 'CNY'。
    // 读路径必须按 currency 分组聚合，绝不裸 SUM 混币（cost-today / ai-observability）。
    currency: text('currency').notNull().default('USD'),
    tokens_in: integer('tokens_in').notNull(),
    tokens_out: integer('tokens_out').notNull(),
    outcome: text('outcome').notNull().default('success'),
    pgboss_job_id: text('pgboss_job_id'),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('cost_ledger_task_run_idx').on(t.task_run_id)],
);

// pg-boss 之上的"业务事件流"：每次状态迁移同事务 INSERT 一行 + pg_notify。
// SSE replay 根据 (business_table, business_id, id) 索引查 since-id 增量事件。
// 见 ADR-0005 / 0008 + Sub 0c plan Step 3
export const job_events = pgTable(
  'job_events',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    business_table: text('business_table').notNull(),
    business_id: text('business_id').notNull(),
    event_type: text('event_type').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // computeReplay 主查询路径：(table, id, id > lastEventId ORDER BY id ASC)
    index('job_events_business_idx').on(t.business_table, t.business_id, t.id),
  ],
);

// Echo job 用作 Sub 0c golden E2E（acceptance gate #1）：HTTP enqueue → pg-boss
// worker → DB update → SSE delivers full-state event。Step 4 实现
export const echo_jobs = pgTable('echo_jobs', {
  id: text('id').primaryKey(),
  input: text('input').notNull(),
  output: text('output'),
  status: text('status').notNull().default('queued'),
  error_md: text('error_md'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1c.1 Step 1.1 (Lane A) — event-driven core tables.
//
// Per ADR-0006 v2: events are the unified action log (user / agent / cron /
// system structurally equal). Per ADR-0008: learning_session is the polymorphic
// envelope for ingestion / review / tutor / explore / create / conversation
// sessions. Per ADR-0010: knowledge_edge carries typed mesh links between
// knowledge nodes (tree backbone + mesh muscle).
//
// `event.payload` is Zod-guarded per (action × subject_kind) discriminated
// union — written by Lane B (src/core/schema/event/**). Schema-level enforce-
// ment is intentionally absent; correctness lives in the Zod parse barrier.
// ─────────────────────────────────────────────────────────────────────────────

export const learning_session = pgTable('learning_session', {
  id: text('id').primaryKey(),
  // per-type semantics — Zod discriminated union in src/core/schema/learning_session.ts (Lane B)
  type: text('type').notNull(),
  // status machine per type — see Lane B schema
  status: text('status').notNull(),
  // ingestion-only fields (nullable for other types)
  source_document_id: text('source_document_id'),
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  entrypoint: text('entrypoint'),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  error_message: text('error_message'),
  // conversation-only fields
  summary_md: text('summary_md'),
  // goal linkage — Phase 1d placeholder
  goal_id: text('goal_id'),
  // U5 (YUK-203) — soft reference to the paper artifact a review-attempt session
  // is taking (Q4: loose coupling, NO FK — matches event.task_run_id; a deleted
  // paper artifact must not block session rows / the orphan-cleanup cron). Null
  // for FSRS-逐张 review, conversation, and tutor sessions. Write path =
  // startReviewSession({ artifactId }) binding (RL4: write path same PR → no
  // allowlist entry).
  artifact_id: text('artifact_id'),
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(0),
});

export const event = pgTable(
  'event',
  {
    id: text('id').primaryKey(),
    // nullable — cron / system events may have no session
    session_id: text('session_id'),
    // 'user' | 'agent' | 'cron' | 'system' (locked Lane B contract)
    actor_kind: text('actor_kind').notNull(),
    // 'self' (single user) | task_kind (agent) | cron_name | ...
    actor_ref: text('actor_ref').notNull(),
    // KnownEvent actions + 'experimental:*' namespace (locked Lane B contract)
    action: text('action').notNull(),
    // 'question' | 'knowledge' | 'knowledge_edge' | 'artifact' | 'source_document' |
    // 'event' | 'chip' | 'query' (locked Lane B contract)
    subject_kind: text('subject_kind').notNull(),
    subject_id: text('subject_id').notNull(),
    // 'success' | 'failure' | 'partial' | NULL (depends on action)
    outcome: text('outcome'),
    // Zod-guarded per (action × subject_kind) — see Lane B
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    // chain link: judge ← attempt, propose ← cron, etc.
    caused_by_event_id: text('caused_by_event_id'),
    // ADR-0017 brief writer scope tags; fixed prefixes, dynamic suffixes.
    affected_scopes: text('affected_scopes').array().notNull().default(sql`ARRAY[]::text[]`),
    // AI task run association. Intentional loose coupling — NO hard FK to
    // ai_task_runs.id: task_run_id is nullable and is often written before the
    // ai_task_runs row exists (or for events with no run at all), so a real FK
    // would break INSERTs. Treated as a free-form text correlation id.
    task_run_id: text('task_run_id'),
    cost_micro_usd: integer('cost_micro_usd'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // YUK-101 / ADR-0021 — transactional outbox cursor. `writeEvent` only
    // INSERTs the row (ADR-0005 single-owner invariant); a separate poll
    // handler in `src/server/memory/triggers.ts` picks pending rows
    // (`ingest_at IS NULL`) with SELECT…FOR UPDATE SKIP LOCKED, enqueues
    // `memory_event_ingest`, and stamps `ingest_at = now()` in the same tx.
    // The partial index `event_ingest_pending_idx` keeps the pending scan
    // cheap regardless of total event volume.
    ingest_at: timestamp('ingest_at', { withTimezone: true }),
  },
  (t) => [
    index('event_subject_idx').on(t.subject_kind, t.subject_id, t.created_at.desc()),
    index('event_action_outcome_idx').on(t.action, t.outcome, t.created_at.desc()),
    index('event_session_idx').on(t.session_id, t.created_at),
    index('event_actor_idx').on(t.actor_kind, t.actor_ref, t.created_at),
    index('event_caused_by_idx').on(t.caused_by_event_id),
    index('event_affected_scopes_idx').using('gin', t.affected_scopes),
    // YUK-101 — partial index for the outbox poll handler. Declared in
    // hand-written migration drizzle/0017_outbox_event_ingest.sql because
    // drizzle-kit doesn't generate partial-index `WHERE …` clauses natively
    // at this version.
    // GIN index on payload (jsonb_path_ops) — declared in hand-written migration
    // (drizzle-kit doesn't generate GIN on jsonb_path_ops natively at this version).
    // See drizzle/0005_phase1c1_event_payload_gin.sql.
  ],
);

export const proposal_signals = pgTable(
  'proposal_signals',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    cooldown_key: text('cooldown_key').notNull(),
    accept_count: integer('accept_count').notNull().default(0),
    dismiss_count: integer('dismiss_count').notNull().default(0),
    acceptance_rate: real('acceptance_rate').notNull().default(0.5),
    dismiss_reason: text('dismiss_reason'),
    cooldown_until: timestamp('cooldown_until', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('proposal_signals_key_unique').on(t.kind, t.cooldown_key),
    index('proposal_signals_kind_rate_idx').on(t.kind, t.acceptance_rate.desc()),
    index('proposal_signals_cooldown_idx').on(t.cooldown_key, t.cooldown_until),
  ],
);

// FSRS state projection per review subject. YUK-203 P3 schedules knowledge-
// labeled questions by `subject_kind='knowledge'`; unlabeled legacy questions
// may still use `subject_kind='question'`.
// Latest state is derived from `event(action='review', subject_kind='question')`.
export const material_fsrs_state = pgTable(
  'material_fsrs_state',
  {
    id: text('id').primaryKey(),
    // 'knowledge' for labeled questions; 'question' remains a legacy fallback.
    subject_kind: text('subject_kind').notNull(),
    subject_id: text('subject_id').notNull(),
    // FsrsState (ts-fsrs Card-aligned) — typed via Lane B parse barrier
    state: jsonb('state').$type<FsrsStateT>().notNull(),
    due_at: timestamp('due_at', { withTimezone: true }).notNull(),
    last_review_event_id: text('last_review_event_id'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('material_fsrs_unique').on(t.subject_kind, t.subject_id),
    index('material_fsrs_due_idx').on(t.due_at),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// B1-W1 (ADR-0035 决定#2) — mastery_state：诊断维 p(L) 的物化载体。
//
// 取代 knowledge_mastery VIEW 作为 p(L) 诊断维的 SoT。YUK-420 起 view 消费端已切：
// getMasteryProjection（src/server/mastery/state.ts）是唯一展示/AI 读，投影 = 难度感知
// PFA p(L)（σ(γ·success + ρ·fail − β)，β=KC 代表性 hard-track item 难度 + ADR-0035
// 置信带），不再是 view 的占位也不再是 interim σ(θ̂)@b=0。per-knowledge 一行，
// subject_kind 固定 'knowledge'（与 material_fsrs_state 的 subject_kind 平行，但语义
// 正交：FSRS=R 调度轴，这里=p(L) 诊断轴，三轴正交红线 ADR-0035）。
//
// 单写者：src/server/mastery/state.ts（step9-invariant-audit.test.ts 新增平行断言）。
// 写路径：submit.ts / paper-submit.ts 的 attempt tx 内调 updateThetaForAttempt。
//
// 列分硬轨（本 wave 写）/ 软轨占位（本 wave NULL，进 audit allowlist）：
//   硬轨：theta_hat, evidence_count, success_count, fail_count, last_outcome_at
//   软轨占位：calibration_residual（fixed-anchor 残差，Wave2 复盘路径才写）,
//             fluency_illusion_flag（流畅度幻觉，复盘触发才置位）
// ─────────────────────────────────────────────────────────────────────────────
export const mastery_state = pgTable(
  'mastery_state',
  {
    id: text('id').primaryKey(),
    // 固定 'knowledge'——诊断维只在知识点粒度累积（PFA per-KC，B1 foundation）。
    // 列保留是为与 material_fsrs_state 形态平行 + 未来粒度扩展留口。
    subject_kind: text('subject_kind').notNull().default('knowledge'),
    subject_id: text('subject_id').notNull(),
    // θ̂：个体能力估计，logit 尺度（与 b 同度量，B1 foundation）。
    // DEFAULT 0 = logit 原点（先验中性），冷启首次 attempt 从此出发。
    theta_hat: real('theta_hat').notNull().default(0),
    // K schedule + credit-assignment 的输入。DEFAULT 0，每次 attempt +1。
    evidence_count: integer('evidence_count').notNull().default(0),
    // PFA 天然形态：per-KC success/fail 累积计数（B1 foundation）。
    // 它们也是 credit-assignment 缓冲器（高 success → 该 KC 受冲击小，VERIFY:multi-kc）。
    success_count: integer('success_count').notNull().default(0),
    fail_count: integer('fail_count').notNull().default(0),
    last_outcome_at: timestamp('last_outcome_at', { withTimezone: true }),
    // YUK-361 Phase 2 (Urnings-Lite θ 不确定性) — θ̂ 的累积 Fisher information。
    // 每次 attempt += weight²·p(1−p)（同 θ̂ 更新的 b 锚 + bWeight，见 state.ts）。
    // DEFAULT 1 = 弱先验 1 单位信息（SE=1），既有行 backfill-safe。**不存 theta_se**——
    // SE 从此列派生（thetaSe，src/core/theta.ts）。后续 MFI 用它给高不确定 θ 降权。
    theta_precision: real('theta_precision').notNull().default(1),
    // 本次 attempt 的 θ̂ 变化量（newTheta − thetaBefore），可观测/调试用。nullable：
    // 冷启或从未 attempt 的行为 NULL。default 1 不适用（这是有符号增量非信息量）。
    last_theta_delta: real('last_theta_delta'),
    // A4 (YUK-436) — 离散网格贝叶斯 θ_KC OFFSET 后验的 SHADOW 持久化（inc-1）。
    // { probs: number[41], evidence: number }（支撑点是 GRID_THETA 模块常量，不持久化）。
    // inc-1 是 PURE-ADDITIVE SHADOW：theta_hat 仍是 SoT，本列只在 THETA_GRID_ENABLED=true
    // 且单 KC 题时写，**无任何 inc-1 下游读者**（不喂 p(L)/effectiveB/选题）。flag OFF（默认）
    // 恒 NULL。校准验证后才在 inc-2（grid→SoT cut-over，必须排在 A3 之后）接读侧。
    // 进 audit-schema allowlist（写路径存在但 inc-1 无 live reader）。
    theta_grid_json: jsonb('theta_grid_json').$type<ThetaGridPosteriorJson>(),
    // 软轨占位（本 wave 不写，进 audit allowlist，kind:'manual' 解除）:
    // fixed-anchor 慢热校准残差——Wave2 复盘/锚校准路径才写。n=1 结构性受锚质量约束。
    calibration_residual: real('calibration_residual'),
    // 流畅度幻觉旗——A2 复盘判定才置位（Wave2）。本 wave 恒 NULL。
    fluency_illusion_flag: boolean('fluency_illusion_flag'),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mastery_state_unique').on(t.subject_kind, t.subject_id),
    index('mastery_state_subject_idx').on(t.subject_id),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// B1-W1 (ADR-0035 决定#3) — item_calibration：题目标定锚。
//
// 硬轨 b（IRT 难度，logit 尺度）是 θ̂ 更新读的外部锚（item-更新半边锁死，
// 永不被 Elo 回写——G4 红线）。难度来源链：item_calibration.b（有则用）→
// 兜底 question.difficulty 经 difficultyToLogitB 映射（弱锚，降权，VERIFY:difficulty-logit-map）。
//
// 软轨列 irt_a/irt_c/cdm_json/kt_json：n=1 无 cohort 结构性不可估
// （Stocking 1990 / B1 foundation §6.3）。本 wave 全 NULL，进 audit allowlist
// （kind:'manual'，reason 诚实写「结构性天花板，非攒够时间问题」）。
// 绝不进 p(L)/调度（ADR-0035）。
//
// 写者：ItemPriorTask applier（硬轨 b/confidence，source='llm_prior',track='hard'）
//       + 未来 fixed-anchor 慢热校准。单写者断言见 step9-invariant-audit.test.ts。
// ─────────────────────────────────────────────────────────────────────────────
export const item_calibration = pgTable(
  'item_calibration',
  {
    id: text('id').primaryKey(),
    question_id: text('question_id').notNull(),
    // 硬轨：IRT b（难度），logit 尺度。冷启由 ItemPriorTask 估，慢热由锚校准 firm-up。
    // nullable：冷启前无 row，applier 写入后非空。
    b: real('b'),
    // 标定置信度 0-1。ItemPriorTask 产出（llm_prior 多为低置信）。
    confidence: real('confidence'),
    // 'hard' | 'soft'——硬轨进 p(L)/调度，软轨永不进（ADR-0035）。
    track: text('track').notNull().default('hard'),
    // 'llm_prior' | 'fixed_anchor' | ... ——provenance（evidence-first 红线）。
    source: text('source').notNull(),
    // ── YUK-361 Phase 6 (Task 11, ADR-0043 §4 半数据驱动 b + §7 active-PPI)：
    //    b_anchor / b_calib 分离 + 重标定元数据 ──────────────────────────────
    //
    // 读 b 的终态优先链（effectiveB helper，src/server/mastery/recalibration.ts）：
    //   b_calib ?? b_anchor ?? b
    // 即「去偏后的 b」优先于「冷启锚 b」优先于「历史 b 列」。三者皆 logit 尺度同度量。
    //
    // - b_anchor：**冷启锚**（先验 b）。由 ItemPriorTask applier 与既有 `b` 列**同源**
    //   同步写入（applyItemPrior，feature→b 的 LLM-in-context 先验，低置信，
    //   source='llm_prior'）。语义即「外部供给的锚定尺度原点+单位」——n=1 下不可 owner
    //   自证，但绕开 θ-b 识别性墙的信息源（ADR-0043 §4 路线表「锚源」）。
    //   **Backfill 契约（migration 0038）**：既有有 `b` 的行，把现存 `b` 当锚回填到
    //   b_anchor（`UPDATE … SET b_anchor = b WHERE b IS NOT NULL`）。b_calib 保持 NULL
    //   直到批量重标定首次 firm-up——故 effectiveB 在重标定攒够标签前恒退回 b_anchor ?? b，
    //   零行为变更（read-compat NO-OP today，安全可接线）。
    b_anchor: real('b_anchor'),
    // - b_calib：**去偏后的 b**（active-PPI/AIPW 校锚标尺后的难度）。**只由批量重标定
    //   写**（src/server/mastery/recalibration.ts recalibrateQuestion），**绝不**由在线
    //   attempt 路径写——不变量①（item-半边锁死 G4）：在线 θ̂ 只 READS effectiveB，从不
    //   WRITES b_calib。nullable：重标定攒够标签（calibration_n ≥ 阈值）前恒 NULL，
    //   effectiveB 退回 b_anchor ?? b。这是 ADR-0043 §4「b 可在 PPI 框架内随真值去偏而动，
    //   非数值永久冻结」的落点——但动 b 的是慢尺度批量去偏，非单次作答。
    b_calib: real('b_calib'),
    // - calibration_n：折进 b_calib 的 difficulty_calibration_label 条数（该题/家族）。
    //   重标定门控读它（≥ RECALIBRATION_MIN_LABELS 才 firm-up b_calib，否则保持 NULL）。
    //   DEFAULT 0 = 从未重标定，backfill-safe。
    calibration_n: integer('calibration_n').notNull().default(0),
    // - calibration_weight：b_calib 的可信权重（AIPW rectifier 的有效样本量 proxy /
    //   PPI++ power-tuning λ* 的产物）。nullable：未重标定时 NULL。下游若把 b_anchor 与
    //   b_calib 做凸组合可用它定权（本 wave 不组合——effectiveB 直接优先 b_calib，
    //   留列给 Phase 7+ 的 shrinkage/凸组合细化）。
    calibration_weight: real('calibration_weight'),
    // - last_calibrated_at：上次批量重标定时刻（provenance/可观测）。nullable：未重标定 NULL。
    last_calibrated_at: timestamp('last_calibrated_at', { withTimezone: true }),
    // ── 软轨占位列（本 wave NULL，audit allowlist kind:'manual'）──
    // n=1 无 cohort 结构性不可估，不是攒够时间问题（B1 foundation §6.3）。
    irt_a: real('irt_a'), // 区分度——Stocking 1990 不可估
    irt_c: real('irt_c'), // 猜测下限
    cdm_json: jsonb('cdm_json').$type<JsonObject>(), // CDM slip/guess 画像
    kt_json: jsonb('kt_json').$type<JsonObject>(), // KT 参数
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('item_calibration_question_unique').on(t.question_id),
    index('item_calibration_track_idx').on(t.track),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-361 Phase 5 (ADR-0043 §family-级 b_personalized) — item_family_calibration：
// 家族级 b 个性化增量（n=1 逐题 b 不可估的「家族绕道」）。
//
// 背景（ADR-0043 代价行 + Phase 5 amendment）：单题 b_j 在 n=1 下结构性不可精确定
// （logit 平移不变 + N=1 校准样本），但 `(subject, primaryKnowledge, kind, source)`
// 家族级的 b_delta 在足够重复客观观测后可估——同一家族的多道题共享一个系统性
// 难度偏移信号，攒够样本后 shrinkage 守保守即可估。这是逐题 b 的家族级 fallback。
//
// 不变量①（红线）：本表 b_delta 是**独立的调整层**，永不回写 item_calibration.b
//   （那是 item-半边锁死 G4 的外部锚）。effectiveFamilyB(b_anchor, familyRow) =
//   b_anchor + shrunk_b_delta，组合在读侧发生，不污染锚本身。
//
// 两时间尺度（ADR-0043 §识别性）：θ̂ 是快尺度（每作答 Elo，state.ts），本表 b_delta
//   是慢尺度家族层（攒够客观观测才动 b_delta，门控 n≥20 + ≥5 distinct questions）。
//   慢 ≪ 快 是识别性的硬条件。
//
// 写者：src/server/mastery/personalized-difficulty.ts updateFamilyCalibration
//   （仅在客观判分 attempt tx 内 best-effort 调用，见该模块文档）。
// ─────────────────────────────────────────────────────────────────────────────
export const item_family_calibration = pgTable(
  'item_family_calibration',
  {
    id: text('id').primaryKey(),
    // familyKey(subject, primaryKnowledgeId, kind, source) = `${subject}:${pk}:${kind}:${source}`。
    // 绝不含 exact question id——家族绕道的核心（多题共享一个 b_delta）。
    family_key: text('family_key').notNull(),
    // 收缩后的家族级 b 增量（logit 尺度，与 b_anchor 同度量）。门控未过时恒 0
    // （只累 evidence_count，不应用 delta）；门控全过后 = shrinkFamilyDelta(rawDelta, n)。
    b_delta: real('b_delta').notNull().default(0),
    // 累积的客观观测条数（family 的有效样本量）。n 门控（≥20）读它。
    evidence_count: integer('evidence_count').notNull().default(0),
    // YUK-361 Phase 5 finding #2 修复 — 真正被折进 running mean 的残差条数（=「两门
    // 都过」起算的 fold 计数）。与 evidence_count 区分：evidence_count 数**全部**客观
    // 观测（含两门未过的预热条），calibrated_n 只数**实际折进 b_delta running mean**
    // 的条数。两者在 distinct 门「晚跨」时会发散：若 n 在 distinct≥5 之前就 ≥20，那些
    // 早期观测累进 evidence_count 但 b_delta 仍 0（distinct 门没过 → 没折进 mean），
    // calibrated_n 保持 0；待 distinct 门也过时从 1 起算。不变量：
    //   storedDelta = shrinkFamilyDelta(runningMeanOf(folded residuals), calibrated_n)
    // 精确成立，**与门跨越顺序无关**——反推 oldRawMean = b_delta / shrinkageFactor(
    // calibrated_n) 用同一基，round-trip 精确。两门一旦都过即恒过（n 只增、distinct 只
    // 增），故 calibrated_n 此后每条客观观测 +1。门控未过期间恒 0。
    calibrated_n: integer('calibrated_n').notNull().default(0),
    // 置信度 0-1，= shrinkage 因子 n/(n+priorStrength)。门控未过也可计算（只是不应用 delta）。
    confidence: real('confidence').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('item_family_calibration_family_unique').on(t.family_key)],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-361 Phase 6 (Task 11, ADR-0043 §6 + §7) — difficulty_calibration_label：
// active-PPI 重标定的**标签账本**（慢热校准资产）。
//
// ─── 为什么是难度标签而非裸判分（ADR-0043 §6，承重红线）─────────────────────
// PPI 的真值目标量 `Y` = **难度 b**，不是判分。客观题判分是二元对错 + 混 θ/学习漂移，
// 裸当 b 真值会把 b 校成 response-rate/θ 混合残差（§6 明确警告）。故每条标签存的是
// **由锚定 θ̂ 反推的难度标签** b_label（IRT 反推，见 recalibration.ts 的公式文档），
// 不是 raw outcome——outcome 与 theta_snapshot 一并存档供审计/重算，但喂 AIPW 的 `Y`
// 是 b_label。单条 n=1 反推噪声大（CI 宽）是预期的——AIPW 在池上聚合去噪（§7）。
//
// ─── π_i（inclusion_probability）从何来（ADR-0043 §7 positivity）──────────────
// 只对**真随机抽样选中**的锚题打标签：π_i 来自 selection_observation（policy='softmax_mfi'
// 的 tempered-softmax sampler 写入的真 inclusion probability，∈(0,1]，满足 positivity）。
// legacy/到期项无真 π_i（确定性选题，事后归一化分数非合法 IPW 权重）→ **不打标签**
// （label hook 在 join 不到真 π_i 时 skip，见 recordDifficultyCalibrationLabel）。
//
// ─── 慢热资产 → 进 FK_ORDER 备份（archive.ts 契约）────────────────────────────
// 标签攒不回来（owner 用工具的历史，丢了即灭失），同 selection_observation /
// item_family_calibration 是承重 telemetry，进 FK_ORDER（非 BACKUP_EXCLUDED）。**新表
// 进 FK_ORDER → SCHEMA_VERSION bump 4.4→4.5**（per archive.ts:92；对比 item_calibration
// 的**列**additive 不 bump）。
//
// ─── 写者（单写者契约，step9-invariant-audit.test.ts）──────────────────────────
// 只由 src/server/mastery/recalibration.ts 的 recordDifficultyCalibrationLabel 写
// （被 submit.ts / paper-submit.ts 的 attempt 路径在 SAVEPOINT 内 best-effort 调用，
// 同家族 hook 的 tx-abort 隔离纪律——见 hook 文档）。
// ─────────────────────────────────────────────────────────────────────────────
export const difficulty_calibration_label = pgTable(
  'difficulty_calibration_label',
  {
    id: text('id').primaryKey(),
    // 被标定的题（软引用 question.id，no enforced FK）。重标定按 question_id 聚合标签。
    question_id: text('question_id').notNull(),
    // 产生本标签的 attempt/review 事件（软引用 event.id，no enforced FK）——provenance
    // （evidence-first 红线）+ 去重锚（同一 attempt 不重复打标签）。
    attempt_event_id: text('attempt_event_id').notNull(),
    // 作答时（PRE-attempt）的 θ̂——**必须**是 θ-before（同 Phase 5 family hook 的
    // thetaBefore 纪律：在 updateThetaForAttempt 之前捕获）。b_label 的反推锚定它。
    theta_snapshot: real('theta_snapshot').notNull(),
    // 客观判分二元结果：success=1 / failure=0。partial 被 hook 早返排除（同 Phase 5）。
    // 存档供审计/重算；喂 AIPW 的 Y 是下面 b_label 而非它（§6 红线）。
    outcome: integer('outcome').notNull(),
    // **难度标签**（§6）：由 (outcome, theta_snapshot) 单次 fixed-anchor IRT 反推的隐含 b。
    // 公式见 recalibration.ts impliedBLabel。单条噪声大（CI 宽），AIPW 池上聚合去噪。
    b_label: real('b_label').notNull(),
    // 纳入概率 π_i ∈ (0,1]（真随机抽样，positivity）。AIPW rectifier 的 IPW 权重分母。
    // 来自 selection_observation（softmax_mfi sampler）；hook 拒 ≤0（合法概率护栏）。
    inclusion_probability: real('inclusion_probability').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 主查询路径：按 question 取该题全部标签（重标定回放）。
    index('difficulty_calibration_label_question_idx').on(t.question_id),
    // 去重：同一 attempt 事件最多一条标签（hook onConflictDoNothing 兜底重试/并发）。
    uniqueIndex('difficulty_calibration_label_attempt_unique').on(t.attempt_event_id),
  ],
);

// Typed mesh edges between knowledge nodes (ADR-0010).
// Tree (knowledge.parent_id) is the backbone; this is the muscle.
export const knowledge_edge = pgTable(
  'knowledge_edge',
  {
    id: text('id').primaryKey(),
    from_knowledge_id: text('from_knowledge_id')
      .notNull()
      .references(() => knowledge.id),
    to_knowledge_id: text('to_knowledge_id')
      .notNull()
      .references(() => knowledge.id),
    // 'prerequisite' | 'related_to' | 'contrasts_with' | 'applied_in' |
    // 'derived_from' | 'experimental:*' — Zod-validated in Lane B
    relation_type: text('relation_type').notNull(),
    // 0-1 confidence; AI proposals fill with confidence, user adds default 1
    weight: real('weight').notNull().default(1),
    created_by: jsonb('created_by').$type<AgentRefT>().notNull(),
    reasoning: text('reasoning'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('knowledge_edge_unique').on(
      t.from_knowledge_id,
      t.to_knowledge_id,
      t.relation_type,
    ),
    index('knowledge_edge_from_idx').on(t.from_knowledge_id, t.relation_type),
    index('knowledge_edge_to_idx').on(t.to_knowledge_id, t.relation_type),
  ],
);

// YUK-17 / ADR-0018 — variant lifecycle ledger.
//
// Each row tracks one AI-proposed mistake variant from "AI drafted" through
// "user accepted + question materialized" or "verify pass 2 broke it" / "user
// dismissed". variant_question proposals get a 'draft' row on write; accept
// transitions to 'active' (and the question row is materialized in the same
// txn); VariantVerifyTask second-pass verdict='fail' flips to 'broken'. See
// docs/adr/0018-mistake-variant-lifecycle-and-variants-max.md.
//
// counting variants_max = 3 reads the in-flight set (status IN ('draft',
// 'active')), so AI cannot flood the inbox even when the user defers review.
export const mistake_variant = pgTable(
  'mistake_variant',
  {
    id: text('id').primaryKey(),
    parent_question_id: text('parent_question_id').notNull(),
    variant_question_id: text('variant_question_id'),
    proposal_event_id: text('proposal_event_id'),
    status: text('status').notNull(),
    failure_reasons: jsonb('failure_reasons').$type<string[]>().notNull().default([]),
    cause_category: text('cause_category'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('mistake_variant_parent_idx').on(t.parent_question_id),
    index('mistake_variant_status_idx').on(t.status),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-143 / ADR-0025 — North-Star `goal` entity (Wave-9 core).
//
// A goal is a long-lived, usually subject-scoped learning intent ("能流畅读
// 《史记》"). It is materialized from a `goal_scope` AiProposal being accepted
// (evidence-first): create/confirm go through the event log, the goal row's
// `source_ref` points at the propose event id. Multiple goals run in parallel
// (ND-1); a goal only ADDS direction (soft bias + tags) and never suppresses
// FSRS-due reviews or other capture tasks (ND-5 — see ADR-0025).
//
// `sequence_hint` is AI-internal ordering only — NOT surfaced as progress
// (ND-4: no progress bar / % complete). `learning_session.goal_id` stays a
// stub (NOT an FK to goal.id): a goal spans many sessions, so binding it to a
// single session is the wrong cardinality (ADR-0025 decision 1).
export const goal = pgTable(
  'goal',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    // nullable — cross-subject goals are allowed (ND-1).
    subject_id: text('subject_id'),
    // AI-inferred + user-confirmed knowledge nodes the goal covers.
    scope_knowledge_ids: jsonb('scope_knowledge_ids').$type<string[]>().notNull().default([]),
    // AI-internal sequencing hint; NOT a progress metric (ND-4).
    sequence_hint: integer('sequence_hint').notNull().default(0),
    // 'active' | 'dormant' | 'done'
    status: text('status', { enum: ['active', 'dormant', 'done'] })
      .notNull()
      .default('active'),
    // provenance: how this goal came to exist, e.g. 'goal_scope_proposal'.
    // set-once at materialization (see audit-schema allowlist note).
    source: text('source').notNull(),
    // the propose event id that materialized this goal (evidence chain).
    // set-once at materialization.
    source_ref: text('source_ref'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    index('goal_status_idx').on(t.status, t.sequence_hint, t.created_at),
    index('goal_subject_idx').on(t.subject_id),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1c.1 Step 1.3 (Lane A) — knowledge_mastery derived view.
//
// Per ADR-0012: mastery / last_active_at are derived from events, not stored
// fields. DDL lives in drizzle/0004_phase1c1_knowledge_mastery_view.sql
// (drizzle-kit can register the view as `.existing()` but does NOT generate
// the CREATE VIEW statement). All view columns nullable except knowledge_id
// (primary correlation) — `mastery` is NULL when no evidence, `evidence_count`
// is always 0+ via COALESCE in the view SQL, `last_active_at` defaults to
// knowledge.created_at when no events touch the node.
// ─────────────────────────────────────────────────────────────────────────────

export const knowledge_mastery = pgView('knowledge_mastery', {
  knowledge_id: text('knowledge_id').notNull(),
  mastery: real('mastery'),
  evidence_count: integer('evidence_count').notNull(),
  last_evidence_at: timestamp('last_evidence_at', { withTimezone: true }),
  last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull(),
}).existing();

// ─────────────────────────────────────────────────────────────────────────────
// M2 练习流（YUK-316，总 spec REV 2 §4-M2 / P2 spec §2.1）。
//
// 「AI 维护的日程」载体：流要支持白天动态插拔（点播插入、composer_live 增补、
// 做完推进），且用户中途离开回来流必须还在原状——所以物化而非纯派生。与事件
// 不变量不冲突：**作答事实仍只写 event**，stream_item 只是日程行；status 由
// 作答动作驱动推进（前端 submit 成功后 PATCH）。
// ─────────────────────────────────────────────────────────────────────────────

export const practice_stream_item = pgTable(
  'practice_stream_item',
  {
    id: text('id').primaryKey(),
    // 流按天组织（YYYY-MM-DD；本地日由 API 层裁定后落库）
    date: text('date').notNull(),
    position: integer('position').notNull(),
    item_kind: text('item_kind').$type<'question' | 'paper'>().notNull(),
    // question.id 或 paper artifact id（软引用，沿用项目惯例）
    ref_id: text('ref_id').notNull(),
    source: text('source')
      .$type<'decay' | 'variant' | 'new_check' | 'paper' | 'on_demand' | 'import'>()
      .notNull(),
    status: text('status')
      .$type<'pending' | 'in_progress' | 'done' | 'skipped'>()
      .notNull()
      .default('pending'),
    // AI 排入理由（第一人称 provenance 素材）。M2 为模板生成；M4 夜链 AI 化。
    reasoning: text('reasoning').notNull(),
    added_by: text('added_by')
      .$type<'composer_nightly' | 'composer_live' | 'copilot' | 'user'>()
      .notNull(),
    // YUK-361 Phase 1（观测先行）— 该项排入时的选题信号快照（MFI / θ̂ /
    // theta_precision / π_i / 三个 #52 信号字段……，见 src/core/selection-signals.ts
    // SelectionCandidateSignal）。**零行为变更**：本 lane 不改 composeDailyStream
    // 排序，default {} 让既有 stream composer 测试零回归；值由 Phase 3 候选收集层
    // 计算后填充。
    signals: jsonb('signals').$type<JsonObject>().notNull().default({}),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('practice_stream_date_idx').on(t.date, t.position),
    // 同日同 ref 不重复排入（点播/增补的幂等护栏）
    uniqueIndex('practice_stream_date_ref_unique').on(t.date, t.ref_id),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Editing presence（YUK-321 M5 gate 选项 b）：web 进程写心跳、worker 进程读
// idle 决策的跨进程契约，Redis 退役（Task 9）后由本表承载。一 artifact 一行；
// pending 为编辑期被 defer 的 note-refine patch FIFO 队列（jsonb，日期用 ms
// epoch，沿 Redis 序列化形状）。本表是纯状态机存储非业务实体，不设
// created_at/updated_at——时间真相即 last_heartbeat_at。
//
// 行堆积：一 artifact 一行（upsert 不增行），单用户量级可忽略，不做清理 job
// （YAGNI）。陈旧 pending 在 load 时按 §4 裁决 (i) 丢弃（见 pg.ts）。
// ─────────────────────────────────────────────────────────────────────────────
export const editing_presence = pgTable('editing_presence', {
  artifact_id: text('artifact_id').primaryKey(),
  status: text('status').$type<'editing' | 'idle'>().notNull(),
  last_heartbeat_at: timestamp('last_heartbeat_at', { withTimezone: true }).notNull(),
  // force-apply 时钟：首个 editing 心跳盖戳、idle 清空（types.ts L71-73 契约）。
  editing_started_at: timestamp('editing_started_at', { withTimezone: true }),
  pending: jsonb('pending').$type<SerializedQueuedPatch[]>().notNull().default([]),
});

// ─────────────────────────────────────────────────────────────────────────────
// Memory reconciliation log（YUK-342 P2）：mem0 调和层 write-ahead 日志。
//
// 每条 mem0 add() 后，reconcile handler 用 GLM 判定该新 memory 与既有候选
// memory 的关系（KEEP_BOTH / SUPERSEDE / MERGE / RETRACT_NEW）。判定意图先写
// 到本表（planned 行，applied_at NULL = write-ahead），apply 完成后 UPDATE
// applied_at=now()。半途崩溃时 loadUnappliedLog 重放 applied_at IS NULL 行（幂等
// 续跑），hardDelete 命中 'not found' 被幂等吞掉。
//
// action 四值枚举 P2 起独立，不套 KG 侧 CorrectionKind（对象/时点/语义不同）。
// P4 知识侧写入期调和环是否共表 §8.5 开放。
// ─────────────────────────────────────────────────────────────────────────────
export const memory_reconciliation_log = pgTable(
  'memory_reconciliation_log',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    // mem0 vector row id（pgvector collection PK uuidv4）
    new_memory_id: text('new_memory_id'),
    old_memory_id: text('old_memory_id'),
    action: text('action').$type<'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW'>().notNull(),
    reason: text('reason').notNull(),
    llm_raw: jsonb('llm_raw'),
    // write-ahead 游标：planned_at = 意图写入时；applied_at NULL = 待重放。
    planned_at: timestamp('planned_at', { withTimezone: true }).notNull(),
    applied_at: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    index('memory_recon_user_idx').on(t.user_id),
    index('memory_recon_unapplied_idx').on(t.applied_at),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Edge reconciliation log（YUK-344 调和环增量 2，ADR-0034 §3）：知识边写入期
// 调和层 AUDIT / PROVENANCE 日志（**不是 write-ahead replay 游标**）。
//
// 与 memory_reconciliation_log（mem0 个性化轴）**结构正交**——OWNER RULING：另立
// 新表，**不复用** memory 表（结构轴 ≠ 记忆轴，无 user_id 哨兵）。每条知识边提议
// 通过拓扑闸后，reconcile handler 用 GLM 判定该候选边与既有相邻 live 边的关系
// （KEEP_BOTH / SUPERSEDE，结构边二动作空间，edge-reconcile.ts）。SUPERSEDE 的整段
// apply（落本表 planned 行 → 写新 live 边 → 归档旧边 → correction event → 盖
// applied_at）跑在**单个 db.transaction**（propose_edge.ts applyEdgeSupersede）里：
// 崩溃整体回滚（连本表行一起），**没有半途状态可重放**。本表只是 SUPERSEDE 决策的
// 审计记录（planned_at / applied_at 标注 apply 是否在该 tx 内走完）。防双写靠
// knowledge_edge UNIQUE(from,to,relation_type) 约束 + skipped_duplicate_edge
// （重复候选在 apply 前就跳过），**不靠确定性 id**——每个 event/edge id 都是 fresh
// createId()。
//
// SUPERSEDE 的实际移除走 knowledge_edge.archived_at 软归档（ADR-0034 §4 load-bearing
// 移除）；本表 + 一条 CorrectionKind correction event 只记 epistemic 来由 provenance。
//
// action 二值枚举（KEEP_BOTH/SUPERSEDE），不套 memory 侧四值——结构边无文本可
// MERGE、RETRACT_NEW 由上游拓扑/语义闸承接（edge-reconcile.ts 模块头）。
// 行堆积：单用户量级可忽略，不做清理 job（YAGNI），与 memory 表同纪律。
// ─────────────────────────────────────────────────────────────────────────────
export const edge_reconciliation_log = pgTable(
  'edge_reconciliation_log',
  {
    id: text('id').primaryKey(),
    // 候选边键三元组（from|to|relation_type）——审计锚，记录这条 SUPERSEDE 针对的
    // 候选边（候选边落库前无自身 UUID，故用三元组而非 edge id）。
    candidate_from_knowledge_id: text('candidate_from_knowledge_id').notNull(),
    candidate_to_knowledge_id: text('candidate_to_knowledge_id').notNull(),
    candidate_relation_type: text('candidate_relation_type').notNull(),
    // 调和判定结果。SUPERSEDE 时 superseded_edge_id 指向被归档的旧 live 边。
    action: text('action').$type<'KEEP_BOTH' | 'SUPERSEDE'>().notNull(),
    // 被取代的旧 knowledge_edge.id（仅 SUPERSEDE 非空）。
    superseded_edge_id: text('superseded_edge_id'),
    // 判定置信度（applyConfidenceThreshold 后；低置信已降级为 KEEP_BOTH）。
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    // GLM 原始决策（审计；KEEP_BOTH 短路无 GLM 调用 / 降级时可为 null）。
    llm_raw: jsonb('llm_raw'),
    // 审计时间戳：planned_at = 决策落本表时；applied_at = 同一 apply tx 末尾盖戳
    //（NULL 只会出现在 apply tx 内部的瞬时，提交后总是非 NULL——崩溃则整行回滚）。
    planned_at: timestamp('planned_at', { withTimezone: true }).notNull(),
    applied_at: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    index('edge_recon_candidate_idx').on(
      t.candidate_from_knowledge_id,
      t.candidate_to_knowledge_id,
      t.candidate_relation_type,
    ),
    index('edge_recon_unapplied_idx').on(t.applied_at),
    // action ↔ superseded_edge_id consistency invariant, enforced at the DB layer
    // (not just the application layer): a SUPERSEDE row MUST name the archived old
    // edge (superseded_edge_id non-null), and a KEEP_BOTH row MUST NOT (null).
    // Mirrors the decision builder in edge-reconcile.ts (SUPERSEDE → neighbor.edge_id,
    // KEEP_BOTH → null) so the DB can never persist a contradictory audit row.
    check(
      'edge_recon_action_superseded_ck',
      sql`(${t.action} = 'SUPERSEDE' AND ${t.superseded_edge_id} IS NOT NULL) OR (${t.action} = 'KEEP_BOTH' AND ${t.superseded_edge_id} IS NULL)`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Selection observation（YUK-361 Phase 1，观测先行）：选题的逐项遥测。
//
// 每个被选中的候选（题或卷）落一行，记录当时的策略（policy）、是否选中
// （selected）、纳入概率 π_i（inclusion_probability，softmax 抽样产物）、以及完整
// 信号快照（signals，SelectionCandidateSignal 形态）。π_i 是 D17 推翻后 active-PPI
// 重标定**必需的慢热资产**（per-item 慢热校准从随机化选题的纳入概率反推暴露偏差），
// 不可丢——故本表是承重 telemetry，进 FK_ORDER 备份（非 BACKUP_EXCLUDED）。
//
// **本 lane 零选题行为变更**：表 + writer helper 就位，但不接进 composeDailyStream；
// 行为变更（随机化选题 + 真实 π_i 写入）是 Phase 3（roadmap Task 8）。default policy
// 仍 legacy。inclusion_probability ∈ (0, 1]，writer 拒 ≤0（合法概率护栏）。
// ─────────────────────────────────────────────────────────────────────────────
export const selection_observation = pgTable(
  'selection_observation',
  {
    id: text('id').primaryKey(),
    // 选题发生的本地日（YYYY-MM-DD），与 practice_stream_item.date 同度量。
    date: text('date').notNull(),
    // 关联的流项（软引用 practice_stream_item.id）。nullable：观测可在物化流项前
    // 落库（候选层），或对未入流的候选记录暴露偏差。
    stream_item_id: text('stream_item_id'),
    ref_kind: text('ref_kind').$type<'question' | 'paper'>().notNull(),
    ref_id: text('ref_id').notNull(),
    // 策略标识（本 lane default 'legacy'；Phase 3 起 'mfi_softmax' 等）。
    policy: text('policy').notNull(),
    selected: boolean('selected').notNull(),
    // 纳入概率 π_i ∈ (0, 1]。writer 拒 ≤0（recordSelectionObservation 校验）。
    inclusion_probability: real('inclusion_probability').notNull(),
    // 信号快照（SelectionCandidateSignal，src/core/selection-signals.ts）。
    signals: jsonb('signals').$type<JsonObject>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 主查询路径：按日 + ref 取观测（writer test + Phase 3 重标定回放）。
    index('selection_observation_date_ref_idx').on(t.date, t.ref_id),
    index('selection_observation_date_idx').on(t.date),
  ],
);
