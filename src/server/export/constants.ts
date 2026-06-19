// Phase 1c.1 Step 9.J: legacy tables (mistake / review_event / dreaming_proposal /
// ingestion_session) DROPped — major bump.
// P5.3 (YUK-183): additive nullable `memory_brief_note.long_term_freshness_score`
// column — minor bump. Column rides the whole-row dump/restore automatically.
// ②d backup-orphan fix (YUK reverse-lockstep): 7 persistent business tables that
// had silently dropped out of the wipe-then-restore payload joined FK_ORDER
// (artifact_block_ref, ai_task_runs, mistake_variant, goal, proposal_signals,
// practice_stream_item, memory_reconciliation_log) — minor bump to 4.2. New tables
// ride the whole-row dump/restore automatically. Transient/operational tables
// (job_events, echo_jobs, editing_presence) were instead recorded in
// BACKUP_EXCLUDED_TABLES below.
// B1-W1 (ADR-0035): additive `mastery_state` + `item_calibration` tables — also
// additive within the 4.2 generation (both ride whole-row dump/restore via
// FK_ORDER below). 24 → 26 tables; version stays 4.2 (additive, no format break).
// YUK-361 Phase 1 (观测先行): additive `selection_observation` table — 承重 telemetry
// (π_i 是 D17 推翻后 active-PPI 重标定必需的慢热资产，不可丢)，故进 FK_ORDER 备份
// (非 BACKUP_EXCLUDED)。+ `practice_stream_item.signals` additive jsonb 列 (ride 整行
// dump/restore)。26 → 27 tables；bump 4.2 → 4.3 标注 telemetry 慢热资产入备份的契约变更。
// YUK-361 Phase 5 (家族级 b_personalized): additive `item_family_calibration` table —
// 慢热校准资产 (家族级 b_delta 在足够重复客观观测后才 firm-up，攒不回来丢了即灭失)，
// 同 item_calibration 进 FK_ORDER 备份 (非 BACKUP_EXCLUDED)。27 → 28 tables；bump
// 4.3 → 4.4 标注慢热校准资产入备份的契约变更 (per archive.ts assertEveryTableIsBackedUpOrExcluded)。
// YUK-361 Phase 6 (active-PPI 重标定): additive `difficulty_calibration_label` table —
// active-PPI 的难度标签账本 (锚定 θ̂ 反推的 b_label + π_i)，慢热校准资产 (owner 用工具
// 的历史，攒不回来丢了即灭失)，同 item_family_calibration 进 FK_ORDER 备份 (非
// BACKUP_EXCLUDED)。28 → 29 tables；bump 4.4 → 4.5 (NEW FK_ORDER table 必 bump，per
// archive.ts:92)。**对比**：同 Phase 6 给 item_calibration 加的 b_anchor/b_calib/
// calibration_n/calibration_weight/last_calibrated_at 是既有 FK_ORDER 表的 additive
// **列**，随整行 dump/restore，**不 bump**（同 Phase 2 theta_precision 加列不 bump 4.2
// 的先例）。表 = bump，列 = 不 bump。
// YUK-344 (调和环增量 2，ADR-0034 §3): additive `edge_reconciliation_log` table —
// 结构轴知识边调和的 AUDIT / PROVENANCE 日志 (SUPERSEDE 决策来由，provenance 值得保留)，
// 同 memory_reconciliation_log 进 FK_ORDER 备份 (非 BACKUP_EXCLUDED)。29 → 30 tables；bump
// 4.5 → 4.6 (NEW FK_ORDER table 必 bump，per archive.ts:92)。这是纯备份登记 + 版本号 bump，
// 不动任何 reconcile runtime。
// YUK-355 (D17「数据可丢」推翻续): mem0 个性化半边的 pgvector collection 表 (默认
// `learning_project_memories`) 纳入备份/恢复。它是 mem0 PGVector provider 运行时自建的表
// (NOT drizzle-managed，无 pgTable 导出)，故**不**进 FK_ORDER (会让 buildColumnAllowlist 因
// 找不到 pgTable 而 throw)，而是走 archive.ts 里独立的 mem0-collection 备份/恢复分支
// (id/vector/payload 固定列 + vector::text 序列化 / ::vector 回插)。这闭合 §1② 端到端验收
// 接缝 e (「备 WAL 不备 collection 是半截」)——之前只备 memory_reconciliation_log
// (WAL/provenance)，慢热软画像本体 (collection 行) 仍在 restore 后灭失。新增数据载荷形态
// (data.json 多一个 mem0-collection key) 必 bump：4.6 → 4.7。
export const SCHEMA_VERSION = '4.7';

