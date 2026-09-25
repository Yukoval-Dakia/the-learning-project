import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from '@/core/migration/test-fixtures';
import type { MigrationManifest } from '@/core/migration/types';
import { applyReportFileName } from '@/server/migration/apply';
import { type ApplyCliArgs, loadMigrationArtifacts, parseApplyArgs } from './migration-apply';

// YUK-1050 — CLI 单元测试（无 DB）：参数面、工件身份复算（篡改即拒）、
// latest 指针与单工件目录两种装载形态。

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'yuk1050-cli-'));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifestFixture(): MigrationManifest {
  const capture = withEvents(emptyCapture(), [
    ev({
      id: 'att-1',
      action: 'attempt',
      subject_id: 'q-1',
      outcome: 'failure',
      payload: {
        answer_md: '3',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-1'],
        question_snapshot: SNAPSHOT,
      },
    }),
    judgeEvent({
      id: 'jud-1',
      subject_id: 'att-1',
      payload: { coarse_outcome: 'incorrect', score: 0 },
    }),
  ]);
  const classification = classifyMigrationCapture(capture);
  return {
    manifest_version: 1,
    tool: { name: 'migration-capture', version: 'test' },
    checkpoint_hash: 'chk-abcdef1234567890',
    source: {
      git_sha: null,
      app_image: null,
      worker_image: null,
      captured_at: '2026-09-25T00:00:00.000Z',
      isolation: 'repeatable read read only',
      db: {
        server_version: '17.0',
        database_name: 'loom_test',
        host_fingerprint: 'abc',
        migrations_applied: 42,
        migration_files: 42,
        migration_drift: 'in_sync',
      },
      pgboss_schema_present: false,
    },
    redaction: { applied: false, fields: [] },
    semantic_counts: [],
    event_action_counts: [],
    raw_fact_hash: { canonical: 'rf', per_partition: {} },
    edge_hash: { digest: 'edge', edge_count: 0 },
    mutable_ops_fields: {
      excluded_from_fact_hash: [],
      event_ingest_at_present: 0,
      state_updated_at_max: {},
    },
    projection_baseline: {},
    queues: { pgboss_schema_present: false, by_name_state: [], dlq_total: 0 },
    subscriptions: { checkpoints: [], delivery_by_status: [] },
    blobs: {
      source_assets: [],
      source_documents: 0,
      question_image_refs_total: 0,
      answer_image_refs_total: 0,
    },
    classification: {
      classification_version: 'test-classifier',
      classification_hash: canonicalHash({
        classification_version: 'test-classifier',
        records: classification.records,
        unresolved: classification.unresolved,
        deferred_replay: classification.deferred_replay,
      }),
      records: classification.records,
      unresolved: classification.unresolved,
      deferred_replay: classification.deferred_replay,
    },
    classification_rollup: classification.rollup,
    unresolved_count: classification.unresolved.length,
    deferred_replay_count: classification.deferred_replay.length,
    completeness: {
      max_dispatch_seq: null,
      captured_event_rows: 2,
      note: 'test',
      snapshot_at: '2026-09-25T00:00:00.000Z',
    },
  } as unknown as MigrationManifest;
}

function artifactDir(name: string, withLatest: boolean): string {
  const dir = join(TMP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const manifest = manifestFixture();
  // 文件名 = YUK-1048 内容寻址形态：capture-<hash12>.json（hash12 为 hex）。
  writeFileSync(join(dir, 'capture-abcdef123456.json'), `${JSON.stringify(emptyCapture())}\n`);
  writeFileSync(join(dir, 'manifest-abcdef123456.json'), JSON.stringify(manifest));
  if (withLatest) {
    writeFileSync(
      join(dir, 'latest.json'),
      `${JSON.stringify({ checkpoint_hash: 'chk-abcdef1234567890', capture_file: 'capture-abcdef123456.json', manifest_file: 'manifest-abcdef123456.json', captured_at: '2026-09-25T00:00:00.000Z' }, null, 2)}\n`,
    );
  }
  return dir;
}

describe('parseApplyArgs', () => {
  it('解析必选/可选旗标，batch-size 容错', () => {
    const args = parseApplyArgs([
      '--artifacts=/tmp/a',
      '--target=postgres://x/y?sslmode=disable',
      '--revisions=/tmp/reg.json',
      '--confirm-write',
      '--batch-size=50',
    ]);
    expect(args).toMatchObject({
      artifacts: '/tmp/a',
      target: 'postgres://x/y?sslmode=disable',
      revisions: '/tmp/reg.json',
      dryRun: false,
      confirmWrite: true,
      batchSize: 50,
    });
    expect(parseApplyArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseApplyArgs(['--batch-size=NaN']).batchSize).toBe(200);
  });
});

describe('loadMigrationArtifacts', () => {
  it('经 latest.json 指针装载并复算分类身份', () => {
    const dir = artifactDir('with-latest', true);
    const loaded = loadMigrationArtifacts(dir);
    expect(loaded.manifest.checkpoint_hash).toBe('chk-abcdef1234567890');
    expect(loaded.capture.capture_schema_version).toBe(1);
  });

  it('无 latest.json 的单一工件目录也可装载', () => {
    const dir = artifactDir('no-latest', false);
    expect(loadMigrationArtifacts(dir).manifest.manifest_version).toBe(1);
  });

  it('classification 被篡改 → 复算不符即拒', () => {
    const dir = artifactDir('tampered', true);
    const manifestPath = join(dir, 'manifest-abcdef123456.json');
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      classification: { records: Array<{ reason: string }> };
    };
    const first = raw.classification.records[0];
    if (first === undefined) throw new Error('fixture classification records empty');
    first.reason = 'tampered';
    writeFileSync(manifestPath, JSON.stringify(raw));
    expect(() => loadMigrationArtifacts(dir)).toThrow(/classification_hash 复算不符/);
  });

  it('空目录 / 指针指向缺失工件 → 拒绝', () => {
    const dir = join(TMP_ROOT, 'empty');
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    expect(() => loadMigrationArtifacts(dir)).toThrow(/无 latest.json 也无 capture/);
    const dir2 = join(TMP_ROOT, 'dangling');
    mkdirSync(dir2, { recursive: true });
    dirs.push(dir2);
    writeFileSync(
      join(dir2, 'latest.json'),
      JSON.stringify({
        checkpoint_hash: 'x',
        capture_file: 'capture-nope.json',
        manifest_file: 'manifest-nope.json',
      }),
    );
    expect(() => loadMigrationArtifacts(dir2)).toThrow(/指向的工件不存在/);
  });
});

describe('applyReportFileName', () => {
  it('run id 内容寻址文件名', () => {
    expect(applyReportFileName('run-abc123')).toBe('apply-report-run-abc123.json');
  });
});

describe('CLI 安全纪律（纯参数面）', () => {
  it('target 必填（无 DATABASE_URL 回退由 runMigrationApplyCli 强制 —— 这里钉 flag 面）', () => {
    const args: ApplyCliArgs = parseApplyArgs(['--artifacts=/tmp/a']);
    expect(args.target).toBeNull();
    expect(args.confirmWrite).toBe(false);
  });
});
