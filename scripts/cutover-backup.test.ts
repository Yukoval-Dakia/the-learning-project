import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildManifest,
  observedDlqCounts,
  parseCutoverBackupArgs,
  readDlqExport,
  requiredMissing,
  resolveManifestPath,
} from './cutover-backup';

// YUK-1056 — cutover-backup CLI 单测（纯 fs/对象；不触 DB/docker）。

const TMP = mkdtempSync(join(tmpdir(), 'cutover-backup-test-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('parseCutoverBackupArgs', () => {
  it('flags --x=v 与 --x v 双形态 + strict', () => {
    const a = parseCutoverBackupArgs([
      '--capture-dir=/x/cap',
      '--dump',
      '/x/d.dump',
      '--toc-entries=498',
      '--strict',
    ]);
    expect(a.captureDir).toBe('/x/cap');
    expect(a.dump).toBe('/x/d.dump');
    expect(a.tocEntries).toBe('498');
    expect(a.strict).toBe(true);
  });

  it('requiredMissing 枚举必备工件', () => {
    expect(requiredMissing(parseCutoverBackupArgs([]))).toEqual(['manifest', 'dump', 'dlq']);
    expect(
      requiredMissing(parseCutoverBackupArgs(['--manifest=/m.json', '--dump=/d', '--dlq=/q'])),
    ).toEqual([]);
  });
});

describe('dlq export parsing', () => {
  it('数组与 {rows:[]} 双形态 + *_dlq 聚合（非 DLQ 行不计）', () => {
    const arr = join(TMP, 'a.json');
    writeFileSync(
      arr,
      JSON.stringify([
        { name: 'memory_event_ingest_dlq', state: 'created' },
        { name: 'memory_event_ingest_dlq', state: 'created' },
        { name: 'quiz_gen', state: 'failed' },
        { name: 'quiz_verify_dlq', state: 'created' },
      ]),
    );
    const { rows } = readDlqExport(arr);
    expect(rows).toHaveLength(4);
    expect(observedDlqCounts(rows)).toEqual([
      { queue: 'memory_event_ingest_dlq', rows: 2 },
      { queue: 'quiz_verify_dlq', rows: 1 },
    ]);
    const wrapped = join(TMP, 'b.json');
    writeFileSync(wrapped, JSON.stringify({ rows: [{ name: 'x_dlq' }] }));
    expect(readDlqExport(wrapped).rows).toHaveLength(1);
  });
});

describe('resolveManifestPath + buildManifest', () => {
  it('latest.json 解析 + 工件 hash/size 落 manifest + warnings', () => {
    const cap = join(TMP, 'cap');
    const out = join(TMP, 'out');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(cap, { recursive: true });
    const minimalManifest = {
      checkpoint_hash: 'h1',
      raw_fact_hash: { canonical: 'rf', per_partition: {} },
      queues: { by_name_state: [] },
      subscriptions: {},
      blobs: {},
      classification: { unresolved: [] },
      unresolved_count: 0,
      mutable_ops_fields: { excluded_from_fact_hash: ['event.ingest_at'] },
      completeness: { note: 'dispatch_seq 非完整性证明', snapshot_at: 'x' },
      projection_baseline: {},
    };
    writeFileSync(join(cap, 'manifest-h1.json'), JSON.stringify(minimalManifest));
    writeFileSync(join(cap, 'latest.json'), JSON.stringify({ manifest_file: 'manifest-h1.json' }));
    const dumpFile = join(TMP, 'd.dump');
    writeFileSync(dumpFile, 'dumpbytes');
    const dlqFile = join(TMP, 'q.json');
    writeFileSync(dlqFile, JSON.stringify([{ name: 'x_dlq' }]));

    const { manifest, warnings } = buildManifest(
      parseCutoverBackupArgs([
        `--capture-dir=${cap}`,
        `--dump=${dumpFile}`,
        `--dlq=${dlqFile}`,
        `--out=${out}`,
      ]),
    );
    expect(resolveManifestPath(cap, null)).toBe(join(cap, 'manifest-h1.json'));
    expect(manifest.migration.checkpoint_hash).toBe('h1');
    expect(manifest.backup.dump?.bytes).toBe(9); // 'dumpbytes' 是 9 字节
    expect(manifest.backup.dump?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.queues.dlq_tombstones?.rows_exported).toBe(1);
    // 观测缺 DLQ 队列 ⇒ 每行 mismatch=false（truthful，不静默标 true）。
    expect(manifest.queues.dlq_reconciliation.every((r) => r.matches === false)).toBe(true);
    expect(warnings.some((w) => w.startsWith('missing_restore_evidence'))).toBe(true);
  });
});

