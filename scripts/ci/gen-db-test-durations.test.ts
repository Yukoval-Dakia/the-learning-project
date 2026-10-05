import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  durationsFromVitestReport,
  findShardArtifactFiles,
  mergeShardFileDurations,
} from './gen-db-test-durations.mjs';

const GENERATOR = path.resolve('scripts/ci/gen-db-test-durations.mjs');

function writeShardArtifact(
  dir: string,
  shard: number,
  fileDurations: Record<string, number>,
  extras: Record<string, unknown> = {},
) {
  const artifactDir = path.join(dir, `db-selector-report-shard-${shard}`);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, `db-execution-${shard}.json`),
    JSON.stringify({
      schema_version: 1,
      partition: 'db',
      shard: `${shard}/4`,
      file_durations: fileDurations,
      ...extras,
    }),
  );
  return artifactDir;
}

describe('durationsFromVitestReport', () => {
  it('records repo-relative wall times from a vitest JSON report', () => {
    const inside = path.join(process.cwd(), 'tests', 'inside.db.test.ts');
    expect(
      durationsFromVitestReport({
        testResults: [
          { name: inside, startTime: 1_000, endTime: 4_500 },
          { name: inside.replace('inside', 'timed'), duration: 2_000 },
          { name: 'not-a-path.db.test.ts' },
          { name: 42, duration: 5 },
        ],
      }),
    ).toEqual({
      'tests/inside.db.test.ts': 3_500,
      'tests/timed.db.test.ts': 2_000,
    });
    expect(durationsFromVitestReport(null)).toEqual({});
  });
});

describe('mergeShardFileDurations (YUK-1024)', () => {
  it('unions per-shard file_durations since each file lands in one shard', () => {
    expect(
      mergeShardFileDurations([
        { file_durations: { 'src/a.db.test.ts': 1_000, 'src/b.db.test.ts': 2_000 } },
        { file_durations: { 'src/c.db.test.ts': 3_000 } },
      ]),
    ).toEqual({
      'src/a.db.test.ts': 1_000,
      'src/b.db.test.ts': 2_000,
      'src/c.db.test.ts': 3_000,
    });
  });

  it('averages a file observed by more than one execution', () => {
    expect(
      mergeShardFileDurations([
        { file_durations: { 'src/a.db.test.ts': 100 } },
        { file_durations: { 'src/a.db.test.ts': 201 } },
      ]),
    ).toEqual({ 'src/a.db.test.ts': 151 });
  });

  it('skips malformed executions and non-finite durations', () => {
    expect(
      mergeShardFileDurations([
        null,
        'garbage',
        { file_durations: 'nope' },
        { file_durations: ['src/array.db.test.ts'] },
        {
          file_durations: {
            'src/ok.db.test.ts': 500,
            'src/nan.db.test.ts': Number.NaN,
            'src/inf.db.test.ts': Number.POSITIVE_INFINITY,
            'src/text.db.test.ts': 'slow',
            '': 10,
          },
        },
      ]),
    ).toEqual({ 'src/ok.db.test.ts': 500 });
    expect(mergeShardFileDurations([])).toEqual({});
  });
});

describe('findShardArtifactFiles (YUK-1024)', () => {
  it('finds executions in gh-download subdirs and flat layouts, plus selections', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-artifact-scan-'));
    try {
      writeShardArtifact(dir, 2, { 'src/b.db.test.ts': 2 });
      writeShardArtifact(dir, 1, { 'src/a.db.test.ts': 1 });
      writeFileSync(
        path.join(dir, 'db-selector-report-shard-1', 'db-selection.json'),
        JSON.stringify({ inventory_files: ['src/a.db.test.ts'] }),
      );
      // A loose flat execution (single-artifact download) is also picked up.
      writeFileSync(path.join(dir, 'db-execution-9.json'), JSON.stringify({ file_durations: {} }));
      // Unrelated JSON siblings are ignored.
      writeFileSync(path.join(dir, 'other.json'), '{}');

      const { executions, selections } = findShardArtifactFiles(dir);
      expect(executions.map((file) => path.basename(file))).toEqual([
        'db-execution-9.json',
        'db-execution-1.json',
        'db-execution-2.json',
      ]);
      expect(selections.map((file) => path.basename(file))).toEqual(['db-selection.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gen-db-test-durations --merge-artifacts (YUK-1024)', () => {
  it('merges shard executions into a sorted baseline keyed by repo-relative paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-artifact-merge-'));
    const out = path.join(dir, 'baseline.json');
    try {
      writeShardArtifact(dir, 1, { 'src/b.db.test.ts': 200, 'src/a.db.test.ts': 100 });
      writeShardArtifact(
        dir,
        2,
        { 'src/c.db.test.ts': 300 },
        {
          github: { run_id: '12345' },
        },
      );
      writeFileSync(
        path.join(dir, 'db-selector-report-shard-2', 'db-selection.json'),
        JSON.stringify({
          inventory_files: ['src/a.db.test.ts', 'src/b.db.test.ts', 'src/c.db.test.ts'],
        }),
      );

      execFileSync(process.execPath, [GENERATOR, '--merge-artifacts', dir, '--out', out]);
      const baseline = JSON.parse(readFileSync(out, 'utf8'));
      expect(baseline.schema_version).toBe(1);
      expect(baseline.source).toContain('gh run 12345');
      expect(baseline.durations).toEqual({
        'src/a.db.test.ts': 100,
        'src/b.db.test.ts': 200,
        'src/c.db.test.ts': 300,
      });
      expect(Object.keys(baseline.durations)).toEqual(
        Object.keys(baseline.durations).sort((a, b) => a.localeCompare(b)),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write a baseline when no execution reports exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-artifact-empty-'));
    const out = path.join(dir, 'baseline.json');
    try {
      expect(() =>
        execFileSync(process.execPath, [GENERATOR, '--merge-artifacts', dir, '--out', out], {
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(() => readFileSync(out, 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
