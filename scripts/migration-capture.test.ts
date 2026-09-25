import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from '@/core/migration/classify';
import { buildMigrationManifest } from '@/core/migration/manifest';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from '@/core/migration/test-fixtures';

import { describeTarget, parseCaptureArgs, writeCaptureArtifacts } from './migration-capture';

// YUK-1048 — CLI 纯函数单测（无 DB：db 客户端在 main() 内惰性构建）。
// 幂等工件写入（内容寻址）用 tmpdir 驱动真实 fs。tmpdir 由 OS 回收，不清理。

function tmpOut(): string {
  return mkdtempSync(join(tmpdir(), 'yuk1048-capture-'));
}

function artifacts() {
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
  const capture = withEvents(emptyCapture(), [attempt, judge]);
  const manifest = buildMigrationManifest(capture, classifyMigrationCapture(capture), {
    tool_version: 'test',
    git_sha: null,
    app_image: null,
    worker_image: null,
    migration_files: null,
    redaction: { applied: false, fields: [] },
  });
  return { capture, manifest };
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

describe('writeCaptureArtifacts — 内容寻址幂等', () => {
  it('同事实重复写入 → already-present/unchanged，目录不新增重复工件', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();

    const first = writeCaptureArtifacts(outDir, capture, manifest);
    expect(first.captureStatus).toBe('written');
    expect(first.manifestStatus).toBe('written');
    expect(first.latestStatus).toBe('written');

    // 第二次：快照时刻不同（模拟重跑），但事实相同 → 同 hash 文件名。
    const rerunManifest = {
      ...manifest,
      source: { ...manifest.source, captured_at: '2027-01-01T00:00:00.000Z' },
    };
    const second = writeCaptureArtifacts(outDir, capture, rerunManifest);
    expect(second.rawFactHash).toBe(first.rawFactHash);
    expect(second.captureStatus).toBe('already-present');
    expect(second.manifestStatus).toBe('already-present');
    expect(second.latestStatus).toBe('unchanged');

    const hash12 = first.rawFactHash.slice(0, 12);
    const files = readdirSync(outDir).sort();
    expect(files).toEqual(
      [`capture-${hash12}.json`, 'latest.json', `manifest-${hash12}.json`].sort(),
    );
    // 首见观测胜出：manifest 的 captured_at 保持第一次的值。
    const stored = JSON.parse(readFileSync(join(outDir, second.manifestFile), 'utf8')) as {
      source: { captured_at: string };
    };
    expect(stored.source.captured_at).toBe(manifest.source.captured_at);
  });

  it('事实变化 → 新 hash 工件并存，latest 指针前移，旧工件保留', () => {
    const outDir = tmpOut();
    const { capture, manifest } = artifacts();
    const first = writeCaptureArtifacts(outDir, capture, manifest);

    const changedCapture = structuredClone(capture);
    changedCapture.rawFacts.events[0].payload = { answer_md: '3', question_snapshot: SNAPSHOT };
    const changedManifest = buildMigrationManifest(
      changedCapture,
      classifyMigrationCapture(changedCapture),
      {
        tool_version: 'test',
        git_sha: null,
        app_image: null,
        worker_image: null,
        migration_files: null,
        redaction: { applied: false, fields: [] },
      },
    );
    const second = writeCaptureArtifacts(outDir, changedCapture, changedManifest);
    expect(second.rawFactHash).not.toBe(first.rawFactHash);
    expect(second.captureStatus).toBe('written');

    const files = readdirSync(outDir).sort();
    expect(files).toHaveLength(5); // 2×capture + 2×manifest + latest
    const pointer = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')) as {
      raw_fact_hash: string;
    };
    expect(pointer.raw_fact_hash).toBe(second.rawFactHash);
  });
});
