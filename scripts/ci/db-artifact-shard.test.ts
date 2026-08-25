import { describe, expect, it } from 'vitest';
import { buildDbManifest } from './db-artifact-manifest.mjs';
import {
  classifyDbManifestViolations,
  expectedSkipForShard,
  mergeExecutionReport,
  planShardExecution,
} from './db-artifact-shard.mjs';

const HEAD = `1${'a'.repeat(39)}`;
const TREE = `2${'b'.repeat(39)}`;
const NOW = new Date('2026-08-25T00:00:00.000Z');
const SHARD_1 = { index: 1, count: 2, value: '1/2' } as const;
const SHARD_2 = { index: 2, count: 2, value: '2/2' } as const;

function buildManifest(predictedFiles: string[], now = NOW) {
  return buildDbManifest({
    selection: {
      schema_version: 1,
      partition: 'db',
      requested_mode: 'affected',
      effective_mode: 'affected',
      base: 'abc123def',
      changed_files: [],
      predicted_files: predictedFiles,
    },
    shardCount: 2,
    workspace: {
      root: '/workspace/checkout',
      selectionPath: '/workspace/checkout/.cache/ci/db-selection.json',
      manifestPath: '/workspace/checkout/.cache/ci/db-manifest.json',
    },
    build: null,
    head: HEAD,
    tree: TREE,
    now,
  });
}

