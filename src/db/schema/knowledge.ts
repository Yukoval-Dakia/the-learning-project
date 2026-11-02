// Knowledge content base: knowledge nodes, misconceptions, sources, the
// knowledge-graph overlay tables, and the subject taxonomy.

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import type { AgentRef, Provenance } from '../../core/schema/business';
import { SUBJECT_TRAIT_KINDS } from '../../subjects/trait-schemas';
import { vector } from '../vector';

type AgentRefT = z.infer<typeof AgentRef>;
type ProvenanceT = z.infer<typeof Provenance>;

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
  // PARTIALLY INERT (YUK-422 documented the reservation; YUK-1405 armed 'pending').
  //   (a) 'approved' remains the default and the value every authorized writer
  //       stamps (seed, subject-root, accepted proposals, placement starter
  //       anchors). YUK-1405 (Stage 1 B6 S5): `experimental:auto_tag_kc_created`
  //       events now declare `approval_status:'pending'` — an agent-minted KC is
  //       an unauthorised new knowledge point and is honestly marked so. The
  //       fold (core/projections/knowledge.ts) honors ONLY the 'pending' claim.
  //       YUK-1604: tag births also carry `pending_reasons` (unresolved domain /
  //       non-kc parent — the owner's await-confirmation bucket) and the input
  //       classification audit block; pre-YUK-1405 births are stock-repaired to
  //       'pending' via `experimental:knowledge_approval_update` control events.
  //   (b) There are still ZERO filtering readers: no query gates behaviour on
  //       this column, so a 'pending' node stays fully usable (tags, mastery,
  //       placement) — the marker is truthful metadata for the future review
  //       surface, not a gate. 'rejected' still has no writer.
  //   (c) Tracked in docs/design/2026-05-15-data-assumptions.md (appendix
  //       'knowledge.approval_status' + §6.5 R2).
  approval_status: text('approval_status', {
    enum: ['pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('approved'),
  // YUK-1600 — 身份标记：节点是「可测知识点」还是「目标/容器」。默认 'kc' 保留全部
  // 既有行为；'goal' = LearningIntent topic 路径新建的根（学习目标），'container' =
  // subject seed 根等结构性容器。唯一判定规则：role !== 'kc' ⇒ 不评掌握、不写
  // θ/PFA/FSRS、不进供给/选题候选（读写门见 knowledge-roles 读模型）。goal 与 kc
  // 可经 knowledge_edge 互相关联，互不替代。存量回填走
  // experimental:knowledge_role_update 控制面事件（ops 回填脚本），不重写 genesis。
  // YUK-1604 — 拍卷 tag 检索（matchKnowledgeBySimilarity）只认 role='kc'：目标/容器
  // 节点不再作为题目的匹配知识点（含起点锚 placement-starter:* 的存量修复）。
  role: text('role', { enum: ['kc', 'goal', 'container'] })
    .notNull()
    .default('kc'),
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
  // YUK-1603 — the row `version` the stored vector was computed from. Written only
  // by the embed writers (embed_backfill / the ingest question stamp) alongside the
  // vector; cleared whenever `embedding` is NULLed. NULL = vector written before
  // this column existed (provenance unknown, still retrievable until re-stamped);
  // non-NULL and ≠ the current `version` = revision-stale → excluded from current
  // retrieval by the shared embed-currency predicate (src/db/embed-currency.ts) and
  // repaired by the backfill's currency sweep.
  embed_source_revision: integer('embed_source_revision'),
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
//     (the heterogeneous misconception_edge below is structural, not bi-temporal).
//   - created_at/updated_at are caller-supplied (NO defaultNow, house convention).
//   - the embedding triplet is OMITTED in L1 — it lands with the promotion-flow
//     dedup (semantic near-dup detection) when that slice ships.
// YUK-531 (A5 S4 / RT1): the promotion-flow lifecycle/provenance columns
// (status/source/seen/evidence) land here; the writer (insert via accept route)
// is gated behind MISCONCEPTION_PROMOTE_ENABLED — DORMANT until that flag flips.
export const misconception = pgTable('misconception', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  reasoning: text('reasoning'),
  // CONFIDENCE-only salience weight (NOT mastery). `belief` reuses title/reasoning.
  weight: real('weight').default(1),
  // Promotion lifecycle: 'draft' | 'active'. `fading`/`retracted` from the A5 mock
  // are READ-MODEL display projections (weight decay / archived_at), NOT stored enum
  // values — archived_at stays the ONLY retraction dimension.
  status: text('status').notNull().default('draft'),
  // Provenance二态: 'hard' (硬轨 — confirmed via repeated objective evidence) |
  // 'soft' (软轨 — AI prior / conjecture-promoted). NOT item_calibration.track (撞名).
  source: text('source').notNull().default('soft'),
  // Recurrence count that drove promotion (from gatherConjectureEvidence, the
  // identity-preserving conjecture substrate). A salience count, NOT mastery/p(L).
  seen: integer('seen').notNull().default(0),
  // Provenance event-ptr array (event ids = 回链证据), mirrors kc_typed_state
  // evidence_event_ids. SOFT-track only — never feeds the diagnostic engines.
  evidence: jsonb('evidence').$type<string[]>().notNull().default([]),
  created_by: jsonb('created_by').$type<AgentRefT>().notNull(),
  proposed_by_ai: boolean('proposed_by_ai').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  archived_at: timestamp('archived_at', { withTimezone: true }),
});

// YUK-531 (A5 S4 / ADR-0036 RT1): heterogeneous misconception edge. Polymorphic
// from/to (from_kind/to_kind discriminator) so a misconception can point at a KC
// (`caused_by` → the "指向此点的误区" join that drives MisconceptionList), at another
// misconception or KC (`confusable_with`), or at an event (`observed_in` provenance).
// relation_type ∈ caused_by | confusable_with | observed_in | experimental:* (Zod-
// validated in core/schema/misconception-edge.ts). This is a SEPARATE gate from the
// homogeneous knowledge_edge prerequisite-DAG topology gate — cycle/direction checks
// do not map onto these relation types (see misconception-topology-gate.ts).
//   RED LINES (mirror misconception): weight is CONFIDENCE-only (never mastery);
//   archived_at is the ONLY time dimension (no valid_at/invalid_at); created_at/
//   updated_at are caller-supplied with NO defaultNow — this follows the identity-
//   cluster (knowledge / misconception) timestamp convention, NOT knowledge_edge's
//   (which uses defaultNow + no updated_at). DORMANT until the PR-3 promotion
//   writer / accept route lands.
export const misconception_edge = pgTable(
  'misconception_edge',
  {
    id: text('id').primaryKey(),
    from_kind: text('from_kind').notNull(), // 'misconception'
    from_id: text('from_id').notNull(),
    to_kind: text('to_kind').notNull(), // 'knowledge' | 'misconception' | 'event'
    to_id: text('to_id').notNull(),
    // 'caused_by' | 'confusable_with' | 'observed_in' | 'experimental:*'
    relation_type: text('relation_type').notNull(),
    // 0-1 confidence; AI proposals fill with confidence, user-authored defaults 1.
    weight: real('weight').notNull().default(1),
    created_by: jsonb('created_by').$type<AgentRefT>().notNull(),
    proposed_by_ai: boolean('proposed_by_ai').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('misconception_edge_unique').on(
      t.from_kind,
      t.from_id,
      t.to_kind,
      t.to_id,
      t.relation_type,
    ),
    index('misconception_edge_from_idx').on(t.from_kind, t.from_id, t.relation_type),
    index('misconception_edge_to_idx').on(t.to_kind, t.to_id, t.relation_type),
    // YUK-531 (A5 S4 / PR-3) — DB-layer guard that the CONFIDENCE-only edge salience
    // stays in [0,1] (mirrors the Zod weight.min(0).max(1) on MisconceptionEdgeInsert
    // + the question_difficulty / learning_item_ai_score 0-1 CHECK precedents). Only
    // the EDGE weight is bounded; misconception.weight is UNBOUNDED salience (no CHECK).
    check('misconception_edge_weight_range', sql`${t.weight} BETWEEN 0 AND 1`),
  ],
);

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

// YUK-1016 / 454-B — DB-overlay 错因词表层（错因 catalog 成长路径）。
//
// Owner 09-18 裁决：收编落 DB overlay，与 `SubjectProfile.causeCategories` 合并
// 读取——词表不再只靠发版扩张。行只经 `cause_category` proposal 的 accept
// applier 写入（human-vet 边界）；`other` 归因复发 → CauseCategoryProposeTask
// → propose event → owner accept → INSERT。
//
//   - `id` 用 `ov_<slug>` 命名空间防撞（NOT `ov:`——冒号过不了
//     CauseCategoryId 的 ^[a-z][a-z0-9_]*$，同 YUK-1015 `misc:`→`misc_` 教训）。
//   - `status` ∈ 'draft' | 'active'：`archived_at` 是唯一回退维度
//     （misconception 惯例），retract applier 置 archived_at。
//   - `source` ∈ 'owner' | 'llm_propose'：两条生产路径共用同一 accept 落点。
//   - `evidence_event_ids`：支撑提议的 judge event 回链（propose event 的
//     evidence_refs 里 kind='event' 的条目）。
//   - created_at/updated_at 由调用方传入（identity-cluster 惯例，无 defaultNow）。
export const cause_category_overlay = pgTable(
  'cause_category_overlay',
  {
    id: text('id').primaryKey(),
    subject_id: text('subject_id').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    source: text('source', { enum: ['owner', 'llm_propose'] }).notNull(),
    status: text('status', { enum: ['draft', 'active'] })
      .notNull()
      .default('draft'),
    // 归属列：行由哪张 cause_category proposal 的 accept 落地——retract applier 按
    // 它限定行（mistake_variant.proposal_event_id 同款语义；无它则同 slug 跨
    // proposal 可互相归档）。
    proposal_event_id: text('proposal_event_id'),
    evidence_event_ids: jsonb('evidence_event_ids').$type<string[]>().notNull().default([]),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('cause_category_overlay_subject_idx').on(t.subject_id, t.status)],
);

// ─────────────────────────────────────────────────────────────────────────────
// YUK-599 (YUK-597 v3 trait 合同 §2.2) — subject 控制面六表族。
//
// 科目 = 六 trait 绑定的聚合视图（charter / judge_policy / cause_taxonomy /
// source_policy / render_theme / scheduling），无 definition blob。两本
// append-only journal（trait payload 史 + subject 控制时间线）共用全局序列
// subject_change_seq 作公共全序坐标（exact as-of = 按 change_seq 重放；trait/
// subject revision 是各自局部序，created_at 不承诺并发提交顺序）。
// 一切控制面写事务须先取 pg_advisory_xact_lock(SUBJECT_CONTROL_PLANE_LOCK)
// （v3 §3.1 并发协议——整面串行化，CAS 只作陈旧 UI 提交守卫）。
// 表间引用沿仓库 loose text-ref 惯例（无 enforced FK）；FK_ORDER 父先子后。
// ─────────────────────────────────────────────────────────────────────────────

export const subject = pgTable(
  'subject',
  {
    // builtin: general/yuwen/math/physics；custom: subj_<cuid2>（opaque 不可变）。
    id: text('id').primaryKey(),
    // rename 权威（root.name 同步，v2 §3.4 语义）；norm = normalizeSubjectKey 预写。
    display_name: text('display_name').notNull(),
    display_name_norm: text('display_name_norm').notNull(),
    origin: text('origin', { enum: ['builtin', 'custom'] }).notNull(),
    // general → false（结构性排除出 selectable，v2 §2.1）。
    is_selectable: boolean('is_selectable').notNull().default(true),
    // 软退休（仓库 archived_at 惯例）；retired 仍 resolvable。
    retired_at: timestamp('retired_at', { withTimezone: true }),
    // 控制行 CAS（rename/retire/restore/reset/rebind/fork 每写 +1）；
    // = subject_control_journal 的单调 PK 轴。
    revision: integer('revision').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // thin-create 幂等承载索引（v2 §3.2：200 回放 / 23505 SELECT 回放；
    // 消费语义在 YUK-600 落）。
    uniqueIndex('subject_display_name_norm_live_custom_uq')
      .on(t.display_name_norm)
      .where(sql`origin = 'custom' AND retired_at IS NULL`),
  ],
);

export const subject_trait = pgTable(
  'subject_trait',
  {
    // 种子: trt_seed_<subject>_<kind>（migrate 幂等键）；custom/fork: trt_<cuid2>。
    id: text('id').primaryKey(),
    trait_kind: text('trait_kind', { enum: SUBJECT_TRAIT_KINDS }).notNull(),
    origin: text('origin', { enum: ['builtin', 'custom'] }).notNull(),
    // per-kind strict Zod（src/subjects/trait-schemas.ts）守门后的载荷。
    payload: jsonb('payload').notNull(),
    payload_schema_version: integer('payload_schema_version').notNull(),
    // 种子血统 semver：仅种子 trait 非空（reconcile 的比较对象，= v2
    // profile_version 在 trait 粒度的转世）；custom/fork 恒 null（reconcile 不触达）。
    seed_version: text('seed_version'),
    // v3.2（owner R2-P2）：custom/fork trait 的属主科目（fork/thin-create 时落）；
    // 种子 trait 恒 null——其属主由 id 模式 trt_seed_<subject>_<kind> 表达。
    // 「自有才可原地写」判据载体（v3 §3.1）。
    owner_subject_id: text('owner_subject_id'),
    revision: integer('revision').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('subject_trait_kind_idx').on(t.trait_kind)],
);

export const subject_trait_journal = pgTable(
  'subject_trait_journal',
  {
    trait_id: text('trait_id').notNull(),
    revision: integer('revision').notNull(),
    // v3.1（owner P1-3）：每行 = 该 revision 的完整状态快照——payload + schema
    // 代际 + 时点 seed_version + 血统指针，缺任一都无法从 journal 重建历史状态
    // （journal 兼任冷启动降级链的快照仓，v3 §2.2）。
    payload: jsonb('payload').notNull(),
    payload_schema_version: integer('payload_schema_version').notNull(),
    seed_version: text('seed_version'),
    action: text('action', {
      enum: ['create', 'edit', 'rollback', 'reconcile', 'reset_to_seed', 'fork_source'],
    }).notNull(),
    // 固定映射：create/reconcile → 'migrate'；edit/rollback/reset_to_seed/
    // fork_source → 'owner'。owner-edited 谓词（v3 §6）按此 + revision 边界判。
    actor: text('actor', { enum: ['owner', 'migrate'] }).notNull(),
    // fork_source 行专用：来源 trait 与 revision（provenance 可重建，v3 §3.3）。
    source_trait_id: text('source_trait_id'),
    source_revision: integer('source_revision'),
    rolled_back_from: integer('rolled_back_from'),
    // 两本 journal 共用全局序列 subject_change_seq（v3.2 / owner R2-P2）；
    // restore 尾必须 setval（序列不随行备份，见 export/constants.ts）。
    change_seq: bigint('change_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('subject_change_seq')`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.trait_id, t.revision] })],
);

export const subject_trait_binding = pgTable(
  'subject_trait_binding',
  {
    subject_id: text('subject_id').notNull(),
    trait_kind: text('trait_kind', { enum: SUBJECT_TRAIT_KINDS }).notNull(),
    trait_id: text('trait_id').notNull(),
  },
  (t) => [
    // 每科每 kind 恰一绑定；kind 与目标 trait.trait_kind 一致由写门校验（应用层）。
    primaryKey({ columns: [t.subject_id, t.trait_kind] }),
    // boundBy/sharedBy 反查（换绑选择器 + fan-out 波及面，v3 §3.5）。
    index('subject_trait_binding_trait_idx').on(t.trait_id),
  ],
);

export const subject_control_journal = pgTable(
  'subject_control_journal',
  {
    subject_id: text('subject_id').notNull(),
    // = 控制行 revision（每次控制行写 +1，天然单调 PK 轴）。
    revision: integer('revision').notNull(),
    action: text('action', {
      enum: ['create', 'rename', 'retire', 'restore', 'reset', 'rebind', 'fork'],
    }).notNull(),
    // rebind/fork: {kind, from_trait_id, to_trait_id}；rename: {from, to}；
    // create/retire/restore: {}；reset: {rebound: [{kind, from_trait_id, to_trait_id}]}。
    detail: jsonb('detail').notNull(),
    actor: text('actor', { enum: ['owner', 'migrate'] }).notNull(),
    change_seq: bigint('change_seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('subject_change_seq')`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.subject_id, t.revision] })],
);

export const subject_name_claim = pgTable(
  'subject_name_claim',
  {
    // normalizeSubjectKey 归一键 = 唯一命名空间（canonical 与 alias 同表同列
    // 占坑，PK 拦全部抢占——替代 v1 alias 从表，v2 §2.2）。
    name_norm: text('name_norm').primaryKey(),
    subject_id: text('subject_id').notNull(),
    kind: text('kind', { enum: ['canonical', 'alias'] }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // 每 subject 恰一 canonical 行（v2 §2.2 部分唯一索引）。
    uniqueIndex('subject_name_claim_canonical_uq').on(t.subject_id).where(sql`kind = 'canonical'`),
  ],
);
