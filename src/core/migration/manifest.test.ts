import { describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from './classify';
import { type ManifestOptions, buildCaptureEdges, buildMigrationManifest } from './manifest';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from './test-fixtures';

// YUK-1048 — manifest 构建器单测（grounding §14）。
// 核心断言：可变运维字段绝不进 raw-fact hash；MAX(dispatch_seq) 非完整性
// 证明的显式声明；语义计数/PK digest/edge hash 齐备。

const OPTIONS: ManifestOptions = {
  tool_version: 'test',
  git_sha: null,
  app_image: null,
  worker_image: null,
  migration_files: 42,
  redaction: { applied: false, fields: [] },
};

function seededCapture() {
  const attempt = ev({
    id: 'a1',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q-1',
    payload: { answer_md: '2', question_snapshot: SNAPSHOT },
  });
  const judge = judgeEvent({
    id: 'j1',
    subject_id: 'a1',
    caused_by_event_id: 'a1',
    payload: { judge_route: 'exact', coarse_outcome: 'correct', score: 1 },
  });
  const capture = withEvents(emptyCapture(), [attempt, judge]);
  capture.rawFacts.event_action_counts = [
    { action: 'attempt', count: 1 },
    { action: 'judge', count: 1 },
    { action: 'other_action_not_captured', count: 7 },
  ];
  return capture;
}

describe('buildMigrationManifest — raw-fact hash 纪律', () => {
  it('可变运维字段（event.ingest_at / state updated_at max）变化不影响 canonical hash', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);

    const mutatedOps = structuredClone(capture);
    mutatedOps.ops.event_ingest_at = [{ event_id: 'a1', ingest_at: '2026-09-26T00:00:00.000Z' }];
    mutatedOps.ops.state_updated_at_max = { mastery_state: '2026-09-27T00:00:00.000Z' };
    const mutated = buildMigrationManifest(mutatedOps, classification, OPTIONS);

    expect(mutated.raw_fact_hash.canonical).toBe(base.raw_fact_hash.canonical);
    // 但可变运维字段确实被单独记录（对账可见）。
    expect(mutated.mutable_ops_fields.event_ingest_at_present).toBe(1);
    expect(base.mutable_ops_fields.event_ingest_at_present).toBe(0);
    expect(mutated.mutable_ops_fields.state_updated_at_max.mastery_state).toBe(
      '2026-09-27T00:00:00.000Z',
    );
  });

  it('不可变事实变化 → canonical hash 变化', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);

    const changed = structuredClone(capture);
    changed.rawFacts.events[0].payload = { answer_md: '3', question_snapshot: SNAPSHOT };
    const changedManifest = buildMigrationManifest(
      changed,
      classifyMigrationCapture(changed),
      OPTIONS,
    );
    expect(changedManifest.raw_fact_hash.canonical).not.toBe(base.raw_fact_hash.canonical);
  });

  it('快照时刻（environment.snapshot_at）变化不影响 raw-fact hash', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);
    const later = structuredClone(capture);
    later.environment.snapshot_at = '2027-01-01T00:00:00.000Z';
    const laterManifest = buildMigrationManifest(later, classification, OPTIONS);
    expect(laterManifest.raw_fact_hash.canonical).toBe(base.raw_fact_hash.canonical);
  });
});

describe('buildMigrationManifest — §14 清单条目', () => {
  const capture = seededCapture();
  const classification = classifyMigrationCapture(capture);
  const manifest = buildMigrationManifest(capture, classification, OPTIONS);

  it('语义 row 计数 + PK digest 覆盖全部分区', () => {
    const tables = manifest.semantic_counts.map((s) => s.table);
    for (const expected of [
      'event',
      'material_fsrs_state',
      'mastery_state',
      'kc_typed_state',
      'learner_axis_state',
      'item_calibration',
      'item_family_calibration',
      'difficulty_calibration_label',
      'selection_observation',
      'answer',
      'learning_session',
      'learning_record(mirror)',
      'question(lineage)',
      'source_asset',
    ]) {
      expect(tables).toContain(expected);
    }
    const eventCount = manifest.semantic_counts.find((s) => s.table === 'event');
    expect(eventCount?.rows).toBe(2);
    expect(eventCount?.pks).toEqual(['a1', 'j1']);
    expect(eventCount?.pk_digest).toHaveLength(64);
  });

  it('event_action_counts 含未捕获 body 的 action（只计数）', () => {
    expect(manifest.event_action_counts).toContainEqual({
      action: 'other_action_not_captured',
      count: 7,
    });
  });

  it('edge hash 覆盖 caused_by / subject 引用边', () => {
    const edges = buildCaptureEdges(capture);
    expect(edges).toContainEqual({ kind: 'event.caused_by', from: 'j1', to: 'a1' });
    expect(edges).toContainEqual({ kind: 'event.subject.event', from: 'j1', to: 'a1' });
    expect(edges).toContainEqual({ kind: 'event.subject.question', from: 'a1', to: 'q-1' });
    expect(manifest.edge_hash.edge_count).toBe(edges.length);
    expect(manifest.edge_hash.digest).toHaveLength(64);
  });

  it('MAX(dispatch_seq) 非完整性证明的显式声明 + 快照上界', () => {
    expect(manifest.completeness.max_dispatch_seq).toBe(1);
    expect(manifest.completeness.note).toContain('不是完整性证明');
    expect(manifest.completeness.note).toContain('晚提交');
    expect(manifest.completeness.snapshot_at).toBe(capture.environment.snapshot_at);
    expect(manifest.completeness.captured_event_rows).toBe(2);
  });

  it('migration drift / isolation / 指纹齐备', () => {
    expect(manifest.source.db.migration_drift).toBe('in_sync');
    expect(manifest.source.isolation).toBe('repeatable read read only');
    expect(manifest.source.db.host_fingerprint).toHaveLength(12);
  });

  it('classification rollup 与 unresolved 计数入清单', () => {
    expect(manifest.classification_rollup.complete_attempt).toBeGreaterThanOrEqual(1);
    expect(manifest.unresolved_count).toBe(classification.unresolved.length);
    expect(manifest.deferred_replay_count).toBe(classification.deferred_replay.length);
  });
});

describe('buildCaptureEdges — 确定性', () => {
  it('同输入产出同序边表', () => {
    const edges1 = buildCaptureEdges(seededCapture());
    const edges2 = buildCaptureEdges(seededCapture());
    expect(edges1).toEqual(edges2);
  });
});