function runExecution(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    partition: 'db',
    required_mode: 'affected',
    requested_mode: 'affected',
    effective_mode: 'affected',
    base: 'abc123def',
    shard: '1/2',
    skipped_empty_shard: false,
    selected_files: 2,
    test_duration_ms: 5,
    exit_code: 0,
    signal: null,
    timed_out: false,
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

describe('DB shard manifest policy classification', () => {
  it('classifies age/lineage violations as deterministic fallback and everything else as corrupt', () => {
    expect(classifyDbManifestViolations([{ code: 'manifest-stale-head', message: '' }])).toBe(
      'fallback',
    );
    expect(classifyDbManifestViolations([{ code: 'manifest-expired', message: '' }])).toBe(
      'fallback',
    );
    expect(classifyDbManifestViolations([{ code: 'digest-mismatch', message: '' }])).toBe(
      'corrupt',
    );
    expect(classifyDbManifestViolations([{ code: 'shard-count-mismatch', message: '' }])).toBe(
      'corrupt',
    );
    expect(
      classifyDbManifestViolations([
        { code: 'manifest-stale-head', message: '' },
        { code: 'digest-mismatch', message: '' },
      ]),
    ).toBe('corrupt');
  });

  it('plans execute / full-fallback / fail without any empty-green path', () => {
    expect(planShardExecution({ manifestState: 'missing', violations: [] })).toEqual({
      action: 'full-fallback',
      fallbackReason: 'manifest-missing',
    });
    expect(planShardExecution({ manifestState: 'present', violations: [] })).toEqual({
      action: 'execute-manifest',
      fallbackReason: null,
    });
    expect(
      planShardExecution({
        manifestState: 'present',
        violations: [{ code: 'manifest-stale-head', message: '' }],
      }),
    ).toEqual({ action: 'full-fallback', fallbackReason: 'manifest-stale-head' });
    expect(
      planShardExecution({
        manifestState: 'present',
        violations: [{ code: 'manifest-corrupt-json', message: '' }],
      }),
    ).toEqual({ action: 'fail', fallbackReason: 'manifest-corrupt-json' });
    expect(
      planShardExecution({
        manifestState: 'present',
        violations: [{ code: 'digest-mismatch', message: '' }],
      }),
    ).toEqual({ action: 'fail', fallbackReason: 'digest-mismatch' });
  });

  it('expects a skip exactly for affected shards whose assignment is empty', () => {
    const oneFile = buildManifest(['src/a.db.test.ts']);
    expect(expectedSkipForShard(oneFile, 1)).toBe(false);
    expect(expectedSkipForShard(oneFile, 2)).toBe(true);

    const twoFiles = buildManifest(['src/a.db.test.ts', 'src/b.db.test.ts']);
    expect(expectedSkipForShard(twoFiles, 1)).toBe(false);
    expect(expectedSkipForShard(twoFiles, 2)).toBe(false);
  });

  it('never expects a skip for a full-mode manifest', () => {
    const full = buildDbManifest({
      selection: {
        schema_version: 1,
        partition: 'db',
        requested_mode: 'affected',
        effective_mode: 'full',
        fallback_reason: 'gate-plan-full-trigger',
        base: 'abc123def',
        changed_files: [],
        predicted_files: null,
      },
      shardCount: 2,
      workspace: {
        root: '/workspace/checkout',
        selectionPath: '/workspace/checkout/.cache/ci/db-selection.json',
        manifestPath: '/workspace/checkout/.cache/ci/db-manifest.json',
      },
      build: null,
      head: HEAD,
      tree: TREE,
      now: NOW,
    });
    expect(expectedSkipForShard(full, 1)).toBe(false);
    expect(expectedSkipForShard(full, 2)).toBe(false);
    expect(expectedSkipForShard(null, 2)).toBe(false);
  });
});

describe('DB shard execution report merge', () => {
  it('propagates the verified selector digest into both shard reports identically', () => {
    const manifest = buildManifest(['src/a.db.test.ts', 'src/b.db.test.ts']);
    const plan = { action: 'execute-manifest', fallbackReason: null } as const;

    const first = mergeExecutionReport({
      runExecution: runExecution({ shard: '1/2' }),
      manifest,
      plan,
      shard: SHARD_1,
      workspaceRoot: '/agent-a/checkout',
    });
    const second = mergeExecutionReport({
      runExecution: runExecution({ shard: '2/2' }),
      manifest,
      plan,
      shard: SHARD_2,
      workspaceRoot: '/agent-b/checkout',
    });

    expect(first.drift).toBe(false);
    expect(second.drift).toBe(false);
    expect(first.report.selector.digest_sha256).toBe(manifest.digest_sha256);
    expect(second.report.selector.digest_sha256).toBe(manifest.digest_sha256);
    expect(first.report.selector.status).toBe('verified');
    expect(first.report.skipped_empty_shard).toBe(false);
  });

  it('keeps skipped shards green only with the same digest and an explicit skip record', () => {
    const manifest = buildManifest(['src/a.db.test.ts']);
    const plan = { action: 'execute-manifest', fallbackReason: null } as const;

    const shard1 = mergeExecutionReport({
      runExecution: runExecution({ shard: '1/2', selected_files: 1 }),
      manifest,
      plan,
      shard: SHARD_1,
      workspaceRoot: '/agent-a/checkout',
    });
    const shard2 = mergeExecutionReport({
      runExecution: runExecution({ shard: '2/2', skipped_empty_shard: true, selected_files: 1 }),
      manifest,
      plan,
      shard: SHARD_2,
      workspaceRoot: '/agent-b/checkout',
    });

    expect(shard2.report.skipped_empty_shard).toBe(true);
    expect(shard2.report.selector.digest_sha256).toBe(shard1.report.selector.digest_sha256);
    expect(shard2.report.selector.expected_skip).toBe(true);
    expect(shard2.drift).toBe(false);
  });

  it('fails closed when the runner and manifest disagree about an empty shard', () => {
    const manifest = buildManifest(['src/a.db.test.ts', 'src/b.db.test.ts']);
    const plan = { action: 'execute-manifest', fallbackReason: null } as const;

    const drifted = mergeExecutionReport({
      runExecution: runExecution({ skipped_empty_shard: true }),
      manifest,
      plan,
      shard: SHARD_1,
      workspaceRoot: '/agent-a/checkout',
    });

    expect(drifted.drift).toBe(true);
    expect(drifted.report.consistency_violation).toBe('skip-consistency-drift');
    expect(drifted.report.selector.status).toBe('failed');
  });

  it('marks deterministic fallback reports with a null digest and the fallback reason', () => {
    const manifest = buildManifest(['src/a.db.test.ts']);
    const plan = { action: 'full-fallback', fallbackReason: 'manifest-missing' } as const;

    const merged = mergeExecutionReport({
      runExecution: runExecution({ required_mode: 'full', skipped_empty_shard: false }),
      manifest,
      plan,
      shard: SHARD_1,
      workspaceRoot: '/agent-a/checkout',
    });

    expect(merged.drift).toBe(false);
    expect(merged.report.selector.status).toBe('fallback');
    expect(merged.report.selector.digest_sha256).toBeNull();
    expect(merged.report.selector.fallback_reason).toBe('manifest-missing');
  });
});
