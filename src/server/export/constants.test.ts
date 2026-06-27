import { describe, expect, it } from 'vitest';
import {
  BACKUP_EXCLUDED_TABLES,
  FK_ORDER,
  MAX_INLINE_ASSETS,
  MEM0_COLLECTION_COLUMNS,
  MEM0_COLLECTION_DEFAULT,
  SCHEMA_VERSION,
  mem0CollectionTable,
} from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "4.11" (YUK-445 A11 learner_axis_state 入备份)', () => {
    // 4.7 → 4.8 (YUK-454 inc-1 / ADR-0036 身份层): NEW FK_ORDER table misconception
    // (AI-proposed/authored 认知身份实体，DORMANT in L1 但备份覆盖纯声明式)。新表入
    // FK_ORDER 必 bump (per archive.ts assertEveryTableIsBackedUpOrExcluded)，同 peer
    // 身份/校准表先例 (非 BACKUP_EXCLUDED——后者只收瞬态/派生/运维态)。
    // 4.6 → 4.7 (YUK-355): mem0 pgvector collection 表 (默认 learning_project_memories)
    // 纳入备份/恢复 —— data.json 多一个 mem0-collection key，新载荷形态必 bump。
    // 4.5 → 4.6 (YUK-344 调和环增量 2): NEW FK_ORDER table edge_reconciliation_log
    // (结构轴知识边调和的 AUDIT / PROVENANCE 日志，SUPERSEDE 决策来由)。新表入 FK_ORDER
    // 必 bump (per archive.ts:92)，同 memory_reconciliation_log 的先例 (非 BACKUP_EXCLUDED)。
    // 4.4 → 4.5 (YUK-361 Phase 6): difficulty_calibration_label 入 FK_ORDER (前一次 bump)。
    // 4.8 → 4.9 (YUK-471 W1 PR-A2a / ADR-0044): materialized_id_index 投影反查表入 FK_ORDER。
    // 4.9 → 4.10 (YUK-440 A13): kc_typed_state typed-ledger projection 入 FK_ORDER。
    // 4.10 → 4.11 (YUK-445 A11): learner_axis_state EZ-diffusion 描述符投影入 FK_ORDER。
    expect(SCHEMA_VERSION).toBe('4.11');
  });

  it('MAX_INLINE_ASSETS is 45 (legacy CF Worker 50 sub-request guardrail)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 33 tables in topological order', () => {
    // 17 → 24: ②d backup-orphan fix added 7 persistent business tables that had
    // silently dropped out of the wipe-then-restore payload (artifact_block_ref,
    // ai_task_runs, mistake_variant, goal, proposal_signals, practice_stream_item,
    // memory_reconciliation_log).
    // 24 → 26 (B1-W1 / ADR-0035): added mastery_state + item_calibration (physical
    // derived tables — in FK_ORDER for wipe/insert sweep, but NOT in the CSV body,
    // mirroring the knowledge_mastery view's "derived" rationale).
    // 26 → 27 (YUK-361 Phase 1): added selection_observation — 承重 telemetry，π_i
    // 是 active-PPI 重标定必需的慢热资产 (D17 推翻后)，进备份 (非 BACKUP_EXCLUDED)。
    // 27 → 28 (YUK-361 Phase 5): added item_family_calibration — 家族级 b_delta 慢热
    // 校准资产 (攒不回来，丢了即灭失)，同 item_calibration 进备份 (非 BACKUP_EXCLUDED)。
    // 28 → 29 (YUK-361 Phase 6): added difficulty_calibration_label — active-PPI 难度
    // 标签账本 (锚定 θ̂ 反推 b_label + π_i)，慢热校准资产，进备份 (非 BACKUP_EXCLUDED)。
    // 29 → 30 (YUK-344 调和环增量 2): added edge_reconciliation_log — 结构轴知识边调和的
    // AUDIT / PROVENANCE 日志 (SUPERSEDE 决策来由)，同 memory_reconciliation_log 进备份
    // (非 BACKUP_EXCLUDED)；置于 memory_reconciliation_log 后保持两条 reconciliation 日志相邻。
    // 30 → 31 (YUK-454 inc-1 / ADR-0036 身份层): added misconception — AI-proposed/
    // authored 认知身份实体 (DORMANT in L1，无 writer，但备份覆盖纯声明式整行 dump/restore)，
    // 按 peer 身份/校准表惯例进 FK_ORDER (非 BACKUP_EXCLUDED)；紧邻 knowledge/mastery_state
    // 身份簇 (loose-coupling text-ref，无 enforced FK，位置不受约束)。
    // 31 → 32 (YUK-471 W1 PR-A2a / ADR-0044): added materialized_id_index — projection
    // reverse-index (materialized id → anchor event). Derived-but-physical → FK_ORDER
    // (rebuildable from the event log, but knowledge/knowledge_edge are backed up so the
    // index must be too); placed last as the newest additive table.
    // 32 → 33 (YUK-440 A13): added kc_typed_state — typed KC ledger projection, peer of
    // mastery_state (derived-but-physical → FK_ORDER, not BACKUP_EXCLUDED); placed last.
    // knowledge_mastery view is read-only and excluded.
    // 33 → 34 (YUK-445 A11): added learner_axis_state — EZ-diffusion caution/speed-accuracy
    // descriptor, peer of mastery_state/kc_typed_state (derived-but-physical → FK_ORDER);
    // placed last as the newest additive table.
    expect(FK_ORDER.length).toBe(34);
    expect(FK_ORDER[0]).toBe('knowledge');
    expect(FK_ORDER[FK_ORDER.length - 1]).toBe('learner_axis_state');
  });

  it('FK_ORDER includes YUK-361 Phase 1 selection_observation telemetry (承重，非排除)', () => {
    expect(FK_ORDER).toContain('selection_observation');
    expect(BACKUP_EXCLUDED_TABLES.has('selection_observation')).toBe(false);
  });

  it('FK_ORDER respects dependencies (parent before child)', () => {
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('source_asset')).toBeLessThan(idx('source_document'));
    expect(idx('source_document')).toBeLessThan(idx('question_block'));
    expect(idx('knowledge')).toBeLessThan(idx('knowledge_edge'));
    expect(idx('learning_session')).toBeLessThan(idx('event'));
    // ②d: artifact_block_ref has a hard FK to artifact → must follow it.
    expect(idx('artifact')).toBeLessThan(idx('artifact_block_ref'));
    // B1-W1: mastery_state after knowledge; item_calibration after question.
    expect(idx('knowledge')).toBeLessThan(idx('mastery_state'));
    expect(idx('question')).toBeLessThan(idx('item_calibration'));
    // YUK-361 Phase 5: item_family_calibration adjacent to item_calibration (难度校准簇).
    expect(idx('item_calibration')).toBeLessThan(idx('item_family_calibration'));
  });

  it('FK_ORDER includes B1-W1 diagnostic tables (mastery_state, item_calibration)', () => {
    expect(FK_ORDER).toContain('mastery_state');
    expect(FK_ORDER).toContain('item_calibration');
  });

  it('FK_ORDER includes YUK-454 inc-1 misconception (身份层认知实体，承重非排除)', () => {
    // ADR-0036 身份层骨架 — DORMANT in L1 (无 writer) but backed up from day one:
    // it is AI-proposed/authored cognitive data, NOT transient/derived/operational
    // state, so it belongs in FK_ORDER (per peer identity/calibration tables), never
    // in BACKUP_EXCLUDED. FK_ORDER membership only governs wipe/restore of whatever
    // rows exist (empty in L1) — it does NOT introduce a writer.
    expect(FK_ORDER).toContain('misconception');
    expect(BACKUP_EXCLUDED_TABLES.has('misconception')).toBe(false);
    // 紧邻 knowledge/mastery_state 身份簇 (loose-coupling text-ref，无 enforced FK).
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('mastery_state')).toBeLessThan(idx('misconception'));
    expect(idx('misconception')).toBeLessThan(idx('knowledge_edge'));
  });

  it('FK_ORDER includes YUK-361 Phase 5 item_family_calibration (家族级 b 慢热资产，承重非排除)', () => {
    expect(FK_ORDER).toContain('item_family_calibration');
    expect(BACKUP_EXCLUDED_TABLES.has('item_family_calibration')).toBe(false);
  });

  it('FK_ORDER includes YUK-361 Phase 6 difficulty_calibration_label (active-PPI 难度标签账本，承重非排除)', () => {
    expect(FK_ORDER).toContain('difficulty_calibration_label');
    expect(BACKUP_EXCLUDED_TABLES.has('difficulty_calibration_label')).toBe(false);
    // 置于 item_family_calibration 后 (难度校准簇相邻)。
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('item_family_calibration')).toBeLessThan(idx('difficulty_calibration_label'));
  });

  it('FK_ORDER includes YUK-344 edge_reconciliation_log (结构轴调和 provenance，承重非排除)', () => {
    expect(FK_ORDER).toContain('edge_reconciliation_log');
    expect(BACKUP_EXCLUDED_TABLES.has('edge_reconciliation_log')).toBe(false);
    // 置于 memory_reconciliation_log 后 (两条 reconciliation 日志相邻可读)。
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('memory_reconciliation_log')).toBeLessThan(idx('edge_reconciliation_log'));
  });

  it('FK_ORDER includes all Phase 1c.1 Lane A new tables', () => {
    expect(FK_ORDER).toContain('knowledge_edge');
    expect(FK_ORDER).toContain('learning_session');
    expect(FK_ORDER).toContain('material_fsrs_state');
    expect(FK_ORDER).toContain('event');
  });

  it('FK_ORDER excludes Step 1.4 DROPped tables (judgment, user_appeal)', () => {
    expect(FK_ORDER).not.toContain('judgment');
    expect(FK_ORDER).not.toContain('user_appeal');
  });

  it('FK_ORDER excludes Step 9.J DROPped legacy tables (mistake / review_event / dreaming_proposal / ingestion_session)', () => {
    expect(FK_ORDER).not.toContain('mistake');
    expect(FK_ORDER).not.toContain('review_event');
    expect(FK_ORDER).not.toContain('dreaming_proposal');
    expect(FK_ORDER).not.toContain('ingestion_session');
  });

  it('FK_ORDER excludes views (knowledge_mastery)', () => {
    expect(FK_ORDER).not.toContain('knowledge_mastery');
  });

  it('FK_ORDER has no duplicates', () => {
    expect(new Set(FK_ORDER).size).toBe(FK_ORDER.length);
  });

  it('FK_ORDER includes the ②d backup-orphan fix tables (previously silent backup hole)', () => {
    for (const t of [
      'artifact_block_ref',
      'ai_task_runs',
      'mistake_variant',
      'goal',
      'proposal_signals',
      'practice_stream_item',
      'memory_reconciliation_log',
    ]) {
      expect(FK_ORDER).toContain(t);
    }
  });

  it('BACKUP_EXCLUDED_TABLES holds only transient/operational tables', () => {
    expect([...BACKUP_EXCLUDED_TABLES].sort()).toEqual([
      'echo_jobs',
      'editing_presence',
      'job_events',
    ]);
  });

  it('FK_ORDER and BACKUP_EXCLUDED_TABLES are disjoint', () => {
    for (const t of FK_ORDER) {
      expect(BACKUP_EXCLUDED_TABLES.has(t)).toBe(false);
    }
  });
});

