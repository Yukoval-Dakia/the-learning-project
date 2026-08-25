import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadPinnedArtifacts } from './supply-acquire.mjs';
import { consumeArtifact } from './supply-artifact-consume.mjs';
import {
  buildArtifactDownloadArgs,
  buildSeedReceipt,
  bunLockLoaderIntegrity,
  closureArtifactName,
  isSeedRequired,
  loadPins,
  loaderArtifactName,
  requirePinnedPlatform,
} from './supply-pins.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const pinsPath = join(repoRoot, '.buildkite', 'supply', 'runtime-artifact-pins.json');

const ZERO = '0'.repeat(64);
const ARCHIVE = 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const BUILD_ID = '01a03968-7cde-4675-9fb6-2cc900d8446a';

const BASE_PINS = {
  schemaVersion: 1,
  approvedRuntimePlugin: {
    package: '@opencode-ai/plugin',
    version: '1.18.18',
    ownerSpecifier: '@cortexkit/opencode-magic-context@0.33.0',
  },
  artifactSource: { pipeline: 'the-learning-project-ci-shadow' },
};

const runs: string[] = [];

async function pinsFile(entry: unknown, platformsKey = 'linux-x64') {
  const dir = await mkdtemp(join(tmpdir(), 'supply-pins-'));
  runs.push(dir);
  const path = join(dir, 'pins.json');
  await writeFile(path, JSON.stringify({ ...BASE_PINS, platforms: { [platformsKey]: entry } }));
  return path;
}

describe('runtime artifact pins validation', () => {
  it('rejects the all-zero placeholder digests outright', async () => {
    await expect(
      loadPins(await pinsFile({ archiveSha256: ZERO, manifestSha256: MANIFEST, seedBuild: 1 })),
    ).rejects.toThrow(/all-zero placeholder archiveSha256/);
    await expect(
      loadPins(await pinsFile({ archiveSha256: ARCHIVE, manifestSha256: ZERO, seedBuild: 1 })),
    ).rejects.toThrow(/all-zero placeholder manifestSha256/);
  });

  it('rejects missing digests, malformed digests, and placeholder seed flags', async () => {
    await expect(
      loadPins(await pinsFile({ manifestSha256: MANIFEST, seedBuild: 1 })),
    ).rejects.toThrow(/malformed or missing archiveSha256/);
    await expect(
      loadPins(
        await pinsFile({ archiveSha256: 'not-a-digest', manifestSha256: MANIFEST, seedBuild: 1 }),
      ),
    ).rejects.toThrow(/malformed or missing archiveSha256/);
    await expect(
      loadPins(await pinsFile({ archiveSha256: ARCHIVE, manifestSha256: MANIFEST })),
    ).rejects.toThrow(/missing the immutable Buildkite UUID seedBuild/);
    await expect(
      loadPins(await pinsFile({ archiveSha256: ARCHIVE, manifestSha256: MANIFEST, seedBuild: 0 })),
    ).rejects.toThrow(/immutable Buildkite UUID seedBuild/);
    await expect(loadPins(await pinsFile({ seedRequired: false }))).rejects.toThrow(
      /seedRequired: false/,
    );
  });

  it('rejects pins that lack the artifact source pipeline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'supply-pins-'));
    runs.push(dir);
    const path = join(dir, 'pins.json');
    await writeFile(
      path,
      JSON.stringify({
        ...BASE_PINS,
        artifactSource: {},
        platforms: { 'linux-x64': { seedRequired: true } },
      }),
    );
    await expect(loadPins(path)).rejects.toThrow(/artifactSource\.pipeline/);
  });

  it('accepts the bootstrap seedRequired state and a fully pinned state', async () => {
    const bootstrap = await loadPins(await pinsFile({ seedRequired: true }));
    expect(isSeedRequired(bootstrap.platforms['linux-x64'])).toBe(true);
    const pinned = await loadPins(
      await pinsFile({ archiveSha256: ARCHIVE, manifestSha256: MANIFEST, seedBuild: BUILD_ID }),
    );
    expect(isSeedRequired(pinned.platforms['linux-x64'])).toBe(false);
    expect(requirePinnedPlatform(pinned, 'linux-x64').seedBuild).toBe(BUILD_ID);
  });

  it('pins the seeded Linux artifact and keeps unseeded platforms fail-closed', async () => {
    const pins = await loadPins(pinsPath);
    expect(requirePinnedPlatform(pins, 'linux-x64')).toMatchObject({
      archiveSha256: '7fdebd02825b3f324e4ab1de34d10bd26fcbbd5a103a2bc43c360e049ade48fc',
      manifestSha256: '8f2b4d1595a92b81c33155f16a6fb4ed82d0715b31d67fcc81529b1713e1b63c',
      seedBuild: BUILD_ID,
    });
    expect(() => requirePinnedPlatform(pins, 'darwin-arm64')).toThrow(
      /bootstrap state \(seedRequired\)/,
    );
    expect(() => requirePinnedPlatform(pins, 'plan9-arm')).toThrow(
      /no pinned runtime artifact digests/,
    );
  });

  it('makes the consumer itself fail on bootstrap pins, not just the download step', async () => {
    const inventory = JSON.parse(
      await readFile(
        join(repoRoot, '.opencode', 'plugins', 'supply-chain', 'inventory.json'),
        'utf8',
      ),
    );
    await expect(
      consumeArtifact({
        archivePath: '/nonexistent.tar.gz',
        loaderPath: '/nonexistent-loader',
        pinsPath,
        inventory,
        bunLockText: '{}',
        workspaceTemplateDir: '/nonexistent-template',
        scratchRoot: join(tmpdir(), 'supply-consume-bootstrap'),
      }),
    ).rejects.toThrow(/bootstrap state \(seedRequired\)/);
  });
});

