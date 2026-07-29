import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DB_FAILURE_SENTINEL_TESTS,
  affectedCliBytes,
  affectedFilesFitCli,
  findDirectChangedDbTestMisses,
  findDynamicImportDbTests,
  findSourceScanningDbTests,
  mergeDbPredictedFiles,
  parseShard,
  resolveRequiredDbFiles,
  scanDbTestSources,
  shouldSkipAffectedShard,
} from './db-affected.mjs';

describe('DB affected-test selector', () => {
  it('keeps real out-of-graph failed-head regressions as explicit sentinels', () => {
    expect(DB_FAILURE_SENTINEL_TESTS).toEqual([
      'src/capabilities/knowledge/server/propose_edge.db.test.ts',
      'src/server/boss/handlers/quiz_gen.test.ts',
    ]);
    expect(
      mergeDbPredictedFiles({
        graphPredictedFiles: ['src/feature.db.test.ts'],
        sourceScanningDbTests: ['src/scanner.db.test.ts'],
        dynamicImportDbTests: ['src/dynamic.db.test.ts'],
        dbFiles: [
          'src/dynamic.db.test.ts',
          'src/feature.db.test.ts',
          'src/scanner.db.test.ts',
          ...DB_FAILURE_SENTINEL_TESTS,
        ],
      }),
    ).toEqual({
      predictedFiles: [
        'src/capabilities/knowledge/server/propose_edge.db.test.ts',
        'src/dynamic.db.test.ts',
        'src/feature.db.test.ts',
        'src/scanner.db.test.ts',
        'src/server/boss/handlers/quiz_gen.test.ts',
      ],
      failureSentinelTests: DB_FAILURE_SENTINEL_TESTS,
      missingFailureSentinelTests: [],
    });
  });

  it('reports a missing failure sentinel instead of silently dropping the guard', () => {
    expect(
      mergeDbPredictedFiles({
        graphPredictedFiles: ['src/feature.db.test.ts'],
        sourceScanningDbTests: [],
        dynamicImportDbTests: [],
        dbFiles: ['src/feature.db.test.ts'],
      }),
    ).toMatchObject({
      missingFailureSentinelTests: DB_FAILURE_SENTINEL_TESTS,
    });
  });

  it('preserves DB tests that scan source files outside the Vitest import graph', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'db-source-scan-'));
    try {
      mkdirSync(path.join(repo, 'src'));
      writeFileSync(
        path.join(repo, 'src', 'scanner.db.test.ts'),
        "import { readFileSync } from 'node:fs';\nreadFileSync('src/schema.ts', 'utf8');\n",
      );
      writeFileSync(path.join(repo, 'src', 'ordinary.db.test.ts'), "import './feature';\n");

      expect(
        findSourceScanningDbTests({
          root: repo,
          dbFiles: ['src/scanner.db.test.ts', 'src/ordinary.db.test.ts'],
        }),
      ).toEqual(['src/scanner.db.test.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves DB tests whose production dependency is loaded dynamically', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'db-dynamic-import-'));
    try {
      mkdirSync(path.join(repo, 'src'));
      writeFileSync(
        path.join(repo, 'src', 'dynamic.db.test.ts'),
        "const actual = await vi.importActual<typeof import('./feature')>('./feature');\n",
      );
      writeFileSync(path.join(repo, 'src', 'ordinary.db.test.ts'), "import './feature';\n");

      expect(
        findDynamicImportDbTests({
          root: repo,
          dbFiles: ['src/dynamic.db.test.ts', 'src/ordinary.db.test.ts'],
        }),
      ).toEqual(['src/dynamic.db.test.ts']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scans each DB test source once for both out-of-graph patterns', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'db-source-sentinels-'));
    try {
      mkdirSync(path.join(repo, 'src'));
      writeFileSync(
        path.join(repo, 'src', 'both.db.test.ts'),
        "import { readFileSync } from 'node:fs';\nawait import('./feature');\n",
      );

      expect(
        scanDbTestSources({
          root: repo,
          dbFiles: ['src/both.db.test.ts'],
        }),
      ).toEqual({
        sourceScanningDbTests: ['src/both.db.test.ts'],
        dynamicImportDbTests: ['src/both.db.test.ts'],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects unsafe DB inventory paths before reading source', () => {
    expect(() =>
      scanDbTestSources({
        root: tmpdir(),
        dbFiles: ['../outside.db.test.ts'],
      }),
    ).toThrow('unsafe DB test inventory path');
  });

  it('returns a sorted affected DB file list only for a valid DB selection', () => {
    expect(
      resolveRequiredDbFiles({
        schema_version: 1,
        partition: 'db',
        requested_mode: 'affected',
        effective_mode: 'affected',
        base: 'abc',
        changed_files: ['src/feature.ts'],
        predicted_files: ['src/z.db.test.ts', 'src/a.test.ts', 'src/z.db.test.ts'],
      }),
    ).toEqual(['src/a.test.ts', 'src/z.db.test.ts']);
  });

  it.each([
    undefined,
    {
      schema_version: 1 as const,
      partition: 'db' as const,
      requested_mode: 'full' as const,
      effective_mode: 'full' as const,
      base: 'abc',
      changed_files: [],
      predicted_files: null,
    },
    {
      schema_version: 1 as const,
      partition: 'unit' as const,
      requested_mode: 'affected' as const,
      effective_mode: 'affected' as const,
      base: 'abc',
      changed_files: [],
      predicted_files: ['src/a.test.ts'],
    },
    {
      schema_version: 1 as const,
      partition: 'db' as const,
      requested_mode: 'affected' as const,
      effective_mode: 'affected' as const,
      base: 'abc',
      changed_files: [],
      predicted_files: ['--passWithNoTests'],
    },
  ])('fails closed to the full DB suite for unusable selection %#', (selection) => {
    expect(resolveRequiredDbFiles(selection)).toBeNull();
  });

  it('finds directly changed DB tests omitted by the graph selector', () => {
    expect(
      findDirectChangedDbTestMisses({
        changedFiles: ['src/feature.ts', 'src/direct.test.ts', 'src/unit.unit.test.ts'],
        predictedFiles: ['src/related.db.test.ts'],
        dbFiles: ['src/direct.test.ts', 'src/related.db.test.ts'],
      }),
    ).toEqual({
      directChangedDbTests: ['src/direct.test.ts'],
      misses: ['src/direct.test.ts'],
    });
  });

  it('validates shard syntax and skips only truly empty affected shards', () => {
    expect(parseShard('1/2')).toEqual({ index: 1, count: 2, value: '1/2' });
    expect(parseShard('3/2')).toBeNull();
    expect(parseShard('--help')).toBeNull();
    expect(shouldSkipAffectedShard(1, { index: 1, count: 2, value: '1/2' })).toBe(false);
    expect(shouldSkipAffectedShard(1, { index: 2, count: 2, value: '2/2' })).toBe(true);
    expect(shouldSkipAffectedShard(2, { index: 2, count: 2, value: '2/2' })).toBe(false);
  });

  it('accounts for selected file argument bytes before spawning Vitest', () => {
    expect(affectedCliBytes(['src/a.db.test.ts', 'src/二.db.test.ts'])).toBe(
      Buffer.byteLength('src/a.db.test.ts') + 1 + Buffer.byteLength('src/二.db.test.ts') + 1,
    );
    expect(affectedFilesFitCli(['src/a.db.test.ts'])).toBe(true);
    expect(
      affectedFilesFitCli(Array.from({ length: 5_000 }, (_, index) => `src/${index}.test.ts`)),
    ).toBe(false);
  });

  it('fails closed explicitly when the merge base is empty', () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'db-base-empty-'));
    const output = path.join(repo, 'selection.json');
    try {
      execFileSync(
        process.execPath,
        [
          path.resolve('scripts/ci/db-affected.mjs'),
          'select',
          '--base',
          '',
          '--mode',
          'affected',
          '--output',
          output,
        ],
        { cwd: repo },
      );
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        partition: 'db',
        effective_mode: 'full',
        fallback_reason: 'base-empty',
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