describe('mem0 collection backup constants (YUK-355)', () => {
  it('default collection name matches the live mem0 client DEFAULT_COLLECTION', () => {
    // MUST stay in sync with DEFAULT_COLLECTION in src/server/memory/client.ts —
    // a drift means backups go to a table the live client does not read from.
    expect(MEM0_COLLECTION_DEFAULT).toBe('learning_project_memories');
  });

  it('mem0CollectionTable falls back to the default when env is unset', () => {
    expect(mem0CollectionTable({})).toBe('learning_project_memories');
  });

  it('mem0CollectionTable falls back to the default for a bare (empty) override', () => {
    // Mirrors createMem0Config()'s optionalEnv(): bare `MEM0_PGVECTOR_COLLECTION=`
    // loads as '' (set, not unset) → treat as "use the default".
    expect(mem0CollectionTable({ MEM0_PGVECTOR_COLLECTION: '   ' })).toBe(
      'learning_project_memories',
    );
  });

  it('mem0CollectionTable honours a non-empty MEM0_PGVECTOR_COLLECTION override', () => {
    expect(mem0CollectionTable({ MEM0_PGVECTOR_COLLECTION: 'custom_mem0' })).toBe('custom_mem0');
  });

  it('mem0 collection is NOT in FK_ORDER (non-drizzle-managed; dedicated branch)', () => {
    // Putting it in FK_ORDER would make buildColumnAllowlist() throw (no pgTable).
    expect(FK_ORDER as readonly string[]).not.toContain(MEM0_COLLECTION_DEFAULT);
  });

  it('mem0 collection column allowlist is the fixed mem0 createCol() schema', () => {
    expect([...MEM0_COLLECTION_COLUMNS].sort()).toEqual(['id', 'payload', 'vector']);
  });
});