describe('cross-build artifact download arguments', () => {
  it('builds the exact buildkite-agent argv for a same-pipeline pinned build', () => {
    expect(
      buildArtifactDownloadArgs({
        artifactName: closureArtifactName(ARCHIVE),
        destination: 'artifacts',
        build: BUILD_ID,
        pipeline: 'the-learning-project-ci-shadow',
        currentPipeline: 'the-learning-project-ci-shadow',
      }),
    ).toEqual([
      'artifact',
      'download',
      `runtime-closure-${ARCHIVE}.tar.gz`,
      'artifacts',
      '--build',
      BUILD_ID,
      '--pipeline',
      'the-learning-project-ci-shadow',
    ]);
  });

  it('scopes a cross-pipeline source explicitly', () => {
    expect(
      buildArtifactDownloadArgs({
        artifactName: loaderArtifactName('linux', 'x64'),
        destination: 'artifacts',
        build: BUILD_ID,
        pipeline: 'the-supply-seed-pipeline',
        currentPipeline: 'the-learning-project-ci-shadow',
      }),
    ).toEqual([
      'artifact',
      'download',
      'opencode-loader-linux-x64.tgz',
      'artifacts',
      '--build',
      BUILD_ID,
      '--pipeline',
      'the-supply-seed-pipeline',
    ]);
  });

  it('downloads the digest-named closure and loader, in that order, from the pinned build', async () => {
    const pins = await loadPins(
      await pinsFile({ archiveSha256: ARCHIVE, manifestSha256: MANIFEST, seedBuild: BUILD_ID }),
    );
    const calls: unknown[][] = [];
    const downloaded = downloadPinnedArtifacts({
      pins,
      platform: 'linux',
      arch: 'x64',
      downloadDir: 'artifacts',
      currentPipeline: 'the-learning-project-ci-shadow',
      runAgent: (argv: unknown[]) => {
        calls.push(argv);
      },
    });
    expect(calls).toEqual([
      [
        'artifact',
        'download',
        `runtime-closure-${ARCHIVE}.tar.gz`,
        'artifacts',
        '--build',
        BUILD_ID,
        '--pipeline',
        'the-learning-project-ci-shadow',
      ],
      [
        'artifact',
        'download',
        'opencode-loader-linux-x64.tgz',
        'artifacts',
        '--build',
        BUILD_ID,
        '--pipeline',
        'the-learning-project-ci-shadow',
      ],
    ]);
    expect(downloaded.archivePath).toBe(`artifacts/runtime-closure-${ARCHIVE}.tar.gz`);
    expect(downloaded.loaderPath).toBe('artifacts/opencode-loader-linux-x64.tgz');
  });

  it('refuses to download while the platform is still in the bootstrap state', async () => {
    const pins = await loadPins(await pinsFile({ seedRequired: true }));
    expect(() =>
      downloadPinnedArtifacts({
        pins,
        platform: 'linux',
        arch: 'x64',
        downloadDir: 'artifacts',
        currentPipeline: 'the-learning-project-ci-shadow',
        runAgent: () => {
          throw new Error('runAgent must not be called for bootstrap pins');
        },
      }),
    ).toThrow(/bootstrap state \(seedRequired\)/);
  });
});

