import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDbManifest,
  computeManifestDigest,
  validateDbManifest,
} from './db-artifact-manifest.mjs';
import type { DbShardMergedReport } from './db-artifact-shard.mjs';

const HEAD = `1${'a'.repeat(39)}`;
const TREE = `2${'b'.repeat(39)}`;
const NOW = new Date();

const FAKE_AGENT = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" != "artifact" ] || [ "\${2:-}" != "download" ]; then
  echo "fake agent: unsupported invocation: \${*:-}" >&2
  exit 64
fi
query="$3"
dest="$4"
if [ "\${FAKE_AGENT_FAIL:-0}" = "1" ]; then
  echo "fake agent: no artifacts found for \${query}" >&2
  exit 1
fi
src="\${FAKE_AGENT_ARTIFACT_DIR:?}/\${query}"
if [ ! -f "$src" ]; then
  echo "fake agent: artifact absent: \${query}" >&2
  exit 1
fi
mkdir -p "\${dest}/$(dirname "\${query}")"
cp "$src" "\${dest}/\${query}"
`;

const FAKE_RUN = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const options = {};
const rest = process.argv.slice(2);
for (let index = 0; index < rest.length; index += 1) {
  if (!rest[index].startsWith('--')) continue;
  options[rest[index].slice(2)] = rest[index + 1];
  index += 1;
}
const selection = JSON.parse(readFileSync(options.selection, 'utf8'));
const predicted = Array.isArray(selection.predicted_files) ? selection.predicted_files : null;
const shardIndex = Number.parseInt(options.shard.split('/')[0], 10);
const skipped =
  process.env.FAKE_RUN_FORCE_SKIP === '1' || (predicted !== null && predicted.length < shardIndex);
appendFileSync(
  process.env.FAKE_RUN_LOG,
  \`\${JSON.stringify({ selection, shard: options.shard })}\\n\`,
);
writeFileSync(
  options.execution,
  \`\${JSON.stringify(
    {
      schema_version: 1,
      partition: 'db',
      required_mode: predicted ? 'affected' : 'full',
      requested_mode: selection.requested_mode,
      effective_mode: selection.effective_mode,
      fallback_reason: selection.fallback_reason ?? null,
      base: selection.base,
      shard: options.shard,
      skipped_empty_shard: skipped,
      selected_files: predicted ? predicted.length : null,
      test_duration_ms: 1,
      exit_code: 0,
      signal: null,
      timed_out: false,
      created_at: new Date().toISOString(),
    },
    null,
    2,
  )}\\n\`,
);
if (process.env.FAKE_RUN_EXIT) process.exitCode = Number(process.env.FAKE_RUN_EXIT);
`;

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

interface CliHarness {
  workspace: string;
  runShard: (
    shard: string,
    env?: Record<string, string>,
  ) => {
    status: number | null;
    report: DbShardMergedReport | null;
    runLog: Array<{ selection: Record<string, unknown>; shard: string }>;
  };
  seedManifest: (manifest: Record<string, unknown>, bytes?: string) => void;
}

