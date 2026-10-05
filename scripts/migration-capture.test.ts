import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { CheckpointProvenance } from '@/core/migration/checkpoint';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { buildMigrationManifest } from '@/core/migration/manifest';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from '@/core/migration/test-fixtures';

import { describeTarget, parseCaptureArgs, writeCaptureArtifacts } from './migration-capture';

// YUK-1048 — CLI 纯函数单测（无 DB：db 客户端在 main() 内惰性构建）。
// 幂等工件写入（checkpoint 内容寻址，review P1-1/P2-B）用 tmpdir 驱动真实 fs。

function tmpOut(): string {
  return mkdtempSync(join(tmpdir(), 'yuk1048-capture-'));
}

const PROVENANCE: CheckpointProvenance = {
  tool_version: 'test',
  git_sha: null,
  app_image: null,
  worker_image: null,
  migration_files: null,
  redaction: { applied: false, fields: [] },
};

function artifacts(mutate?: (capture: ReturnType<typeof baseCapture>) => void) {
  const capture = baseCapture();
  mutate?.(capture);
  const manifest = buildMigrationManifest(capture, classifyMigrationCapture(capture), PROVENANCE);
  return { capture, manifest };
}

function baseCapture() {
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
    payload: { judge_route: 'exact', coarse_outcome: 'correct', score: 1 },
  });
  return withEvents(emptyCapture(), [attempt, judge]);
}

describe('parseCaptureArgs', () => {
  it('解析 --out/--target 与布尔 --redact（含空格形式）', () => {
    expect(parseCaptureArgs(['--out', '/tmp/x', '--target', 'postgres://u:p@h:5/db'])).toEqual({
      out: '/tmp/x',
      target: 'postgres://u:p@h:5/db',
      redact: false,
      appImage: null,
      workerImage: null,
      gitSha: null,
    });
    expect(
      parseCaptureArgs([
        '--out=/tmp/y',
        '--redact',
        '--app-image=app:1',
        '--worker-image=worker:1',
        '--git-sha=abc',
      ]),
    ).toMatchObject({
      out: '/tmp/y',
      redact: true,
      appImage: 'app:1',
      workerImage: 'worker:1',
      gitSha: 'abc',
    });
  });

  it('缺省为 null（main 拒绝缺 --out / 无 target）', () => {
    const args = parseCaptureArgs([]);
    expect(args.out).toBeNull();
    expect(args.target).toBeNull();
    expect(args.redact).toBe(false);
  });
});

describe('describeTarget', () => {
  it('只暴露 host/port/db，绝不包含凭证', () => {
    const described = describeTarget(
      'postgres://secret-user:super-secret@db.example.com:5433/loom?sslmode=require',
    );
    expect(described).toBe('db.example.com:5433/loom');
    expect(described).not.toContain('secret');
  });

  it('不可解析 URL 也不抛凭证', () => {
    expect(describeTarget('not a url')).toBe('(unparseable-url)');
  });
});

