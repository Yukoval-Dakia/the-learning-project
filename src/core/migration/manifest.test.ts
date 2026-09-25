import { describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from './classify';
import {
  CLASSIFICATION_VERSION,
  type ManifestOptions,
  buildCaptureEdges,
  buildMigrationManifest,
} from './manifest';
import {
  SNAPSHOT,
  answeredReviewEvent,
  durablePendingEvent,
  emptyCapture,
  ev,
  judgeEvent,
  withEvents,
} from './test-fixtures';

// YUK-1048 — manifest 构建器单测（grounding §14；review P1-1/P1-2 修订）。
// 核心断言：可变运维字段绝不进 raw-fact hash；checkpoint 身份覆盖完整观测
// （ops/queues/subscriptions/provenance）；分类输出随清单持久化；
// MAX(dispatch_seq) 非完整性证明的显式声明。

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

  it('快照时刻（environment.snapshot_at）变化不影响 raw-fact hash 与 checkpoint hash', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);
    const later = structuredClone(capture);
    later.environment.snapshot_at = '2027-01-01T00:00:00.000Z';
    const laterManifest = buildMigrationManifest(later, classification, OPTIONS);
    expect(laterManifest.raw_fact_hash.canonical).toBe(base.raw_fact_hash.canonical);
    // 重跑不产生重复捕获的前提：运行时钟不在 checkpoint 身份里。
    expect(laterManifest.checkpoint_hash).toBe(base.checkpoint_hash);
  });
});

describe('P1-1 — checkpoint 身份覆盖完整观测（不只 raw facts）', () => {
  it('运维态（ops.ingest_at）变化 → raw-fact hash 不变但 checkpoint hash 变化', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);

    const mutated = structuredClone(capture);
    mutated.ops.event_ingest_at = [{ event_id: 'a1', ingest_at: '2026-09-26T00:00:00.000Z' }];
    const mutatedManifest = buildMigrationManifest(mutated, classification, OPTIONS);

    expect(mutatedManifest.raw_fact_hash.canonical).toBe(base.raw_fact_hash.canonical);
    expect(mutatedManifest.checkpoint_hash).not.toBe(base.checkpoint_hash);
  });

  it('队列/订阅/任务计数变化 → checkpoint hash 变化', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);

    for (const mutate of [
      (c: typeof capture) => void c.queues.push({ name: 'judge_run', state: 'failed', count: 3 }),
      (c: typeof capture) =>
        void c.subscription_checkpoints.push({
          subscriber_id: 's1',
          subscriber_version: 1,
          status: 'active',
          next_delivery_seq: 5,
        }),
      (c: typeof capture) =>
        void c.subscription_deliveries.push({ subscriber_id: 's1', status: 'pending', count: 2 }),
      (c: typeof capture) =>
        void c.ai_task_runs.push({ task_kind: 'semantic_judge', status: 'running', count: 1 }),
      (c: typeof capture) => {
        c.environment.migrations_applied = 105;
      },
    ]) {
      const mutated = structuredClone(capture);
      mutate(mutated);
      const mutatedManifest = buildMigrationManifest(mutated, classification, OPTIONS);
      expect(mutatedManifest.checkpoint_hash).not.toBe(base.checkpoint_hash);
    }
  });

  it('provenance（git sha / 镜像 / 迁移文件数 / 脱敏模式）变化 → checkpoint hash 变化', () => {
    const capture = seededCapture();
    const classification = classifyMigrationCapture(capture);
    const base = buildMigrationManifest(capture, classification, OPTIONS);
    for (const override of [
      { git_sha: 'deadbeef' },
      { app_image: 'app:v2' },
      { worker_image: 'worker:v2' },
      { migration_files: 43 },
      { redaction: { applied: true, fields: ['x'] } },
    ]) {
      const manifest = buildMigrationManifest(capture, classification, { ...OPTIONS, ...override });
      expect(manifest.checkpoint_hash).not.toBe(base.checkpoint_hash);
    }
  });
});

describe('P1-2 — 分类输出随清单持久化', () => {
  it('manifest.classification 携带完整 records/unresolved/deferred_replay + 版本与哈希', () => {
    const pending = durablePendingEvent({ id: 'p1', runId: 'run-x' });
    const review = answeredReviewEvent({ id: 'run-1' });
    const correct = ev({
      id: 'c1',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'a1',
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: 'x',
        affected_refs: [{ kind: 'question', id: 'q-1' }],
      },
    });
    const attempt = ev({
      id: 'a1',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-1',
      payload: { question_snapshot: SNAPSHOT },
    });
    const base = seededCapture();
    const capture = withEvents(base, [...base.rawFacts.events, pending, review, correct, attempt]);
    const classification = classifyMigrationCapture(capture);
    const manifest = buildMigrationManifest(capture, classification, OPTIONS);

    expect(manifest.classification.classification_version).toBe(CLASSIFICATION_VERSION);
    expect(manifest.classification.records).toHaveLength(classification.records.length);
    expect(manifest.classification.records).toEqual(classification.records);
    expect(manifest.classification.unresolved).toEqual(classification.unresolved);
    expect(manifest.classification.deferred_replay).toEqual(classification.deferred_replay);
    expect(manifest.classification.classification_hash).toHaveLength(64);
    // 计数字段与持久化列表一致。
    expect(manifest.unresolved_count).toBe(manifest.classification.unresolved.length);
    expect(manifest.deferred_replay_count).toBe(manifest.classification.deferred_replay.length);
    // rollup 与 records 自洽。
    const total = Object.values(manifest.classification_rollup).reduce((a, b) => a + b, 0);
    expect(total).toBe(manifest.classification.records.length);
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

  it('event_action_counts 按 action 汇总（完整分区捕获下仍成立）', () => {
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
});

describe('buildCaptureEdges — 确定性', () => {
  it('同输入产出同序边表', () => {
    const edges1 = buildCaptureEdges(seededCapture());
    const edges2 = buildCaptureEdges(seededCapture());
    expect(edges1).toEqual(edges2);
  });
});