describe('seed receipt', () => {
  const RECEIPT_FIELDS = {
    platform: 'linux',
    arch: 'x64',
    pipeline: 'the-learning-project-ci-shadow',
    buildNumber: '42',
    gitHead: 'f'.repeat(40),
    seededAt: '2026-08-25T23:00:00.000Z',
    loaderIntegrity: 'sha512-loaderintegrity',
    loaderSpecifier: 'opencode-linux-x64@1.18.10',
  };

  it('builds the machine-readable receipt with digest-named artifacts', () => {
    const receipt = JSON.parse(
      buildSeedReceipt({ ...RECEIPT_FIELDS, archiveSha256: ARCHIVE, manifestSha256: MANIFEST }),
    );
    expect(receipt.kind).toBe('supply-seed-receipt');
    expect(receipt.closureArtifact).toBe(`runtime-closure-${ARCHIVE}.tar.gz`);
    expect(receipt.loaderArtifact).toBe('opencode-loader-linux-x64.tgz');
    expect(receipt.buildNumber).toBe('42');
  });

  it('rejects zero or missing digests and placeholder fields', () => {
    expect(() =>
      buildSeedReceipt({ ...RECEIPT_FIELDS, archiveSha256: ZERO, manifestSha256: MANIFEST }),
    ).toThrow(/real non-zero sha256/);
    expect(() =>
      buildSeedReceipt({ ...RECEIPT_FIELDS, archiveSha256: ARCHIVE, manifestSha256: ZERO }),
    ).toThrow(/real non-zero sha256/);
    const { buildNumber, ...withoutBuildNumber } = RECEIPT_FIELDS;
    void buildNumber;
    expect(() =>
      buildSeedReceipt({ ...withoutBuildNumber, archiveSha256: ARCHIVE, manifestSha256: MANIFEST }),
    ).toThrow(/field buildNumber is missing/);
    expect(() =>
      buildSeedReceipt({
        ...RECEIPT_FIELDS,
        archiveSha256: ARCHIVE,
        manifestSha256: MANIFEST,
        loaderIntegrity: 'sha256-nope',
      }),
    ).toThrow(/sha512/);
  });

  it('derives the loader integrity from the committed bun.lock', async () => {
    const bunLockText = await readFile(join(repoRoot, '.opencode', 'plugins', 'bun.lock'), 'utf8');
    expect(bunLockLoaderIntegrity(bunLockText, 'linux', 'x64', '1.18.10')).toMatch(/^sha512-/);
    expect(() => bunLockLoaderIntegrity(bunLockText, 'linux', 'x64', '0.0.1')).toThrow(
      /no opencode-linux-x64@0\.0\.1 resolution/,
    );
  });
});

afterEach(async () => {
  await Promise.all(runs.map((dir) => rm(dir, { recursive: true, force: true })));
  runs.length = 0;
});
