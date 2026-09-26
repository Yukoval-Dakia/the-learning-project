import { describe, expect, it } from 'vitest';
import {
  BACKUP_EXCLUDED_TABLES,
  FK_ORDER,
  MAX_INLINE_ASSETS,
  MEM0_COLLECTION_COLUMNS,
  MEM0_COLLECTION_DEFAULT,
  RESTORE_WIPE_ONLY_TABLES,
  SCHEMA_VERSION,
  mem0CollectionTable,
} from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "4.23" when the response-draft table enters backup', () => {
    // 4.22 → 4.23 (YUK-1052): NEW FK_ORDER table assessment_response_draft —
    // ResponseSet autosave 活草稿（用户可感知的学习中态，非瞬态 → 备份）。
    // 4.21 → 4.22 (YUK-1055): NEW FK_ORDER table contract_epoch — DB 合同 epoch
    // marker（append-only 迁移历史）。durable cutover 真相而非瞬态/运维态：
    // restore 必须携回 epoch 状态，否则恢复出的库丢失「是否已切换」的事实。
    // NEW FK_ORDER tables 必 bump。
    // 4.20 → 4.21 (YUK-1044): NEW FK_ORDER tables ×9 — 统一评估契约真相源
    // （question_revision / question_group_lifecycle / question_admission_verification /
    // assessment_issuance / evaluation_group / assessment_submission / evaluation /
    // evaluation_effective_head / assessment_identity_mapping）。Truth source 非瞬态/
    // 派生（丢 = 判分/学习真相灭失，grounding §15 cutover checkpoint 必捕获）。
    // NEW FK_ORDER tables 必 bump。
    // 4.15 → 4.16 (YUK-350): immutable question_answer_anchor,
    // question_generation_plan, and question_generation_binding authored provenance.
    // New FK_ORDER tables require a backup schema bump.
    // 4.14 → 4.15 (YUK-452 Phase B): placement_starter_claim/attempt/attempt_question/
    // cost_component 四张冷启 admission/成本台账表入 FK_ORDER（丢了即 restore 后预算控制
    // 失忆 + 付费审计断链）。NEW FK_ORDER tables 必 bump。
    // 4.13 → 4.14 (YUK-599 / YUK-597 v3 §6): NEW FK_ORDER tables ×6 — subject 控制面
    // （subject / subject_trait / subject_trait_journal / subject_trait_binding /
    // subject_control_journal / subject_name_claim）。owner 授权配置 + append-only 双
    // journal（含公共全序 change_seq 列），authored data 非瞬态非派生 → 备份；
    // subject_change_seq 序列不随行备份，restore 尾 setval 补号（archive.ts）。
    // 4.12 → 4.13 (YUK-531 A5 S4 / PR-3): NEW FK_ORDER table misconception_reconciliation_log
    // (异构误区边调和的 AUDIT / PROVENANCE 日志，peer of edge_reconciliation_log)。新表入
    // FK_ORDER 必 bump。misconception_edge 加 weight CHECK 是既有表约束 (非新表/列)，不 bump。
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
    // 4.11 → 4.12 (YUK-531 A5 S4 / ADR-0036 RT1): NEW FK_ORDER table misconception_edge
    // (异构认知关系边，peer of knowledge_edge)。新表入 FK_ORDER 必 bump (per archive.ts
    // assertEveryTableIsBackedUpOrExcluded)。misconception 加 status/source/seen/evidence
    // 列是既有表的 additive 列，随整行 dump/restore，不单独 bump (表=bump，列=不 bump)。
    // 4.19 → 4.20 (YUK-1016 454-B): NEW FK_ORDER table cause_category_overlay —
    // owner-vetted 错因词表层 (authored catalog 行，retract 只置 archived_at，不可重建)。
    expect(SCHEMA_VERSION).toBe('4.23');
  });

  it('MAX_INLINE_ASSETS is 45 (legacy CF Worker 50 sub-request guardrail)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 53 tables in topological order', () => {
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
    // 34 → 35 (YUK-531 A5 S4 / ADR-0036 RT1): added misconception_edge — heterogeneous
    // 认知关系边 (peer of knowledge_edge); placed adjacent to misconception (RT1 cluster),
    // NOT at the end (so the last element stays learner_axis_state).
    // 35 → 36 (YUK-531 A5 S4 / PR-3): added misconception_reconciliation_log — 异构误区边
    // 调和的 AUDIT / PROVENANCE 日志 (peer of edge_reconciliation_log); placed adjacent to
    // edge_reconciliation_log (reconciliation-log cluster), NOT at the end.
    // 36 → 42 (YUK-599 / YUK-597 v3 §6): added subject 控制面六表（父先子后：subject →
    // subject_trait → subject_trait_journal → subject_trait_binding →
    // subject_control_journal → subject_name_claim），placed last as the newest
    // additive cluster（loose text-ref 无 enforced FK，语义父子排序保持 restore 可读）。
    // 42 → 46 (YUK-452 Phase B): added placement_starter_claim → placement_starter_attempt
    // → placement_starter_attempt_question / placement_starter_cost_component（硬 FK 父先
    // 子后），placed last as the newest additive cluster。
    // 46 → 49 (YUK-350): immutable question_answer_anchor → question_generation_plan →
    // question_generation_binding (authored generation provenance, all backed up).
    // 49 → 50 (YUK-791): versioned intervention snapshot/recommendation/package lineage.
    // 52 → 53 (YUK-1016 454-B): added cause_category_overlay — owner-vetted 错因
    // 词表层 (authored catalog 行，非瞬态非派生)；placed adjacent to mistake_variant
    // (failure-learning cluster), NOT at the end (provider_attempt stays last).
    // 53 → 62 (YUK-1044): added 统一评估契约真相源九表（question_revision →
    // question_group_lifecycle → question_admission_verification →
    // assessment_issuance → evaluation_group → assessment_submission → evaluation
    // → evaluation_effective_head → assessment_identity_mapping，硬 FK 父先子后），
    // placed right after the question cluster (question), NOT at the end.
    // 62 → 63 (YUK-1055): added contract_epoch — durable epoch marker 历史
    // （restore 必须携回「是否已切换」事实），placed just before provider_attempt
    // (provider_attempt stays last)。
    expect(FK_ORDER.length).toBe(64);
    expect(FK_ORDER[0]).toBe('knowledge');
    expect(FK_ORDER[FK_ORDER.length - 1]).toBe('provider_attempt');
    expect(FK_ORDER.indexOf('note_verification_claim')).toBeGreaterThan(
      FK_ORDER.indexOf('artifact'),
    );
  });

  it('FK_ORDER includes YUK-1016 cause_category_overlay (owner-vetted 词表层，承重非排除)', () => {
    expect(FK_ORDER).toContain('cause_category_overlay');
    expect(BACKUP_EXCLUDED_TABLES.has('cause_category_overlay')).toBe(false);
    expect(FK_ORDER.indexOf('cause_category_overlay')).toBeGreaterThan(
      FK_ORDER.indexOf('mistake_variant'),
    );
    expect(FK_ORDER.indexOf('cause_category_overlay')).toBeLessThan(FK_ORDER.indexOf('goal'));
  });

  it('FK_ORDER includes YUK-791 intervention lineage (authored, non-excluded)', () => {
    expect(FK_ORDER).toContain('intervention');
    expect(BACKUP_EXCLUDED_TABLES.has('intervention')).toBe(false);
    expect(FK_ORDER.indexOf('event')).toBeLessThan(FK_ORDER.indexOf('intervention'));
  });

  it('FK_ORDER includes YUK-599 subject 控制面六表（authored 配置 + journal，承重非排除）', () => {
    const six = [
      'subject',
      'subject_trait',
      'subject_trait_journal',
      'subject_trait_binding',
      'subject_control_journal',
      'subject_name_claim',
    ] as const;
    for (const t of six) {
      expect(FK_ORDER).toContain(t);
      expect(BACKUP_EXCLUDED_TABLES.has(t)).toBe(false);
    }
    // 语义父子序：trait 行先于引用它的 journal/binding；subject 行先于全部子面。
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('subject')).toBeLessThan(idx('subject_trait'));
    expect(idx('subject_trait')).toBeLessThan(idx('subject_trait_journal'));
    expect(idx('subject_trait')).toBeLessThan(idx('subject_trait_binding'));
    expect(idx('subject')).toBeLessThan(idx('subject_control_journal'));
  });

  it('FK_ORDER includes YUK-361 Phase 1 selection_observation telemetry (承重，非排除)', () => {
    expect(FK_ORDER).toContain('selection_observation');
    expect(BACKUP_EXCLUDED_TABLES.has('selection_observation')).toBe(false);
  });

  it('FK_ORDER includes YUK-1044 assessment contract truth-source nine tables (承重非排除，父先子后)', () => {
    const nine = [
      'question_revision',
      'question_group_lifecycle',
      'question_admission_verification',
      'assessment_issuance',
      'evaluation_group',
      'assessment_submission',
      'evaluation',
      'evaluation_effective_head',
      'assessment_identity_mapping',
    ] as const;
    for (const t of nine) {
      expect(FK_ORDER).toContain(t);
      expect(BACKUP_EXCLUDED_TABLES.has(t)).toBe(false);
    }
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    // 紧随 question 题簇；九表内部严格满足 0105/0106 非 DEFERRABLE FK 拓扑
    //（mapping 自 FK 除外 —— 0107 DEFERRABLE，restore 事务 SET CONSTRAINTS 推迟）。
    expect(idx('question')).toBeLessThan(idx('question_revision'));
    expect(idx('question_revision')).toBeLessThan(idx('question_group_lifecycle'));
    expect(idx('question_revision')).toBeLessThan(idx('question_admission_verification'));
    expect(idx('question_revision')).toBeLessThan(idx('assessment_issuance'));
    expect(idx('question_revision')).toBeLessThan(idx('assessment_identity_mapping'));
    expect(idx('assessment_issuance')).toBeLessThan(idx('assessment_submission'));
    expect(idx('evaluation_group')).toBeLessThan(idx('assessment_submission'));
    expect(idx('assessment_submission')).toBeLessThan(idx('evaluation'));
    expect(idx('assessment_submission')).toBeLessThan(idx('evaluation_effective_head'));
    expect(idx('evaluation')).toBeLessThan(idx('evaluation_effective_head'));
    expect(idx('question_revision')).toBeLessThan(idx('item_calibration'));
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

  it('FK_ORDER includes YUK-531 misconception_edge (异构认知关系边，承重非排除)', () => {
    // ADR-0036 RT1 heterogeneous edge (caused_by / confusable_with / observed_in).
    // DORMANT until the promotion writer lands, but backed up from day one (peer of
    // knowledge_edge, AI-proposed/authored cognitive data — never BACKUP_EXCLUDED).
    expect(FK_ORDER).toContain('misconception_edge');
    expect(BACKUP_EXCLUDED_TABLES.has('misconception_edge')).toBe(false);
    // RT1 关系簇：misconception → misconception_edge → knowledge_edge (loose text-ref, no FK).
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('misconception')).toBeLessThan(idx('misconception_edge'));
    expect(idx('misconception_edge')).toBeLessThan(idx('knowledge_edge'));
  });

  it('FK_ORDER includes YUK-531 PR-3 misconception_reconciliation_log (调和审计日志，承重非排除)', () => {
    // ADR-0036 RT1 reconcile AUDIT/PROVENANCE log (SUPERSEDE 决策来由)，peer of
    // edge_reconciliation_log。承重 epistemic 来由 (丢了即灭失) → FK_ORDER, never BACKUP_EXCLUDED.
    expect(FK_ORDER).toContain('misconception_reconciliation_log');
    expect(BACKUP_EXCLUDED_TABLES.has('misconception_reconciliation_log')).toBe(false);
    // reconciliation-log 簇：edge_reconciliation_log 紧邻 misconception_reconciliation_log.
    const idx = (t: string) => FK_ORDER.indexOf(t as never);
    expect(idx('edge_reconciliation_log')).toBeLessThan(idx('misconception_reconciliation_log'));
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
      // YUK-384: ephemeral editor presence + operational reconciliation cursor,
      // both re-established on restore (see constants.ts rationale).
      'artifact_edit_session',
      'copilot_continuation',
      'copilot_evidence_checkpoint',
      // YUK-758: nightly-orchestration DAG scheduling run state (transient; rebuilt each night).
      'dag_orchestration_node',
      'dag_orchestration_run',
      'echo_jobs',
      'editing_presence',
      'event_subscription_checkpoint',
      'event_subscription_delivery',
      'event_subscription_effect',
      'hub_sync_reconciliation',
      'job_events',
      // YUK-1050: migration apply 运行台账（operational state；restore 时按 wipe 顺序清
      // phase 再 run，避免陈旧 apply 进度与恢复后的旧真相源数据并存）。
      'migration_apply_phase',
      'migration_apply_run',
      'provider_attempt_admission',
      'provider_session_admission',
      'subagent_run',
      'tool_operation',
    ]);
  });

  it('wipes ToolOperations runtime state without backing it up', () => {
    expect(BACKUP_EXCLUDED_TABLES.has('tool_operation')).toBe(true);
    expect(RESTORE_WIPE_ONLY_TABLES).toContain('tool_operation');
    expect(FK_ORDER as readonly string[]).not.toContain('tool_operation');
  });

  it('wipes YUK-932 mailbox runtime state without backing it up', () => {
    for (const table of ['subagent_run', 'copilot_continuation']) {
      expect(BACKUP_EXCLUDED_TABLES.has(table)).toBe(true);
      expect(RESTORE_WIPE_ONLY_TABLES).toContain(table);
      expect(FK_ORDER as readonly string[]).not.toContain(table);
    }
  });

  it('wipes YUK-842 operational admission state without backing it up', () => {
    expect(BACKUP_EXCLUDED_TABLES.has('provider_session_admission')).toBe(true);
    expect(RESTORE_WIPE_ONLY_TABLES).toContain('provider_session_admission');
    expect(FK_ORDER as readonly string[]).not.toContain('provider_session_admission');
  });

  it('wipes YUK-839 validator checkpoints without backing up stale recovery state', () => {
    expect(BACKUP_EXCLUDED_TABLES.has('copilot_evidence_checkpoint')).toBe(true);
    expect(RESTORE_WIPE_ONLY_TABLES).toContain('copilot_evidence_checkpoint');
    expect(FK_ORDER as readonly string[]).not.toContain('copilot_evidence_checkpoint');
  });

  it('backs up provider attempts but only wipes provider-attempt admission leases', () => {
    expect(FK_ORDER).toContain('provider_attempt');
    expect(BACKUP_EXCLUDED_TABLES.has('provider_attempt')).toBe(false);
    expect(BACKUP_EXCLUDED_TABLES.has('provider_attempt_admission')).toBe(true);
    expect(RESTORE_WIPE_ONLY_TABLES).toContain('provider_attempt_admission');
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
