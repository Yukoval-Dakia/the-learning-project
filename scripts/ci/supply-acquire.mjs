// Pinned artifact acquisition for the YUK-914 required consumer: the
// cross-build `buildkite-agent artifact download --build` pair, the loader
// tarball's sha512 re-verification against bun.lock, and the binary extraction.
// `runAgent` defaults to the real buildkite-agent; tests record its argv.

import { readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SupplyContractError } from './supply-graph.mjs';
import { extractLoaderTarball, verifyLoaderTarball } from './supply-loader.mjs';
import {
  buildArtifactDownloadArgs,
  bunLockLoaderIntegrity,
  closureArtifactName,
  loaderArtifactName,
  requirePinnedPlatform,
} from './supply-pins.mjs';

export function locateDownloadedArtifact(root, artifactName) {
  const matches = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === artifactName) matches.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new SupplyContractError(
      `downloaded artifact ${artifactName} resolved to ${matches.length} files; expected exactly one`,
    );
  }
  return matches[0];
}

export function downloadPinnedArtifacts({
  pins,
  platform,
  arch,
  downloadDir,
  currentPipeline,
  runAgent,
}) {
  const pinned = requirePinnedPlatform(pins, `${platform}-${arch}`);
  const closure = closureArtifactName(pinned.archiveSha256);
  const loader = loaderArtifactName(platform, arch);
  for (const artifactName of [closure, loader]) {
    runAgent(
      buildArtifactDownloadArgs({
        artifactName,
        destination: downloadDir,
        build: pinned.seedBuild,
        pipeline: pins.artifactSource.pipeline,
        currentPipeline,
      }),
    );
  }
  return {
    archivePath: locateDownloadedArtifact(downloadDir, closure),
    loaderPath: locateDownloadedArtifact(downloadDir, loader),
    pinned,
  };
}

export async function acquirePinnedArtifacts({
  pins,
  platform,
  arch,
  downloadDir,
  extractRoot,
  currentPipeline,
  bunLockText,
  loaderVersion,
  runAgent,
}) {
  await mkdir(downloadDir, { recursive: true });
  const downloaded = await downloadPinnedArtifacts({
    pins,
    platform,
    arch,
    downloadDir,
    currentPipeline,
    runAgent,
  });
  const expectedIntegrity = bunLockLoaderIntegrity(bunLockText, platform, arch, loaderVersion);
  await verifyLoaderTarball({ tarballPath: downloaded.loaderPath, expectedIntegrity });
  const loaderPath = await extractLoaderTarball({
    tarballPath: downloaded.loaderPath,
    extractRoot,
  });
  return { archivePath: downloaded.archivePath, loaderPath };
}
