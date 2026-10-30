// Question generation and ingestion: answer anchors, generation plans and
// bindings, blocks, and the legacy question table.

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { AgentRef, Rubric } from '../../core/schema/business';
import type {
  QuestionAnswerAnchorT,
  QuestionGenerationPlanT,
} from '../../core/schema/question-generation-grounding';
import type { FigureRefT, StructuredQuestionT } from '../../core/schema/structured_question';
import { vector } from '../vector';

type AgentRefT = z.infer<typeof AgentRef>;
type RubricT = z.infer<typeof Rubric>;
type JsonObject = Record<string, unknown>;

// YUK-350 — immutable, independently persisted source-grounded answer contract.
// Rows are append-only versioned facts: generated questions bind an exact (id,
// version, content_hash), never a mutable "latest" anchor.
export const question_answer_anchor = pgTable(
  'question_answer_anchor',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    schema_version: integer('schema_version').notNull(),
    source_artifact_kind: text('source_artifact_kind').notNull(),
    source_artifact_id: text('source_artifact_id').notNull(),
    source_version: integer('source_version').notNull(),
    source_content_hash: text('source_content_hash').notNull(),
    source_locator: jsonb('source_locator')
      .$type<QuestionAnswerAnchorT['source']['locator']>()
      .notNull(),
    canonical_answer: jsonb('canonical_answer')
      .$type<QuestionAnswerAnchorT['canonical_answer']>()
      .notNull(),
    provenance: jsonb('provenance').$type<QuestionAnswerAnchorT['provenance']>().notNull(),
    content_hash: text('content_hash').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    uniqueIndex('question_answer_anchor_content_hash_uq').on(t.content_hash),
  ],
);

// YUK-350 — persisted plan created after its answer anchor and before generation.
// Plan lifecycle is deliberately independent of question verification lifecycle.
export const question_generation_plan = pgTable(
  'question_generation_plan',
  {
    id: text('id').notNull(),
    version: integer('version').notNull(),
    schema_version: integer('schema_version').notNull(),
    demand: jsonb('demand').$type<QuestionGenerationPlanT['demand']>().notNull(),
    knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull(),
    requested_kind: text('requested_kind').notNull(),
    requested_answer_class: text('requested_answer_class').notNull(),
    answer_anchor_id: text('answer_anchor_id').notNull(),
    answer_anchor_version: integer('answer_anchor_version').notNull(),
    answer_anchor_hash: text('answer_anchor_hash').notNull(),
    constraints: jsonb('constraints').$type<QuestionGenerationPlanT['constraints']>().notNull(),
    status: text('status', {
      enum: ['pending_generation', 'generated', 'failed', 'superseded'],
    }).notNull(),
    provenance: jsonb('provenance').$type<QuestionGenerationPlanT['provenance']>().notNull(),
    content_hash: text('content_hash').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    uniqueIndex('question_generation_plan_content_hash_uq').on(t.content_hash),
    index('question_generation_plan_anchor_idx').on(t.answer_anchor_id, t.answer_anchor_version),
    // Mirror the migration's DB-level CHECK so schema.ts stays the truth source
    // for the status invariant (matches 0077 constraint name + allowed values).
    check(
      'question_generation_plan_status_ck',
      sql`${t.status} IN ('pending_generation','generated','failed','superseded')`,
    ),
  ],
);