// CF Worker free plan caps at 50 subrequests per request. We use 18 D1 SELECTs
// + a few R2 reads for assets + future-proof headroom. Cap inline assets at 45;
// users with more must use refs-only export + wrangler r2 cp sidecar.
// Paid plan = 1000 subrequests; bump to ~950 if you upgrade.
// (Note: D1/Workers no longer in use post sub-0b1; cap retained as a safety guardrail.)
export const MAX_INLINE_ASSETS = 45;

// FK topological order. Insert sweeps forward; wipe sweeps reverse. Any schema
// change that adds/removes/renames a table MUST update this array AND bump
// SCHEMA_VERSION in lockstep. The reverse-lockstep guardrail in archive.ts now
// ENFORCES this: every pgTable in src/db/schema.ts must appear here OR in
// BACKUP_EXCLUDED_TABLES, or the module throws at load.
//
// Phase 1c.1 Lane A + Step 9.J:
//   - removed: judgment + user_appeal (Step 1.4) + mistake + review_event +
//     dreaming_proposal + ingestion_session (Step 9.J)
//   - added: knowledge_edge (ADR-0010), learning_session (ADR-0008),
//     material_fsrs_state (ADR-0006 v2 FSRS projection), event (ADR-0006 v2)
//   - knowledge_mastery view: NOT in FK_ORDER (views are read-only, not exported)
//
// ②d backup-orphan fix (reverse-lockstep): added 7 persistent business tables that
// had silently fallen out of the backup payload — artifact_block_ref (cross-link +
// embedded-check refs), ai_task_runs (AI run ledger), mistake_variant (variant
// lifecycle), goal (North-Star entity), proposal_signals (slow-accumulated AI
// acceptance learning state), practice_stream_item (materialized schedule),
// memory_reconciliation_log (mem0 reconciliation WAL). These were a pre-existing
// data-loss hole on restore, not new tables.
//
// Topological constraints:
//   knowledge_edge.from/to → knowledge (FK)
//   event.session_id → learning_session (FK, nullable)
//   material_fsrs_state: polymorphic, no enforced FK
//   artifact_block_ref.from/to_artifact_id → artifact (FK) — MUST follow artifact
//   All other ②d additions use loose-coupling text refs (no hard FK), so their
//   position is unconstrained by Postgres FK enforcement (project convention).
//
// B1-W1 (ADR-0035): added mastery_state (after knowledge — diagnostic projection
// keyed by knowledge subject_id, no enforced FK) + item_calibration (after
// question — logical dependency on question_id, no enforced FK). 24 → 26.
// Like knowledge_mastery these are DERIVED (rebuildable from the event stream /
// re-estimable), so they are NOT in the CSV export body — but unlike the view
// they ARE physical tables that need wipe/insert sweep ordering, so they DO
// belong in FK_ORDER (CSV-body membership and FK_ORDER membership are orthogonal).
export const FK_ORDER = [
  'knowledge',
  'mastery_state',
  'knowledge_edge',
  'source_asset',
  'source_document',
  'learning_session',
  'question_block',
  'question',
  'item_calibration',
  // YUK-361 Phase 5 (家族级 b_personalized): item_family_calibration — 家族级 b_delta
  // 慢热校准资产。软引用语义键 (subject:knowledge:kind:source，no enforced FK)，位置
  // 不受 PG FK 约束；置于 item_calibration 后保持「难度校准簇」相邻可读。
  'item_family_calibration',
  // YUK-361 Phase 6 (active-PPI 重标定): difficulty_calibration_label — 难度标签账本
  // (锚定 θ̂ 反推 b_label + π_i)。慢热校准资产，不可丢，进备份 (非 BACKUP_EXCLUDED)。
  // 软引用 question.id / event.id (text ref，no enforced FK)，位置不受 PG FK 约束；
  // 置于 item_family_calibration 后保持「难度校准簇」相邻可读。
  'difficulty_calibration_label',
  'material_fsrs_state',
  'memory_brief_note',
  'learning_record',
  'learning_item',
  'completion_evidence',
  'artifact',
  'artifact_block_ref',
  'answer',
  'event',
  'tool_call_log',
  'cost_ledger',
  'ai_task_runs',
  'mistake_variant',
  'goal',
  'proposal_signals',
  'practice_stream_item',
  // YUK-361 Phase 1 (观测先行): selection_observation — 选题逐项遥测。π_i 是 active-PPI
  // 重标定必需的慢热资产 (D17 推翻后)，不可丢，故进备份 (非 BACKUP_EXCLUDED)。
  // 软引用 practice_stream_item.id (text ref，no enforced FK)，位置不受 PG FK 约束。
  'selection_observation',
  'memory_reconciliation_log',
  // YUK-344 调和环增量 2 (ADR-0034 §3): edge_reconciliation_log — 结构轴知识边写入期
  // 调和的 AUDIT / PROVENANCE 日志 (SUPERSEDE 决策来由)。与 memory_reconciliation_log
  // (记忆/个性化轴) 结构正交但语义同类 (provenance 值得保留，丢了即灭失 epistemic 来由)，
  // 故同入 FK_ORDER 备份 (非 BACKUP_EXCLUDED)。软引用 knowledge_edge.id (superseded_edge_id
  // 是 text ref，无 hard FK)，位置不受 PG FK 约束；置于 memory_reconciliation_log 后保持
  // 两条 reconciliation 日志相邻可读。
  'edge_reconciliation_log',
] as const;

