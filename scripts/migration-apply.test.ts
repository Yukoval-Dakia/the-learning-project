import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from '@/core/migration/classify';
import { type ManifestOptions, buildMigrationManifest } from '@/core/migration/manifest';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from '@/core/migration/test-fixtures';
import type { MigrationCapture, MigrationManifest } from '@/core/migration/types';

import { loadMigrationArtifacts } from './migration-apply';

// YUK-1050（review 修订版）— CLI 单元测试（无 DB）：参数面、--target 校验
//（空/残缺 URL 拒绝）、工件身份复算（capture↔manifest 拼装/篡改/
// 脱敏/悬空引用全拒）。

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'yuk1050-cli-'));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROVENANCE: ManifestOptions = {
  tool_version: 'test-capture',
  git_sha: null,
  app_image: null,
  worker_image: null,
  migration_files: 42,
  redaction: { applied: false, fields: [] },
};

/** 与 YUK-1048 同构地构建【自洽】工件：capture → classify → buildMigrationManifest。 */
function coherentFixture(
  modify?: (manifest: MigrationManifest, capture: MigrationCapture) => void,
): {
  capture: MigrationCapture;
  manifest: MigrationManifest;
} {
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
  const manifest = buildMigrationManifest(capture, classification, PROVENANCE);
  if (modify !== undefined) modify(manifest, capture);
  return { capture, manifest };
}

function artifactDir(
  name: string,
  withLatest: boolean,
  modify?: Parameters<typeof coherentFixture>[0],
): string {
  const dir = join(TMP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const { capture, manifest } = coherentFixture(modify);
  writeFileSync(join(dir, 'capture-abcdef123456.json'), `${JSON.stringify(capture)}\n`);
  writeFileSync(join(dir, 'manifest-abcdef123456.json'), JSON.stringify(manifest));
  if (withLatest) {
    writeFileSync(
      join(dir, 'latest.json'),
      `${JSON.stringify(
        {
          checkpoint_hash: manifest.checkpoint_hash,
          capture_file: 'capture-abcdef123456.json',
          manifest_file: 'manifest-abcdef123456.json',
          captured_at: '2026-09-25T00:00:00.000Z',
        },
        null,
        2,
      )}\n`,
    );
  }
  return dir;
}

describe('loadMigrationArtifacts（P1-2 身份复算）', () => {
  it('capture 与 manifest 拼装（换 capture）→ checkpoint 身份复算即拒', () => {
    // manifest 来自 2 事件观测，capture 被替换成【另一次】观测（空 capture）。
    const dir = artifactDir('swapped-capture', true, (_manifest, capture) => {
      const empty = emptyCapture();
      capture.rawFacts = empty.rawFacts;
      capture.queues = empty.queues;
    });
    expect(() => loadMigrationArtifacts(dir)).toThrow(
      /checkpoint 身份复算不符|raw-fact hash 复算不符/,
    );
  });
});
