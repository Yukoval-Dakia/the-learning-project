import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckpointProvenance } from '@/core/migration/checkpoint';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { buildMigrationManifest } from '@/core/migration/manifest';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from '@/core/migration/test-fixtures';

import { writeCaptureArtifacts } from './migration-capture';

// YUK-1048 — CLI 纯函数单测（无 DB：db 客户端在 main() 内惰性构建）。
// 幂等工件写入（checkpoint 内容寻址）用 tmpdir 驱动真实 fs。

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
});
