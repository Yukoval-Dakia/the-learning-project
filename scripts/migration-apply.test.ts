import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { type ManifestOptions, buildMigrationManifest } from '@/core/migration/manifest';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from '@/core/migration/test-fixtures';
import type { MigrationCapture, MigrationManifest } from '@/core/migration/types';
import { applyReportFileName } from '@/server/migration/apply';

import {
  type ApplyCliArgs,
  applyTargetSsl,
  isLoopbackHost,
  loadMigrationArtifacts,
  parseApplyArgs,
  validateTargetUrl,
} from './migration-apply';

// YUK-1050（review 修订版）— CLI 单元测试（无 DB）：参数面、--target 校验
//（P1-8：空/残缺 URL 拒绝）、工件身份复算（P1-2：capture↔manifest 拼装/篡改/
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

describe('validateTargetUrl（P1-8）', () => {
  it('接受完整 postgres URL', () => {
    expect(validateTargetUrl('postgres://loom:loom@127.0.0.1:5432/loom?sslmode=disable')).toContain(
      'loom',
    );
    expect(validateTargetUrl('postgresql://db.example.com/prod')).toContain('prod');
  });

  it('拒绝空串/残缺/非 postgres 协议 —— 不给驱动留静默回退空间', () => {
    expect(() => validateTargetUrl(null)).toThrow(/--target/);
    expect(() => validateTargetUrl('')).toThrow(/--target/);
    expect(() => validateTargetUrl('   ')).toThrow(/--target/);
    expect(() => validateTargetUrl('postgres://')).toThrow(/host/);
    expect(() => validateTargetUrl('postgres://host/')).toThrow(/database/);
    expect(() => validateTargetUrl('http://host/db')).toThrow(/postgres/);
    expect(() => validateTargetUrl('not a url')).toThrow(/URL/);
  });
});

