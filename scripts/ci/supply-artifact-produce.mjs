// YUK-914 seed producer: materializes the recorded runtime closure from the
// committed per-specifier npm locks (`npm ci` fetches only integrity-pinned,
// immutable tarballs), packages the deterministic content-addressed archive,
// fetches the pinned loader tarball, and uploads both via the native Buildkite
// artifact mechanism. The step runs only under manual `SUPPLY_SEED=1`; it
// emits a machine-readable receipt the lead records in runtime-artifact-pins.json.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SupplyContractError,
  bunLockResolutions,
  closureDirName,
  parseLooseJson,
} from './supply-graph.mjs';
import { packageArtifact } from './supply-package.mjs';
import {
  SEED_RECEIPT_METADATA_KEY,
  buildSeedReceipt,
  bunLockLoaderIntegrity,
  isSeedRequired,
  loadPins,
} from './supply-pins.mjs';

export async function materializeClosures({ closuresRoot, stagingRoot, inventory }) {
  const specs = inventory.npmPlugins.map((plugin) => plugin.specifier);
  for (const spec of specs) {
    const source = join(closuresRoot, closureDirName(spec));
    const target = join(stagingRoot, 'caches', spec);
    await mkdir(target, { recursive: true });
    for (const file of ['package.json', 'package-lock.json']) {
      await copyFile(join(source, file), join(target, file));
    }
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: target,
      stdio: 'inherit',
    });
  }
  return specs;
}

/** Fetches the pinned OpenCode platform tarball and verifies its registry integrity. */
export async function fetchPinnedOpencodeTarball({
  outDir,
  bunLockText,
  inventory,
  platform,
  arch,
  expectedIntegrity,
}) {
  const name = `opencode-${platform}-${arch}`;
  const specifier = `${name}@${inventory.opencode.version}`;
  const expected =
    expectedIntegrity ??
    bunLockLoaderIntegrity(bunLockText, platform, arch, inventory.opencode.version);
  const staging = await mkdtemp(join(tmpdir(), 'supply-loader-'));
  try {
    execFileSync(
      'npm',
      [
        'pack',
        specifier,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        '--pack-destination',
        staging,
      ],
      {
        stdio: 'inherit',
      },
    );
    const packed = (await readdir(staging))[0];
    if (!packed) {
      throw new SupplyContractError(`npm pack produced no tarball for ${specifier}`);
    }
    const tarball = await readFile(join(staging, packed));
    const digest = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (digest !== expected) {
      throw new SupplyContractError(
        `loader tarball integrity mismatch for ${specifier}: expected ${expected}, fetched ${digest}`,
      );
    }
    const destination = join(outDir, `opencode-loader-${platform}-${arch}.tgz`);
    await mkdir(outDir, { recursive: true });
    await rename(join(staging, packed), destination);
    return { path: destination, integrity: digest, specifier };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function gitHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function assertProducedMatchesPin(platformKey, entry, packaged) {
  if (
    entry.archiveSha256 !== packaged.tarSha256 ||
    entry.manifestSha256 !== packaged.manifestSha256
  ) {
    throw new SupplyContractError(
      `produced artifact does not match the pinned digests for ${platformKey}\n` +
        `  pinned archive:    ${entry.archiveSha256}\n` +
        `  produced archive:  ${packaged.tarSha256}\n` +
        `  pinned manifest:   ${entry.manifestSha256}\n` +
        `  produced manifest: ${packaged.manifestSha256}\n` +
        'If the closure was intentionally refreshed, update .buildkite/supply/runtime-artifact-pins.json in the same reviewed commit.',
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const upload = args.includes('--upload');
  const repoRoot = resolve(argValue(args, '--repo', process.cwd()));
  const inventory = parseLooseJson(
    await readFile(
      join(repoRoot, '.opencode', 'plugins', 'supply-chain', 'inventory.json'),
      'utf8',
    ),
  );
  const pins = await loadPins(join(repoRoot, '.buildkite', 'supply', 'runtime-artifact-pins.json'));
  const bunLockText = await readFile(join(repoRoot, '.opencode', 'plugins', 'bun.lock'), 'utf8');
  const stagingRoot = await mkdtemp(join(tmpdir(), 'supply-produce-'));
  try {
    await materializeClosures({
      closuresRoot: join(repoRoot, '.buildkite', 'supply', 'closure'),
      stagingRoot,
      inventory,
    });
    const outputDir = upload ? join(stagingRoot, 'out') : join(process.cwd(), '.supply-out');
    const packaged = await packageArtifact({
      stagingRoot,
      inventory,
      resolutions: bunLockResolutions(bunLockText),
      approved: pins.approvedRuntimePlugin,
      outDir: outputDir,
    });
    const key = `${process.platform}-${process.arch}`;
    const pin = pins.platforms[key];
    if (!pin) {
      throw new SupplyContractError(`no pins entry for ${key}`);
    }
    if (!isSeedRequired(pin)) assertProducedMatchesPin(key, pin, packaged);
    const loader = await fetchPinnedOpencodeTarball({
      outDir: outputDir,
      bunLockText,
      inventory,
      platform: process.platform,
      arch: process.arch,
    });
    if (!upload) {
      console.log(
        `runtime closure packaged at ${outputDir} (archive ${packaged.tarSha256}, manifest ${packaged.manifestSha256}, ${packaged.entryCount} entries, ${packaged.bytes} bytes)`,
      );
      return;
    }
    execFileSync('buildkite-agent', ['artifact', 'upload', packaged.gzipPath], {
      stdio: 'inherit',
    });
    execFileSync('buildkite-agent', ['artifact', 'upload', loader.path], { stdio: 'inherit' });
    const receipt = buildSeedReceipt({
      platform: process.platform,
      arch: process.arch,
      pipeline: process.env.BUILDKITE_PIPELINE_SLUG ?? pins.artifactSource.pipeline,
      buildNumber: process.env.BUILDKITE_BUILD_NUMBER,
      gitHead: gitHead(),
      seededAt: new Date().toISOString(),
      archiveSha256: packaged.tarSha256,
      manifestSha256: packaged.manifestSha256,
      loaderIntegrity: loader.integrity,
      loaderSpecifier: loader.specifier,
    });
    process.stdout.write(receipt);
    execFileSync('buildkite-agent', ['meta-data', 'set', SEED_RECEIPT_METADATA_KEY, receipt], {
      stdio: 'inherit',
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function argValue(args, flag, fallback) {
  const prefix = `${flag}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
