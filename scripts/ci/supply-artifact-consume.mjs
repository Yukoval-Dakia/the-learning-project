// YUK-914 required consumer: downloads the runtime-closure artifact by its
// recorded digest from the pinned seed build (via `buildkite-agent artifact
// download --build`), verifies the archive and manifest digests plus the
// expected versions/graphs, re-verifies the loader tarball against bun.lock,
// then runs the real OpenCode loader and the graph validation fully offline
// under a loopback network sentinel. Any registry egress attempt during the
// required validation is a failure. Bootstrap `seedRequired` pins are a hard
// RED until a lead records the seed receipt.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import {
  bunLockResolutions,
  closureDirName,
  parseLooseJson,
  platformKey,
  sha256Hex,
  validateClosureGraph,
  validateManifestAgainstInventory,
} from './supply-graph.mjs';
import {
  offlineLoaderEnv,
  pointWorkspaceAtExtractedPlugins,
  runLoaderSnapshot,
  startNetworkSentinel,
} from './supply-offline.mjs';
import { loadPins, requirePinnedPlatform } from './supply-pins.mjs';
import { extractDeterministicTar } from './supply-tar-reader.mjs';

const MANIFEST_ENTRY = 'manifest.json';

export class ConsumeFailure extends Error {}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function gunzipTo(source, destination) {
  await new Promise((resolvePromise, rejectPromise) => {
    const input = createReadStream(source);
    const output = createWriteStream(destination);
    const gunzip = createGunzip();
    input.on('error', rejectPromise);
    output.on('error', rejectPromise);
    output.on('finish', resolvePromise);
    input.pipe(gunzip).pipe(output);
  });
}

/**
 * Downloads the digest-named closure and loader from the pinned seed build —
 * see supply-acquire.mjs. Exported for the required-gate argv tests via that
 * module; this file owns verification and the offline loader run.
 */
export async function consumeArtifact({
  archivePath,
  loaderPath,
  pinsPath,
  inventory,
  bunLockText,
  workspaceTemplateDir,
  scratchRoot,
  timeoutMs,
}) {
  const pins = await loadPins(pinsPath);
  const pinned = requirePinnedPlatform(pins, platformKey());
  await rm(scratchRoot, { recursive: true, force: true });
  const extractRoot = join(scratchRoot, 'extract');
  const home = join(scratchRoot, 'home');
  const workspace = join(scratchRoot, 'workspace');
  await mkdir(extractRoot, { recursive: true });

  const tarPath = archivePath.endsWith('.gz') ? join(scratchRoot, 'closure.tar') : archivePath;
  if (archivePath.endsWith('.gz')) await gunzipTo(archivePath, tarPath);
  const archiveDigest = await sha256File(tarPath);
  if (archiveDigest !== pinned.archiveSha256) {
    throw new ConsumeFailure(
      `archive digest mismatch for ${platformKey()}: expected ${pinned.archiveSha256}, downloaded ${archiveDigest}`,
    );
  }

  const entries = await extractDeterministicTar(tarPath, extractRoot);
  if (!entries.some((entry) => entry.path === MANIFEST_ENTRY)) {
    throw new ConsumeFailure('archive is missing its manifest entry');
  }
  const manifestBytes = await readFile(join(extractRoot, MANIFEST_ENTRY), 'utf8');
  const manifestDigest = sha256Hex(Buffer.from(manifestBytes, 'utf8'));
  if (manifestDigest !== pinned.manifestSha256) {
    throw new ConsumeFailure(
      `manifest digest mismatch: expected ${pinned.manifestSha256}, archive carries ${manifestDigest}`,
    );
  }
  const manifest = parseLooseJson(manifestBytes);
  validateManifestAgainstInventory(manifest, inventory, {
    platform: process.platform,
    arch: process.arch,
  });

  const resolutions = bunLockResolutions(bunLockText);
  const lockDigests = new Map();
  for (const declared of manifest.plugins) {
    const plugin = inventory.npmPlugins.find((entry) => entry.specifier === declared.specifier);
    const extractedClosure = join(extractRoot, 'closure', closureDirName(declared.specifier));
    const lockPath = join(extractedClosure, 'package-lock.json');
    const lockText = await readFile(lockPath, 'utf8');
    lockDigests.set(declared.specifier, sha256Hex(Buffer.from(lockText, 'utf8')));
    validateClosureGraph(parseLooseJson(lockText), plugin, resolutions, pins.approvedRuntimePlugin);
    const cacheTarget = join(home, '.cache', 'opencode', 'packages', declared.specifier);
    await mkdir(join(cacheTarget, '..'), { recursive: true });
    await cp(extractedClosure, cacheTarget, { recursive: true, verbatimSymlinks: true });
  }

  await cp(workspaceTemplateDir, workspace, { recursive: true });
  await pointWorkspaceAtExtractedPlugins({
    workspace,
    extractRoot,
    declaredPlugins: manifest.plugins,
    inventory,
  });
  await mkdir(join(home, 'tmp'), { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: workspace, stdio: 'ignore' });

  const sentinel = await startNetworkSentinel();
  let failure = null;
  let snapshot = null;
  try {
    snapshot = await runLoaderSnapshot({
      loader: loaderPath,
      workspace,
      env: offlineLoaderEnv(home, sentinel.port),
      timeoutMs,
    });
  } catch (error) {
    failure = error;
  } finally {
    await sentinel.stop();
  }
  if (sentinel.attempts.length > 0) {
    const loaderFailure = failure instanceof Error ? failure.message.replaceAll('\n', ' ').slice(-1000) : '';
    throw new ConsumeFailure(
      `network attempt during required offline validation: ${sentinel.attempts.length} connection(s) ` +
        `to the sentinel registry (first: ${sentinel.attempts[0]})` +
        (loaderFailure ? `; loader failure: ${loaderFailure}` : ''),
    );
  }
  if (failure) throw failure;

  const registered = [];
  for (const plugin of inventory.npmPlugins) {
    for (const toolId of plugin.requiredToolIds) {
      if (snapshot.tools[toolId] !== true) {
        throw new ConsumeFailure(`${plugin.id} did not register enabled tool ${toolId}`);
      }
      registered.push(toolId);
    }
  }
  for (const [specifier, before] of lockDigests) {
    const after = await readFile(
      join(home, '.cache', 'opencode', 'packages', specifier, 'package-lock.json'),
      'utf8',
    );
    if (sha256Hex(Buffer.from(after, 'utf8')) !== before) {
      throw new ConsumeFailure(
        `runtime lock for ${specifier} changed during the offline loader run`,
      );
    }
  }
  return {
    archiveSha256: archiveDigest,
    manifestSha256: manifestDigest,
    tools: registered.sort(),
    networkAttempts: sentinel.attempts.length,
    entries: entries.length,
  };
}