export type TableName = (typeof FK_ORDER)[number];

// Tables that are intentionally NOT part of the wipe-then-restore backup payload.
// The reverse-lockstep guardrail in archive.ts treats membership here as "covered"
// so these no longer count as orphans. Each entry MUST carry a one-line reason —
// only transient / derived / operational state belongs here, never authored or
// slow-accumulated cognitive data.
export const BACKUP_EXCLUDED_TABLES: ReadonlySet<string> = new Set<string>([
  // SSE-replay telemetry of pg-boss job lifecycle; operational, re-derived as jobs
  // run (ADR-0005/0008). Not authored data — restoring stale replay rows is wrong.
  'job_events',
  // Sub-0c golden E2E health-check fixture (HTTP enqueue → worker → SSE). Transient
  // echo-job state, not business data.
  'echo_jobs',
  // Cross-process editing-presence state machine (YUK-321 M5); explicitly "纯状态机
  // 存储非业务实体". A restore starts from an empty presence backend — heartbeats are
  // re-established live, so persisting them would resurrect stale lock state.
  'editing_presence',
]);

// ─── mem0 collection table (YUK-355) ─────────────────────────────────────────
//
// The mem0 personalization half stores memories in a pgvector "collection" table
// created at runtime by mem0's PGVector provider (mem0ai/oss). Its schema is
// fixed by mem0: `id UUID PRIMARY KEY, vector vector(<dims>), payload JSONB`
// (node_modules/mem0ai/dist/oss/index.js createCol()). The table name IS the
// collectionName verbatim. This is NOT a drizzle-managed table — it has no
// pgTable export and never appears in a migration — so it is intentionally absent
// from FK_ORDER (adding it there would make buildColumnAllowlist() throw, since
// that derives columns from getTableColumns() on schema pgTables). Instead it gets
// a dedicated mem0-collection backup/restore branch in archive.ts.
//
// The default collection name MUST stay in sync with DEFAULT_COLLECTION in
// src/server/memory/client.ts. Both resolve the same MEM0_PGVECTOR_COLLECTION env
// override so a backup taken with a custom collection name restores to the same
// table the live client reads from.
export const MEM0_COLLECTION_DEFAULT = 'learning_project_memories';

/** Resolve the mem0 pgvector collection (= table) name from env, mirroring
 * createMem0Config()'s `optionalEnv(env, 'MEM0_PGVECTOR_COLLECTION', DEFAULT)`. A
 * bare `MEM0_PGVECTOR_COLLECTION=` (empty after trim) falls back to the default. */
export function mem0CollectionTable(env: Record<string, string | undefined> = process.env): string {
  const v = env.MEM0_PGVECTOR_COLLECTION?.trim();
  return v ? v : MEM0_COLLECTION_DEFAULT;
}

// Fixed column set of the mem0 collection table (mem0 createCol()). Used as the
// restore allowlist (the drizzle-derived COLUMN_ALLOWLIST cannot cover it — it is
// not a pgTable). `vector` is the pgvector column: dumped as text (vector::text)
// and re-inserted with an explicit ::vector cast (see archive.ts).
export const MEM0_COLLECTION_COLUMNS: ReadonlySet<string> = new Set<string>([
  'id',
  'vector',
  'payload',
]);
