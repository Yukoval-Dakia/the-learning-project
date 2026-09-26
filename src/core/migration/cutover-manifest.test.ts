import { describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from './classify';
import { SECTION14_COVERAGE, buildCutoverBackupManifest } from './cutover-manifest';
import { DLQ_DISPOSITIONS, dlqCensusTotal } from './dispositions';
import { type ManifestOptions, buildMigrationManifest } from './manifest';
import { emptyCapture, ev, withEvents } from './test-fixtures';
import type { MigrationManifest } from './types';

// YUK-1056 — final backup manifest 单测（grounding §14–§15）：
//   - §14 全条目落点核对表（coverage_map）与 migration manifest 原样嵌入；
//   - DLQ disposition 表与观测对账（census 快照 vs 导出观测）；
//   - owner_actions 与 restore/dump 工件身份字段齐备；
//   - 构建确定性：同输入 → 同输出（canonical 序列化前题）。

const OPTIONS: ManifestOptions = {
  tool_version: 'test',
  git_sha: null,
  app_image: null,
  worker_image: null,
  migration_files: 42,
  redaction: { applied: false, fields: [] },
};

function seededMigration(): MigrationManifest {
  const capture = withEvents(emptyCapture(), [
    ev({ id: 'a1', action: 'attempt', subject_kind: 'question', subject_id: 'q-1' }),
  ]);
  capture.queues = [
    { name: 'memory_event_ingest_dlq', state: 'created', count: 19 },
    { name: 'quiz_verify_dlq', state: 'created', count: 1 },
    { name: 'quiz_gen', state: 'created', count: 2 },
  ];
  const classification = classifyMigrationCapture(capture);
  return buildMigrationManifest(capture, classification, OPTIONS);
}

const BASE_INPUT = {
  migration_manifest: seededMigration(),
  dump: {
    file: '/x/loom-cutover.dump',
    sha256: 'aa'.repeat(32),
    bytes: 7_000_000,
    container_image: 'pgvector/pgvector:0.8.2-pg16-bookworm',
    toc_entries: 498,
  },
  dlq_export: {
    file: '/x/dlq.json',
    sha256: 'bb'.repeat(32),
    bytes: 40_000,
    rows_exported: 27,
  },
  dlq_observed: [
    { queue: 'memory_event_ingest_dlq', rows: 19 },
    { queue: 'quiz_verify_dlq', rows: 1 },
    { queue: 'quiz_gen_dlq', rows: 1 },
    { queue: 'dreaming_nightly_dlq', rows: 2 },
    { queue: 'knowledge_maintenance_nightly_dlq', rows: 2 },
    { queue: 'coach_daily_dlq', rows: 1 },
    { queue: 'note_refine_dlq', rows: 1 },
  ],
  job_epoch_disposition: { quiz_gen: 'translate', echo: 'drain' },
  code_contract_epoch: 'legacy',
  assessment_contract_epoch: 'assessment-contract-v1',
  restore_evidence: {
    file: '/x/evidence.json',
    sha256: 'cc'.repeat(32),
    bytes: 3000,
    verified: true,
    container: 'loom-restore-drill-x',
    toc_entries: 498,
    table_counts: { 'public.event': 1297 },
  },
  git_sha: 'deadbeef',
} as const;

describe('buildCutoverBackupManifest — §14 覆盖', () => {
  it('coverage_map 断言 §14 全部条目有落点', () => {
    const m = buildCutoverBackupManifest(BASE_INPUT);
    // 必备键一个不缺（ticket 验收：final manifest 覆盖 §14 全部条目）。
    for (const key of [
      'census_semantic_counts',
      'canonical_hash',
      'edge_hash',
      'projection_baseline',
      'queues_disposition',
      'subscription_disposition',
      'blobs_digests',
      'unresolved_list',
      'mutable_ops_fields',
      'completeness',
      'checkpoint_identity',
    ]) {
      expect(SECTION14_COVERAGE).toHaveProperty(key);
      expect(m.section14_coverage).toHaveProperty(key);
    }
    // migration manifest 原样嵌入 —— 可变运维字段不进事实 hash 的纪律继承。
    expect(m.migration.raw_fact_hash.canonical).toBe(
      BASE_INPUT.migration_manifest.raw_fact_hash.canonical,
    );
    expect(m.migration.mutable_ops_fields.excluded_from_fact_hash).toContain('event.ingest_at');
    expect(m.migration.completeness.note).toContain('dispatch_seq');
  });

  it('dump/dlq/restore 工件身份 + owner_actions 封存', () => {
    const m = buildCutoverBackupManifest(BASE_INPUT);
    expect(m.backup.dump?.sha256).toBe('aa'.repeat(32));
    expect(m.backup.dump?.toc_entries).toBe(498);
    expect(m.backup.restore_evidence?.verified).toBe(true);
    expect(m.queues.dlq_tombstones?.rows_exported).toBe(27);
    expect(m.owner_actions.length).toBeGreaterThanOrEqual(3);
    expect(m.contract_epochs.assessment_contract_epoch).toBe('assessment-contract-v1');
    expect(m.queues.job_epoch_disposition.quiz_gen).toBe('translate');
    expect(m.queues.unlisted_default).toBe('fenced');
  });

  it('DLQ 处置表与观测对账 —— 27 行全记录 + group A owner_pending', () => {
    expect(dlqCensusTotal()).toBe(27);
    const m = buildCutoverBackupManifest(BASE_INPUT);
    const groupA = DLQ_DISPOSITIONS.filter((d) => d.disposition === 'owner_decision_required');
    expect(groupA).toHaveLength(1);
    expect(groupA[0].census_rows).toBe(8);
    expect(groupA[0].execution_status).toBe('owner_pending');
    expect(groupA[0].owner_action).not.toBeNull();
    // 对账：census 合计 (19 memory_event_ingest) 与观测合计一致。
    const rec = m.queues.dlq_reconciliation.filter((r) => r.queue === 'memory_event_ingest_dlq');
    for (const r of rec) expect(r.matches).toBe(true);
  });

  it('观测缺失（null）时对账如实标 unknown —— 不静默', () => {
    const m = buildCutoverBackupManifest({ ...BASE_INPUT, dlq_observed: null });
    expect(m.queues.dlq_reconciliation.every((r) => r.matches === null)).toBe(true);
  });

  it('构建确定性：同输入双建输出一致（排除 captured_at）', () => {
    const a = buildCutoverBackupManifest({ ...BASE_INPUT, captured_at: '2026-09-26T00:00:00Z' });
    const b = buildCutoverBackupManifest({ ...BASE_INPUT, captured_at: '2026-09-26T00:00:00Z' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