describe('writeCaptureArtifacts — checkpoint 内容寻址幂等（P1-1/P1-2/P2-B）', () => {
  it('同观测重跑 → already-present/unchanged，目录不新增重复工件', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();

    const first = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(first.captureStatus).toBe('written');
    expect(first.manifestStatus).toBe('written');
    expect(first.latestStatus).toBe('written');

    // 第二次：快照时刻不同（模拟重跑），观测相同 → 同 checkpoint 文件名。
    const rerunCapture = structuredClone(capture);
    rerunCapture.environment.snapshot_at = '2027-01-01T00:00:00.000Z';
    const rerunManifest = buildMigrationManifest(
      rerunCapture,
      classifyMigrationCapture(rerunCapture),
      PROVENANCE,
    );
    const second = writeCaptureArtifacts(outDir, rerunCapture, rerunManifest, PROVENANCE);
    expect(second.checkpointHash).toBe(first.checkpointHash);
    expect(second.captureStatus).toBe('already-present');
    expect(second.manifestStatus).toBe('already-present');
    expect(second.latestStatus).toBe('unchanged');

    const hash12 = first.checkpointHash.slice(0, 12);
    const files = readdirSync(outDir).sort();
    expect(files).toEqual(
      [`capture-${hash12}.json`, 'latest.json', `manifest-${hash12}.json`].sort(),
    );
    // 首见观测胜出：capture 保持第一次的快照时刻。
    const stored = JSON.parse(readFileSync(join(outDir, second.captureFile), 'utf8')) as {
      environment: { snapshot_at: string };
    };
    expect(stored.environment.snapshot_at).toBe(capture.environment.snapshot_at);
  });

  it('P1-1：运维态变化（ops/queues）→ 新 checkpoint 工件，旧工件保留', () => {
    const outDir = tmpOut();
    const base = artifacts();
    const first = writeCaptureArtifacts(outDir, base.capture, base.manifest, PROVENANCE);
    expect(first.captureStatus).toBe('written');

    const { capture, manifest } = artifacts((c) => {
      c.ops.event_ingest_at = [{ event_id: 'a1', ingest_at: '2026-09-26T00:00:00.000Z' }];
    });
    const second = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(second.checkpointHash).not.toBe(first.checkpointHash);
    expect(second.captureStatus).toBe('written');
    expect(readdirSync(outDir)).toHaveLength(5); // 2×capture + 2×manifest + latest
    const pointer = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')) as {
      checkpoint_hash: string;
    };
    expect(pointer.checkpoint_hash).toBe(second.checkpointHash);
  });

  it('P1-1：损坏/身份不符的既有工件被验证重写（repaired），不盲跳过', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();
    const first = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(first.captureStatus).toBe('written');

    // 破坏已落盘的 capture 工件（换内容）。
    writeFileSync(join(outDir, first.captureFile), '{"corrupted":true}');

    const second = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(second.captureStatus).toBe('repaired');
    const restored = JSON.parse(readFileSync(join(outDir, second.captureFile), 'utf8')) as {
      rawFacts: unknown;
    };
    expect(restored.rawFacts).toBeDefined();
  });

  it('P1-2：同 checkpoint、分类输出变化 → manifest 被刷新（refreshed）', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();
    const first = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(first.manifestStatus).toBe('written');

    // 同观测、分类器产出不同（模拟分类版本改进：篡改 records 一条 reason）。
    const refreshedManifest = structuredClone(manifest);
    refreshedManifest.classification.records[0].reason = '改进后的分类解释';
    refreshedManifest.classification.classification_hash = 'changed-by-new-classifier';
    const second = writeCaptureArtifacts(outDir, capture, refreshedManifest, PROVENANCE);
    expect(second.checkpointHash).toBe(first.checkpointHash);
    expect(second.captureStatus).toBe('already-present'); // 观测不动
    expect(second.manifestStatus).toBe('refreshed'); // 分类持久化更新
    const stored = JSON.parse(readFileSync(join(outDir, second.manifestFile), 'utf8')) as {
      classification: { records: Array<{ reason: string }> };
    };
    expect(stored.classification.records[0].reason).toBe('改进后的分类解释');
  });

  it('P2-A：篡改 records 但保留哈希字段的 manifest ⇒ 重算拒绝（repaired），不盲接受', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();
    const first = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(first.manifestStatus).toBe('written');

    // 篡改：修改 records 内容但保留 classification_hash / checkpoint_hash 字段。
    const stored = JSON.parse(
      readFileSync(join(outDir, first.manifestFile), 'utf8'),
    ) as typeof manifest;
    stored.classification.records[0].reason = 'TAMPERED';
    writeFileSync(join(outDir, first.manifestFile), `${JSON.stringify(stored)}\n`);

    const second = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(second.checkpointHash).toBe(first.checkpointHash);
    expect(second.captureStatus).toBe('already-present');
    expect(second.manifestStatus).toBe('repaired'); // 重算分类哈希与自述不符 ⇒ 重写
    const restored = JSON.parse(readFileSync(join(outDir, second.manifestFile), 'utf8')) as {
      classification: { records: Array<{ reason: string }> };
    };
    expect(restored.classification.records[0].reason).not.toBe('TAMPERED');
  });

  it('P2-A：latest 指针文件名被篡改 ⇒ 重写为派生名', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();
    const first = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    writeFileSync(
      join(outDir, 'latest.json'),
      `${JSON.stringify({ checkpoint_hash: first.checkpointHash, capture_file: 'evil.json', manifest_file: 'evil.json' })}\n`,
    );
    const second = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(second.latestStatus).toBe('written');
    const pointer = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')) as {
      capture_file: string;
    };
    expect(pointer.capture_file).toBe(first.captureFile);
  });

  it('不可变事实变化 → 新 checkpoint 工件并存，latest 前移，旧工件保留', () => {
    const outDir = tmpOut();
    const base = artifacts();
    const first = writeCaptureArtifacts(outDir, base.capture, base.manifest, PROVENANCE);
    expect(first.captureStatus).toBe('written');

    const { capture, manifest } = artifacts((c) => {
      c.rawFacts.events[0].payload = { answer_md: '3', question_snapshot: SNAPSHOT };
    });
    const second = writeCaptureArtifacts(outDir, capture, manifest, PROVENANCE);
    expect(second.checkpointHash).not.toBe(first.checkpointHash);
    expect(second.captureStatus).toBe('written');
    expect(readdirSync(outDir)).toHaveLength(5);
    const pointer = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')) as {
      checkpoint_hash: string;
    };
    expect(pointer.checkpoint_hash).toBe(second.checkpointHash);
  });
});