// Exact immutable provenance bound to the generated question. Comparator "none"
// is an explicit default-deny policy: structural no-veto still requires review.
export const question_generation_binding = pgTable(
  'question_generation_binding',
  {
    question_id: text('question_id').primaryKey(),
    plan_id: text('plan_id').notNull(),
    plan_version: integer('plan_version').notNull(),
    plan_hash: text('plan_hash').notNull(),
    answer_anchor_id: text('answer_anchor_id').notNull(),
    answer_anchor_version: integer('answer_anchor_version').notNull(),
    answer_anchor_hash: text('answer_anchor_hash').notNull(),
    comparator_policy_id: text('comparator_policy_id').notNull(),
    comparator_policy_version: integer('comparator_policy_version').notNull(),
    comparator_policy_hash: text('comparator_policy_hash').notNull(),
    validation_status: text('validation_status', {
      enum: ['pending', 'needs_review', 'rejected', 'verified'],
    }).notNull(),
    structural_status: text('structural_status', { enum: ['no_veto', 'vetoed'] }).notNull(),
    objective_correctness: text('objective_correctness', { enum: ['unverified'] }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Mirror the migration's DB-level CHECKs so schema.ts stays the truth source
    // for these status invariants (matches 0077 constraint names + allowed values).
    check(
      'question_generation_binding_validation_status_ck',
      sql`${t.validation_status} IN ('pending','needs_review','rejected','verified')`,
    ),
    check(
      'question_generation_binding_structural_status_ck',
      sql`${t.structural_status} IN ('no_veto','vetoed')`,
    ),
    check(
      'question_generation_binding_objective_correctness_ck',
      sql`${t.objective_correctness} = 'unverified'`,
    ),
  ],
);

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
    // YUK-221 — true 0-based positional order within an ingestion_session_id.
    // A batch extracted in one shot shares ONE created_at (applyExtractionResult
    // takes `now` once), so (created_at, id) degenerated to cuid2 id order within
    // a batch — NOT the real reading order. `ordinal` is written from the
    // extraction/import array index; historical rows were backfilled (0068) to
    // their prior on-screen order. Not fold truth — excluded from the W3
    // question_block create-event snapshot (see src/kernel/records/question-block-creation.ts).
    ordinal: integer('ordinal').notNull().default(0),
    // 2026-05-14: deviation from plan Step 0.4 —— plan 原文要求 DROP COLUMN，但
    // 当前 cascade.ts / ingestion route / import route 仍写此列，若现在 DROP 则
    // typecheck + 测试在 Step 1-10 之间全断。改为 nullable（行为：新代码不写、
    // 老代码继续写），DROP 推迟到 Step 11.5 legacy route 迁完之后。
    extracted_prompt_md: text('extracted_prompt_md'),
    // structured: legacy 递归 StructuredQuestion 树，或 YUK-1468 schema_version-2
    // 统一草稿文档（isDraftDocumentV2 运行时判别；旧 StructuredQuestion 只作入口
    // 适配）。TS 类型保守保持 StructuredQuestionT —— 列是 JSONB，v2 文档由
    // edit_question 写路径 cast 写入；下游 legacy 消费者只接触 legacy 块（v2
    // 块只经统一编辑/读取面访问）。
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
    // YUK-221 — the /blocks + make-paper fall-through reads order by this key.
    index('question_block_session_ordinal_idx').on(t.ingestion_session_id, t.ordinal),
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
    // `question` row linked to its parent here; this FK is the SOLE part-ness
    // authority (YUK-388/YUK-386) — the stamped `kind='question_part'` label is
    // display-only and never consulted for behavior
    // (mirrors the variant parent-ref precedent above; new axis = composition, not
    // variant lineage). Nullable: NULL on a plain/root question, set only on parts.
    // `part_index` orders parts within a parent. Written by the part-creation owner
    // `src/capabilities/practice/server/question-parts.ts` (createQuestionPart). Because a part IS a
    // question, it gets FSRS state + flows through the existing fsrs_question
    // due/review path unchanged — independent scheduling falls out of independent
    // question rows. Parent-level aggregation scheduling is DEFERRED (ADR-0014 line
    // 250). See docs/archive/superpowers/plans/2026-05-30-yuk165-question-part-lane.md.
    parent_question_id: text('parent_question_id'),
    part_index: integer('part_index'),
    created_by: jsonb('created_by').$type<AgentRefT>(),
    metadata: jsonb('metadata').$type<JsonObject>(),
    // M-1 (2026-05-21): first-class multimodal carriers.
    // `metadata.prompt_image_refs` is the legacy simple-image-ref path (still
    // written by ingestion for backwards-compatible readers; new code SHOULD
    // read from `image_refs` instead). See docs/archive/superpowers/specs/2026-05-21-
    // math-mvp-vision-design.md §4 + docs/adr/0002 revision 2026-05-21.
    figures: jsonb('figures').$type<FigureRefT[]>().notNull().default([]),
    image_refs: jsonb('image_refs').$type<string[]>().notNull().default([]),
    // `structured` is the recursive StructuredQuestion tree (stem/sub/standalone);
    // nullable for non-structured questions (variant_gen / embedded_check / etc).
    structured: jsonb('structured').$type<StructuredQuestionT | null>(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    version: integer('version').notNull().default(0),
    // YUK-383 Phase 0 — semantic retrieval substrate. Nullable. Nightly
    // embed_backfill fills NULL or stale-version rows. Ingest may also stamp a
    // vector it already computed (questionEmbedStamp) when the stored text is the
    // text that was embedded, so backfill does not pay for that row again.
    // dims=1024 MUST match EMBED_DIMS (src/server/ai/embed.ts).
    embedding: vector(1024),
    embed_model: text('embed_model'),
    embed_version: integer('embed_version'),
    // YUK-393 — re-embed-on-change freshness. sha256 of questionEmbedText
    // (prompt_md/reference_md/choices_md join). OD-2=a: question embed text does
    // NOT fold effective-domain — only the content-hash column is added here.
    // Nullable: existing non-NULL-embedding rows get a NULL hash at migration time
    // and recompute it on the next edit. Write paths: embed_backfill stamps it at
    // fill time; editQuestion (src/capabilities/practice/server/question-bank-write.ts) recomputes it when
    // prompt_md/reference_md/choices_md change and NULLs `embedding` on mismatch
    // (next backfill re-embeds). Compared, never read for behaviour.
    embed_content_hash: text('embed_content_hash'),
    // YUK-1603 — the row `version` the stored vector was computed from. Written only
    // by the embed writers (embed_backfill / questionEmbedStamp at ingest) alongside
    // the vector; cleared whenever `embedding` is NULLed. NULL = vector written
    // before this column existed (provenance unknown, still retrievable until
    // re-stamped); non-NULL and ≠ the current `version` = revision-stale → excluded
    // from current retrieval by the shared embed-currency predicate
    // (src/db/embed-currency.ts) and repaired by the backfill's currency sweep.
    embed_source_revision: integer('embed_source_revision'),
    // YUK-704 — exact identity over canonical prompt/answer/choices/rubric. This is
    // deliberately distinct from embed_content_hash (embedding freshness). Existing
    // rows remain NULL; sourcing/quiz_gen stamp new rows before INSERT.
    canonical_content_hash: text('canonical_content_hash'),
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
    uniqueIndex('question_canonical_content_hash_unique')
      .on(t.canonical_content_hash)
      .where(sql`${t.canonical_content_hash} IS NOT NULL`),
  ],
);
