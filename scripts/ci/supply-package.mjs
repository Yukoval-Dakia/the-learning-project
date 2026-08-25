// Deterministic closure packaging for the YUK-914 seed producer.
//
// Validates every materialized plugin cache against the approved graphs, then
// writes the content-addressed tar + gz pair whose SHA-256 is the artifact pin.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import {
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  buildClosureManifest,
  closureDirName,
  parseLooseJson,
  sha256Hex,
  validateClosureGraph,
} from './supply-graph.mjs';
import { collectTarEntries, writeDeterministicTar } from './supply-tar-writer.mjs';

export const MANIFEST_ENTRY = 'manifest.json';

async function gzipDeterministic(source, destination) {
  await new Promise((resolvePromise, rejectPromise) => {
    const input = createReadStream(source);
    const output = createWriteStream(destination);
    const gzip = createGzip({ level: 9, mtime: 0 });
    input.on('error', rejectPromise);
    output.on('error', rejectPromise);
    output.on('finish', resolvePromise);
    input.pipe(gzip).pipe(output);
  });
}

export async function packageArtifact({
  stagingRoot,
  inventory,
  resolutions,
  approved,
  outDir,
  platform = process.platform,
  arch = process.arch,
}) {
  const plugins = [...inventory.npmPlugins].sort((left, right) =>
    left.specifier < right.specifier ? -1 : 1,
  );
  for (const plugin of plugins) {
    const lockPath = join(stagingRoot, 'caches', plugin.specifier, 'package-lock.json');
    const lock = parseLooseJson(await readFile(lockPath, 'utf8'));
    validateClosureGraph(lock, plugin, resolutions, approved);
  }
  const entries = [];
  for (const plugin of plugins) {
    entries.push(
      ...(await collectTarEntries(
        join(stagingRoot, 'caches', plugin.specifier),
        `closure/${closureDirName(plugin.specifier)}`,
      )),
    );
  }
  const manifest = buildClosureManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    platform,
    arch,
    opencodeVersion: inventory.opencode.version,
    plugins: plugins.map((plugin) => ({
      specifier: plugin.specifier,
      package: plugin.package,
      version: plugin.version,
      integrity: plugin.integrity,
      runtimePackageCount: plugin.runtimePackageCount,
      runtimeGraphSha256: plugin.runtimeGraphSha256,
    })),
    entryCount: entries.length + 1,
  });
  const manifestPath = join(stagingRoot, MANIFEST_ENTRY);
  await writeFile(manifestPath, manifest);
  entries.push({
    path: MANIFEST_ENTRY,
    source: manifestPath,
    type: 'file',
    mode: 0o100644,
    size: Buffer.byteLength(manifest),
  });
  await mkdir(outDir, { recursive: true });
  const stagingArchive = join(outDir, '.tmp-archive');
  await mkdir(stagingArchive, { recursive: true });
  try {
    const tempTar = join(stagingArchive, 'closure.tar');
    const written = await writeDeterministicTar(tempTar, entries);
    const archivePath = join(outDir, `runtime-closure-${written.sha256}.tar`);
    await rename(tempTar, archivePath);
    const gzipPath = `${archivePath}.gz`;
    await gzipDeterministic(archivePath, gzipPath);
    return {
      archivePath,
      gzipPath,
      tarSha256: written.sha256,
      manifestSha256: sha256Hex(Buffer.from(manifest, 'utf8')),
      entryCount: entries.length,
      bytes: written.bytes,
    };
  } finally {
    await rm(stagingArchive, { recursive: true, force: true });
  }
}
