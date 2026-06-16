import { describe, expect, it } from 'vitest';
import { BACKUP_EXCLUDED_TABLES, FK_ORDER, MAX_INLINE_ASSETS, SCHEMA_VERSION } from './constants';

describe('export constants', () => {
  it('SCHEMA_VERSION is "4.5" (YUK-361 Phase 6 difficulty_calibration_label NEW table 入备份)', () => {
    // 4.4 → 4.5 (YUK-361 Phase 6): NEW FK_ORDER table difficulty_calibration_label
    // (active-PPI 难度标签账本，慢热校准资产)。新表入 FK_ORDER 必 bump (per archive.ts:92)。
    // 对比：同 Phase 6 给 item_calibration 加的 b_anchor/b_calib/calibration_n/
    // calibration_weight/last_calibrated_at 是既有 FK_ORDER 表的 additive **列**，随整行
    // dump/restore，**不 bump** (同 Phase 2 theta_precision 加列不 bump 4.2 的先例)。
    expect(SCHEMA_VERSION).toBe('4.5');
  });

  it('MAX_INLINE_ASSETS is 45 (legacy CF Worker 50 sub-request guardrail)', () => {
    expect(MAX_INLINE_ASSETS).toBe(45);
  });

  it('FK_ORDER lists all 29 tables in topological order', () => {
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
    // knowledge_mastery view is read-only and excluded.
    expect(FK_ORDER.length).toBe(29);
    expect(FK_ORDER[0]).toBe('knowledge');
    expect(FK_ORDER[FK_ORDER.length - 1]).toBe('memory_reconciliation_log');
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
