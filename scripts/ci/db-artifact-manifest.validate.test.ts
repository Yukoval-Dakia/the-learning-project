import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_TTL_MS,
  buildDbManifest,
  buildShardAssignments,
  computeManifestDigest,
  validateDbManifest,
} from './db-artifact-manifest.mjs';

const HEAD = `1${'a'.repeat(39)}`;
const TREE = `2${'b'.repeat(39)}`;
const NOW = new Date('2026-08-25T00:00:00.000Z');

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'db-manifest-'));
  return {
    root,
    selectionPath: path.join(root, '.cache/ci/db-selection.json'),
    manifestPath: path.join(root, '.cache/ci/db-manifest.json'),
  };
}

function buildTestManifest(predictedFiles: string[], shardCount = 2) {
  return buildDbManifest({
    selection: {
      schema_version: 1,
      partition: 'db',
      requested_mode: 'affected',
      effective_mode: 'affected',
      base: 'abc123def',
      changed_files: ['src/feature.ts'],
      predicted_files: predictedFiles,
    },
    shardCount,
    workspace: workspace(),
    build: { buildkite_build_number: '7', pipeline_slug: 'ci-shadow', branch: 'codex/yuk-918' },
    head: HEAD,
    tree: TREE,
    now: NOW,
  });
}

/** Re-stamp the digest so structural validation can be isolated from tamper detection. */
function reseal(manifest: Record<string, unknown>): Record<string, unknown> {
  return { ...manifest, digest_sha256: computeManifestDigest(manifest) };
}

function codesOf(candidate: unknown, expectHead = HEAD) {
  return validateDbManifest(candidate, { expectHead, now: NOW, shardCount: 2 }).violations.map(
    (violation) => violation.code,
  );
}

describe('DB artifact manifest validator', () => {
  it('accepts a freshly built manifest whose digest round-trips', () => {
    const manifest = buildTestManifest(['src/a.db.test.ts', 'src/b.db.test.ts']);
    expect(computeManifestDigest(manifest)).toBe(manifest.digest_sha256);
    expect(validateDbManifest(manifest, { expectHead: HEAD, now: NOW, shardCount: 2 }).ok).toBe(
      true,
    );
  });

  it('fails closed when any manifest byte is tampered without resealing the digest', () => {
    const manifest = buildTestManifest(['src/a.db.test.ts', 'src/b.db.test.ts']);
    const tamperedFields = [
      'selected_files',
      'created_at',
      'expires_at',
      'shards',
      'workspace',
      'source',
    ] as const;

    for (const field of tamperedFields) {
      const tampered = structuredClone(manifest) as unknown as Record<string, unknown>;
      if (field === 'selected_files') {
        (tampered.selected_files as string[]).push('src/zz.db.test.ts');
      } else if (field === 'created_at' || field === 'expires_at') {
        tampered[field] = '2027-01-01T00:00:00.000Z';
      } else if (field === 'shards') {
        (
          (tampered.shards as { assignments: Array<{ files: string[] }> }).assignments[0]
            .files as string[]
        ).push('src/zz.db.test.ts');
      } else if (field === 'workspace') {
        (tampered.workspace as { root: string }).root = '/tmp/elsewhere';
      } else {
        (tampered.source as { base: string }).base = 'fff999';
      }

      expect(computeManifestDigest(tampered)).not.toBe(manifest.digest_sha256);
      expect(codesOf(tampered)).toContain('digest-mismatch');
    }
  });

  it('rejects a malformed digest field before comparing content', () => {
    const manifest = {
      ...buildTestManifest(['src/a.db.test.ts']),
      digest_sha256: 'not-a-digest',
    };
    expect(codesOf(manifest)).toContain('digest-malformed');
  });

  it('classifies stale and expired manifests explicitly', () => {
    const manifest = buildTestManifest(['src/a.db.test.ts']);

    expect(codesOf(manifest, TREE)).toContain('manifest-stale-head');
    expect(
      validateDbManifest(manifest, {
        expectHead: HEAD,
        now: new Date(NOW.getTime() + MANIFEST_TTL_MS + 1),
        shardCount: 2,
      }).violations,
    ).toEqual([expect.objectContaining({ code: 'manifest-expired' })]);
  });

  it('rejects structural violations even when the digest is resealed', () => {
    const base = buildTestManifest(['src/a.db.test.ts', 'src/b.db.test.ts']) as unknown as Record<
      string,
      unknown
    >;

    const schemaVersion = reseal({ ...base, schema_version: 2 });
    const partition = reseal({ ...base, partition: 'unit' });
    const modeEmpty = reseal({
      ...base,
      selected_files: [],
      shards: buildShardAssignments([], 2),
    });
    const relativeWorkspace = reseal({
      ...base,
      workspace: { root: 'relative/root', selection_path: 's.json', manifest_path: 'm.json' },
    });
    const unsafeFile = reseal({
      ...base,
      selected_files: ['../outside.db.test.ts'],
      shards: buildShardAssignments(['../outside.db.test.ts'], 2),
    });
    const headMalformed = reseal({
      ...base,
      source: { ...(base.source as object), head: 'short' },
    });

    expect(codesOf(schemaVersion)).toContain('schema-version-unsupported');
    expect(codesOf(partition)).toContain('partition-mismatch');
    expect(codesOf(modeEmpty)).toContain('mode-affected-empty-selection');
    expect(codesOf(relativeWorkspace)).toContain('workspace-path-not-absolute');
    expect(codesOf(unsafeFile)).toContain('selected-file-unsafe');
    expect(codesOf(headMalformed)).toContain('source-head-malformed');
  });

  it('requires shard assignments to cover each selected file exactly once', () => {
    const base = buildTestManifest(['src/a.db.test.ts', 'src/b.db.test.ts']) as unknown as Record<
      string,
      unknown
    >;
    const shards = base.shards as {
      assignments: Array<{ shard: number; files: string[] }>;
    };
    const cloneShards = () => ({
      ...shards,
      assignments: shards.assignments.map((assignment) => ({
        ...assignment,
        files: [...assignment.files],
      })),
    });

    const duplicated = reseal(structuredClone({ ...base, shards: cloneShards() }));
    (duplicated.shards as typeof shards).assignments[1].files.push('src/a.db.test.ts');

    const missing = reseal(structuredClone({ ...base, shards: cloneShards() }));
    (missing.shards as typeof shards).assignments[0].files = [];

    expect(codesOf(duplicated)).toContain('shard-assignments-incomplete');
    expect(codesOf(missing)).toContain('shard-assignments-incomplete');
    expect(codesOf(base)).toEqual([]);
    expect(
      validateDbManifest(base, { expectHead: HEAD, now: NOW, shardCount: 3 }).violations,
    ).toEqual([expect.objectContaining({ code: 'shard-count-mismatch' })]);
  });
});