function createHarness(): CliHarness {
  const workspace = mkdtempSync(path.join(tmpdir(), 'db-shard-cli-'));
  const binDir = path.join(workspace, 'bin');
  const artifactDir = path.join(workspace, 'artifacts');
  const cacheDir = path.join(workspace, '.cache/ci');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.join(artifactDir, '.cache/ci'), { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const agentPath = path.join(binDir, 'buildkite-agent');
  writeFileSync(agentPath, FAKE_AGENT);
  chmodSync(agentPath, 0o755);
  const runStubPath = path.join(binDir, 'fake-db-affected.mjs');
  writeFileSync(runStubPath, FAKE_RUN);
  const runLogPath = path.join(workspace, 'run-log.jsonl');

  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    DB_ARTIFACT_DB_AFFECTED_BIN: runStubPath,
    FAKE_RUN_LOG: runLogPath,
    FAKE_AGENT_ARTIFACT_DIR: artifactDir,
  };

  const readRunLog = () => {
    try {
      return readFileSync(runLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };

  return {
    workspace,
    seedManifest: (manifest, bytes) => {
      writeFileSync(
        path.join(artifactDir, '.cache/ci/db-manifest.json'),
        bytes ?? `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
    runShard: (shard, env = {}) => {
      writeFileSync(runLogPath, '');
      const [index] = shard.split('/');
      const executionPath = path.join(cacheDir, `db-execution-shard-${index}.json`);
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('scripts/ci/db-artifact-shard.mjs'),
          '--manifest',
          '.cache/ci/db-manifest.json',
          '--artifact-step',
          'db-select',
          '--shard',
          shard,
          '--execution',
          path.relative(workspace, executionPath),
          '--expect-head',
          HEAD,
        ],
        { cwd: workspace, env: { ...baseEnv, ...env }, encoding: 'utf8' },
      );
      let report: DbShardMergedReport | null = null;
      try {
        report = JSON.parse(readFileSync(executionPath, 'utf8'));
      } catch {
        report = null;
      }
      return { status: result.status, report, runLog: readRunLog() };
    },
  };
}

describe('DB shard runner CLI (native artifact handoff)', () => {
  it('scenario (a): >=2 selected files — both shards execute and report the identical digest', () => {
    const harness = createHarness();
    try {
      harness.seedManifest(
        buildManifest(['src/a.db.test.ts', 'src/b.db.test.ts']) as unknown as Record<
          string,
          unknown
        >,
      );

      const first = harness.runShard('1/2');
      const second = harness.runShard('2/2');

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.runLog).toHaveLength(1);
      expect(second.runLog).toHaveLength(1);
      expect(first.runLog[0].shard).toBe('1/2');
      expect(second.runLog[0].shard).toBe('2/2');
      expect(first.runLog[0].selection.predicted_files).toEqual([
        'src/a.db.test.ts',
        'src/b.db.test.ts',
      ]);
      expect(first.report?.selector.status).toBe('verified');
      expect(second.report?.selector.status).toBe('verified');
      expect(first.report?.selector.digest_sha256).toBe(second.report?.selector.digest_sha256);
      expect(first.report?.skipped_empty_shard).toBe(false);
      expect(second.report?.skipped_empty_shard).toBe(false);
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('scenario (b): exactly 1 selected file — shard 1 executes, shard 2 skips with the same digest', () => {
    const harness = createHarness();
    try {
      harness.seedManifest(
        buildManifest(['src/a.db.test.ts']) as unknown as Record<string, unknown>,
      );

      const first = harness.runShard('1/2');
      const second = harness.runShard('2/2');

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.report?.skipped_empty_shard).toBe(false);
      expect(second.report?.skipped_empty_shard).toBe(true);
      expect(second.report?.selector.digest_sha256).toBe(first.report?.selector.digest_sha256);
      expect(second.report?.selector.expected_skip).toBe(true);
      expect(second.runLog[0].selection.predicted_files).toEqual(['src/a.db.test.ts']);
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('scenario (c): a missing artifact download falls back to the full non-empty DB suite', () => {
    const harness = createHarness();
    try {
      const missing = harness.runShard('1/2', { FAKE_AGENT_FAIL: '1' });

      expect(missing.status).toBe(0);
      expect(missing.report?.selector.status).toBe('fallback');
      expect(missing.report?.selector.fallback_reason).toBe('manifest-missing');
      expect(missing.report?.selector.digest_sha256).toBeNull();
      expect(missing.runLog[0].selection.predicted_files).toBeNull();
      expect(missing.runLog[0].selection.effective_mode).toBe('full');
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('scenario (c): an expired manifest falls back to the full suite deterministically', () => {
    const harness = createHarness();
    try {
      harness.seedManifest(
        buildManifest(
          ['src/a.db.test.ts'],
          new Date(Date.now() - 48 * 60 * 60 * 1000),
        ) as unknown as Record<string, unknown>,
      );

      const expired = harness.runShard('1/2');

      expect(expired.status).toBe(0);
      expect(expired.report?.selector.status).toBe('fallback');
      expect(expired.report?.selector.fallback_reason).toBe('manifest-expired');
      expect(expired.runLog[0].selection.predicted_files).toBeNull();
      expect(expired.runLog[0].selection.effective_mode).toBe('full');
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('scenario (c): a stale-head manifest falls back to the full suite deterministically', () => {
    const harness = createHarness();
    try {
      const staleHead = `9${'c'.repeat(39)}`;
      // A genuinely stale manifest is internally consistent (digest resealed)
      // but was sealed for a different commit than this shard's checkout.
      const fresh = buildManifest(['src/a.db.test.ts'], new Date());
      const stale: Record<string, unknown> = {
        ...(fresh as unknown as Record<string, unknown>),
        source: { ...fresh.source, head: staleHead },
      };
      stale.digest_sha256 = computeManifestDigest(stale);
      expect(
        validateDbManifest(stale, { expectHead: HEAD, now: new Date(), shardCount: 2 }).violations,
      ).toEqual([expect.objectContaining({ code: 'manifest-stale-head' })]);
      harness.seedManifest(stale);

      const staleRun = harness.runShard('1/2');

      expect(staleRun.status).toBe(0);
      expect(staleRun.report?.selector.status).toBe('fallback');
      expect(staleRun.report?.selector.fallback_reason).toBe('manifest-stale-head');
      expect(staleRun.runLog[0].selection.predicted_files).toBeNull();
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('scenario (c) RED: a tampered manifest fails closed without invoking the runner', () => {
    const harness = createHarness();
    try {
      const manifest = buildManifest(['src/a.db.test.ts', 'src/b.db.test.ts']) as unknown as Record<
        string,
        unknown
      >;
      (manifest.selected_files as string[]).push('src/zz.db.test.ts');
      harness.seedManifest(manifest);

      const tampered = harness.runShard('1/2');

      expect(tampered.status).toBe(1);
      expect(tampered.report?.status).toBe('failed');
      expect(tampered.report?.reason).toContain('digest-mismatch');
      expect(tampered.runLog).toHaveLength(0);
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('scenario (c) RED: unparseable manifest bytes fail closed without invoking the runner', () => {
    const harness = createHarness();
    try {
      harness.seedManifest({}, '{not-json');

      const unparseable = harness.runShard('1/2');

      expect(unparseable.status).toBe(1);
      expect(unparseable.report?.reason).toContain('manifest-corrupt-json');
      expect(unparseable.runLog).toHaveLength(0);
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('RED: runner/manifest skip disagreement fails the shard instead of trusting either alone', () => {
    const harness = createHarness();
    try {
      harness.seedManifest(
        buildManifest(['src/a.db.test.ts', 'src/b.db.test.ts']) as unknown as Record<
          string,
          unknown
        >,
      );

      const drifted = harness.runShard('1/2', { FAKE_RUN_FORCE_SKIP: '1' });

      expect(drifted.status).toBe(1);
      expect(drifted.report?.consistency_violation).toBe('skip-consistency-drift');
      expect(drifted.report?.selector.status).toBe('failed');
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('rejects an invalid shard argument without touching artifacts', () => {
    const harness = createHarness();
    try {
      const badShard = harness.runShard('3/2');
      expect(badShard.status).not.toBe(0);
      expect(badShard.runLog).toHaveLength(0);
    } finally {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });
});