describe('P1-1 restore evidence 绑定当前 dump', () => {
  const CAP = join(TMP, 'p1cap');
  const DUMP = join(TMP, 'p1.dump');
  const DLQ = join(TMP, 'p1-dlq.json');
  const minimalManifest = {
    checkpoint_hash: 'h1',
    raw_fact_hash: { canonical: 'rf', per_partition: {} },
    queues: { by_name_state: [] },
    subscriptions: {},
    blobs: {},
    classification: { unresolved: [] },
    unresolved_count: 0,
    mutable_ops_fields: { excluded_from_fact_hash: ['event.ingest_at'] },
    completeness: { note: 'dispatch_seq 非完整性证明', snapshot_at: 'x' },
    projection_baseline: {},
  };
  mkdirSync(CAP, { recursive: true });
  writeFileSync(join(CAP, 'manifest-h1.json'), JSON.stringify(minimalManifest));
  writeFileSync(join(CAP, 'latest.json'), JSON.stringify({ manifest_file: 'manifest-h1.json' }));
  writeFileSync(DUMP, 'dumpbytes');
  writeFileSync(DLQ, JSON.stringify([{ name: 'x_dlq' }]));
  const dumpSha = createHash('sha256').update('dumpbytes').digest('hex');

  const writeEvidence = (name: string, body: Record<string, unknown>): string => {
    const p = join(TMP, name);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };

  const build = (evi: string) =>
    buildManifest(
      parseCutoverBackupArgs([
        `--capture-dir=${CAP}`,
        `--dump=${DUMP}`,
        `--dlq=${DLQ}`,
        `--restore-evidence=${evi}`,
      ]),
    );

  it('matched: nested dump.sha256 等于所选 dump ⇒ 接受并读 nested toc_entries', () => {
    const evi = writeEvidence('evi-match.json', {
      verified: true,
      container: 'loom-restore-drill-x',
      dump: { file: DUMP, sha256: dumpSha, bytes: 9, toc_entries: 42 },
      table_counts: { 'public.event': 3 },
    });
    const { manifest, warnings } = build(evi);
    expect(manifest.backup.dump?.sha256).toBe(dumpSha);
    expect(manifest.backup.restore_evidence?.verified).toBe(true);
    expect(manifest.backup.restore_evidence?.toc_entries).toBe(42);
    expect(warnings.some((w) => w.startsWith('restore_evidence_unverified'))).toBe(false);
  });

  it('mismatched: nested dump.sha256 ≠ 所选 dump ⇒ 硬错误并点名两个 hash', () => {
    const other = 'a'.repeat(64);
    const evi = writeEvidence('evi-mismatch.json', {
      verified: true,
      container: 'loom-restore-drill-y',
      dump: { file: '/elsewhere/other.dump', sha256: other },
      table_counts: {},
    });
    let err: Error | null = null;
    try {
      build(evi);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err?.message).toContain(other);
    expect(err?.message).toContain(dumpSha);
  });

  it('missing nested dump.sha256 ⇒ 硬错误（无法绑定，不得凭顶层 verified 冒充）', () => {
    const evi = writeEvidence('evi-nosha.json', {
      verified: true,
      container: 'loom-restore-drill-z',
      table_counts: {},
    });
    expect(() => build(evi)).toThrow(/dump\.sha256/);
  });
});
