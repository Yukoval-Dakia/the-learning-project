import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRequiredDbFiles } from './db-affected.mjs';
import {
  ASSIGNMENT_STRATEGY,
  MANIFEST_TTL_MS,
  buildDbManifest,
  buildLocalSelection,
  canonicalStringify,
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

function affectedSelection(predictedFiles: string[]) {
  return {
    schema_version: 1 as const,
    partition: 'db' as const,
    requested_mode: 'affected' as const,
    effective_mode: 'affected' as const,
    base: 'abc123def',
    changed_files: ['src/feature.ts'],
    predicted_files: predictedFiles,
  };
}

function buildTestManifest(predictedFiles: string[], shardCount = 2) {
  return buildDbManifest({
    selection: affectedSelection(predictedFiles),
    shardCount,
    workspace: workspace(),
    build: { buildkite_build_number: '7', pipeline_slug: 'ci-shadow', branch: 'codex/yuk-918' },
    head: HEAD,
    tree: TREE,
    now: NOW,
  });
}

describe('DB artifact manifest builder', () => {
  it('builds a schema-valid affected manifest with round-robin shard assignments', () => {
    const manifest = buildTestManifest([
      'src/b.db.test.ts',
      'src/a.db.test.ts',
      'src/c.db.test.ts',
    ]);

    expect(manifest.schema_version).toBe(1);
    expect(manifest.partition).toBe('db');
    expect(manifest.mode).toBe('affected');
    expect(manifest.selected_files).toEqual([
      'src/a.db.test.ts',
      'src/b.db.test.ts',
      'src/c.db.test.ts',
    ]);
    expect(manifest.shards.assignment_strategy).toBe(ASSIGNMENT_STRATEGY);
    expect(manifest.shards.count).toBe(2);
    expect(manifest.shards.assignments).toEqual([
      { shard: 1, files: ['src/a.db.test.ts', 'src/c.db.test.ts'] },
      { shard: 2, files: ['src/b.db.test.ts'] },
    ]);
    expect(manifest.source).toMatchObject({ head: HEAD, tree: TREE, base: 'abc123def' });
    expect(manifest.created_at).toBe(NOW.toISOString());
    expect(manifest.expires_at).toBe(new Date(NOW.getTime() + MANIFEST_TTL_MS).toISOString());
    expect(manifest.digest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateDbManifest(manifest, { expectHead: HEAD, now: NOW, shardCount: 2 }).ok).toBe(
      true,
    );
  });

  it('reports absolute workspace paths for the selector run', () => {
    const ws = workspace();
    const manifest = buildDbManifest({
      selection: affectedSelection(['src/a.db.test.ts']),
      shardCount: 2,
      workspace: ws,
      build: null,
      head: HEAD,
      tree: TREE,
      now: NOW,
    });
    expect(path.isAbsolute(manifest.workspace.root)).toBe(true);
    expect(manifest.workspace.selection_path).toBe(ws.selectionPath);
    expect(manifest.workspace.manifest_path).toBe(ws.manifestPath);
  });

  it('derives deterministic digests that change with the selection content', () => {
    const sharedWorkspace = workspace();
    const inputs = {
      shardCount: 2,
      workspace: sharedWorkspace,
      build: null,
      head: HEAD,
      tree: TREE,
      now: NOW,
    } as const;
    const first = buildDbManifest({
      ...inputs,
      selection: affectedSelection(['src/a.db.test.ts', 'src/b.db.test.ts']),
    });
    const same = buildDbManifest({
      ...inputs,
      selection: affectedSelection(['src/a.db.test.ts', 'src/b.db.test.ts']),
    });
    const other = buildDbManifest({
      ...inputs,
      selection: affectedSelection(['src/a.db.test.ts', 'src/c.db.test.ts']),
    });

    expect(first.digest_sha256).toBe(same.digest_sha256);
    expect(first.digest_sha256).not.toBe(other.digest_sha256);
  });

  it('builds a full-mode manifest with empty assignments from a fallback selection', () => {
    const manifest = buildDbManifest({
      selection: {
        schema_version: 1,
        partition: 'db',
        requested_mode: 'affected',
        effective_mode: 'full',
        fallback_reason: 'vitest-list-timeout',
        base: 'abc123def',
        changed_files: [],
        predicted_files: null,
      },
      shardCount: 2,
      workspace: workspace(),
      build: null,
      head: HEAD,
      tree: TREE,
      now: NOW,
    });

    expect(manifest.mode).toBe('full');
    expect(manifest.selected_files).toEqual([]);
    expect(manifest.shards.assignments).toEqual([
      { shard: 1, files: [] },
      { shard: 2, files: [] },
    ]);
    expect(validateDbManifest(manifest, { expectHead: HEAD, now: NOW, shardCount: 2 }).ok).toBe(
      true,
    );
    expect(resolveRequiredDbFiles(buildLocalSelection(manifest))).toBeNull();
  });
});

describe('DB artifact local selection materialization', () => {
  it('round-trips an affected manifest into a selection db-affected run accepts', () => {
    const manifest = buildTestManifest(['src/a.db.test.ts', 'src/b.db.test.ts']);
    const selection = buildLocalSelection(manifest);

    expect(resolveRequiredDbFiles(selection)).toEqual(manifest.selected_files);
    expect(selection.partition).toBe('db');
    expect(selection.base).toBe(manifest.source.base);
  });

  it('canonical serialization is key-order independent', () => {
    const manifest = buildTestManifest(['src/a.db.test.ts']);
    const reordered = {
      digest_sha256: manifest.digest_sha256,
      workspace: manifest.workspace,
      ...Object.fromEntries(
        Object.entries(manifest).filter(([key]) => key !== 'digest_sha256' && key !== 'workspace'),
      ),
    };
    expect(canonicalStringify(reordered)).toBe(canonicalStringify(manifest));
  });
});

describe('DB artifact manifest CLI', () => {
  it('build writes a digest-covered manifest for a stored affected selection', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'db-manifest-cli-'));
    try {
      const selectionPath = path.join(root, 'db-selection.json');
      const outputPath = path.join(root, 'db-manifest.json');
      writeFileSync(
        selectionPath,
        `${JSON.stringify(affectedSelection(['src/a.db.test.ts', 'src/b.db.test.ts']))}\n`,
      );

      execFileSync(
        process.execPath,
        [
          path.resolve('scripts/ci/db-artifact-manifest-cli.mjs'),
          'build',
          '--selection',
          selectionPath,
          '--output',
          outputPath,
          '--shards',
          '2',
        ],
        { cwd: path.resolve('.') },
      );

      const manifest = JSON.parse(readFileSync(outputPath, 'utf8'));
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve('.') })
        .toString()
        .trim();
      expect(manifest.source.head).toBe(head);
      expect(
        validateDbManifest(manifest, { expectHead: head, now: new Date(), shardCount: 2 }).ok,
      ).toBe(true);
      expect(manifest.shards.assignments).toEqual([
        { shard: 1, files: ['src/a.db.test.ts'] },
        { shard: 2, files: ['src/b.db.test.ts'] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