describe('loadMigrationArtifacts（P1-2 身份复算）', () => {
  it('自洽工件（capture↔manifest 同源）经 latest 指针装载', () => {
    const dir = artifactDir('coherent', true);
    const loaded = loadMigrationArtifacts(dir);
    expect(loaded.manifest.checkpoint_hash).toBeTruthy();
    expect(loaded.capture.capture_schema_version).toBe(1);
  });

  it('无 latest.json 的单一工件目录也可装载', () => {
    const dir = artifactDir('no-latest', false);
    expect(loadMigrationArtifacts(dir).manifest.manifest_version).toBe(1);
  });

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

  it('manifest 被篡改（classification 记录改动而哈希保留）→ 复算不符即拒', () => {
    const dir = artifactDir('tampered', true, (manifest) => {
      const records = (manifest as { classification: { records: Array<{ reason: string }> } })
        .classification.records;
      const first = records[0];
      if (first === undefined) throw new Error('fixture classification empty');
      first.reason = 'tampered';
    });
    expect(() => loadMigrationArtifacts(dir)).toThrow(/classification_hash 复算不符/);
  });

  it('脱敏工件（redaction.applied）→ 拒绝（占位内容无法忠实重建）', () => {
    const dir = artifactDir('redacted', true, (manifest) => {
      manifest.redaction = { applied: true, fields: ['learner_text'] };
    });
    expect(() => loadMigrationArtifacts(dir)).toThrow(/脱敏/);
  });

  it('latest 指针 checkpoint 与 manifest 不符 → 拒绝', () => {
    const dir = artifactDir('dangling-pointer', true);
    const pointerPath = join(dir, 'latest.json');
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { checkpoint_hash: string };
    pointer.checkpoint_hash = 'sha256-different';
    writeFileSync(pointerPath, JSON.stringify(pointer));
    expect(() => loadMigrationArtifacts(dir)).toThrow(/指针 checkpoint 与 manifest 不符/);
  });

  it('分类记录引用 capture 外的 source → 拒绝（classification 与 capture 不同源）', () => {
    const dir = artifactDir('dangling-source', true, (manifest) => {
      const m = manifest as unknown as {
        classification: { records: Array<{ source_id: string }>; classification_hash: string };
      };
      m.classification.records = [
        ...m.classification.records,
        { source_id: 'evt-not-in-capture' } as (typeof m.classification.records)[number],
      ];
      // 保留原哈希（模拟篡改）或重算 —— 两种都在装载被拒：先 hash 复算命中重算分支。
      m.classification.classification_hash = canonicalHash({
        classification_version: manifest.classification.classification_version,
        records: m.classification.records,
        unresolved: manifest.classification.unresolved,
        deferred_replay: manifest.classification.deferred_replay,
      });
    });
    expect(() => loadMigrationArtifacts(dir)).toThrow(/capture 中不存在的 source/);
  });

  it('空目录 / 指针指向缺失工件 → 拒绝', () => {
    const dir = join(TMP_ROOT, 'empty');
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    expect(() => loadMigrationArtifacts(dir)).toThrow(/无 latest.json 也无 capture/);
    const dir2 = join(TMP_ROOT, 'dangling-files');
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

describe('CLI 安全纪律（参数面）', () => {
  it('target 必填；dry-run 也需要有效 target（preflight 读库）', () => {
    const args: ApplyCliArgs = parseApplyArgs(['--artifacts=/tmp/a', '--dry-run']);
    expect(() => validateTargetUrl(args.target)).toThrow(/--target/);
    expect(args.confirmWrite).toBe(false);
  });
});

describe('applyTargetSsl（YUK-1100 review P1：hostname 精确判定，不做全串 includes）', () => {
  it('loopback 主机（localhost/127.x/::1/.localhost 后缀）走明文', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('db.localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.9.9.9')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(applyTargetSsl('postgres://loom:loom@localhost:5432/loom')).toBe(false);
    expect(applyTargetSsl('postgres://loom:loom@127.0.0.1:5433/loom')).toBe(false);
    expect(applyTargetSsl('postgres://loom:loom@[::1]:5432/loom')).toBe(false);
    expect(applyTargetSsl('postgres://loom:loom@nas.local:5432/loom')).toBe('require');
  });

  it('URL 非 hostname 位置出现 localhost 不触发裸连（password/dbname/application_name）', () => {
    // 密码含 'localhost'：对远端主机仍 require —— 旧 includes 实现会误判裸连。
    expect(applyTargetSsl('postgres://loom:localhost@db.example.com:5432/loom')).toBe('require');
    // 库名含 'localhost'：同理不降级。
    expect(applyTargetSsl('postgres://loom:x@db.example.com:5432/localhost-mirror')).toBe(
      'require',
    );
    // 查询参数值含 'localhost'（非 sslmode）：不降级。
    expect(
      applyTargetSsl('postgres://loom:x@db.example.com:5432/loom?application_name=localhost-drill'),
    ).toBe('require');
    // 密码含 '127.0.0.1'：同理不降级。
    expect(applyTargetSsl('postgres://loom:127.0.0.1@db.example.com/loom')).toBe('require');
  });

  it('显式 sslmode=disable 查询参数仍走明文；sslmode 只在参数位生效', () => {
    expect(applyTargetSsl('postgres://u:p@db.example.com/loom?sslmode=disable')).toBe(false);
    expect(applyTargetSsl('postgres://u:p@db.example.com/loom?foo=1&sslmode=disable')).toBe(false);
    // 'sslmode=disable' 出现在密码里不算参数 —— 不降级。
    expect(applyTargetSsl('postgres://u:sslmode=disable@db.example.com/loom')).toBe('require');
    expect(applyTargetSsl('postgres://u:p@localhost/loom?sslmode=disable')).toBe(false);
  });

  it('无法解析的 URL 保守取 require（validateTargetUrl 在前拒绝，此为双保险）', () => {
    expect(applyTargetSsl('not a url')).toBe('require');
  });
});
