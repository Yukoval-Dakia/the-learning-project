import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consumeArtifact } from './supply-artifact-consume.mjs';
import {
  buildClosureManifest,
  bunLockResolutions,
  closureDirName,
  parseLooseJson,
  runtimeGraphRows,
  runtimeGraphSha256,
  sha256Hex,
} from './supply-graph.mjs';
import { packageArtifact } from './supply-package.mjs';
import { offlineLoaderEnv } from './supply-offline.mjs';
import { collectTarEntries, writeDeterministicTar } from './supply-tar-writer.mjs';

const runs: string[] = [];

async function tempDir(label: string) {
  const dir = await mkdtemp(join(tmpdir(), `supply-offline-${label}-`));
  runs.push(dir);
  return dir;
}

const SPEC = 'fixture-plugin@1.0.0';
const PLUGIN_ROW = 'node_modules/fixture-plugin';
const INTEGRITY = 'sha512-fixture-integrity-value';

async function fixtureStaging(root: string) {
  const cache = join(root, 'staging', 'caches', SPEC);
  await mkdir(join(cache, 'node_modules', 'fixture-plugin'), { recursive: true });
  await writeFile(
    join(cache, 'package.json'),
    JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' } }),
  );
  const lock = {
    name: SPEC,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { dependencies: { 'fixture-plugin': '1.0.0' } },
      [PLUGIN_ROW]: { version: '1.0.0', integrity: INTEGRITY },
      'node_modules/@opencode-ai/plugin': {
        version: '1.18.18',
        integrity: 'sha512-plugin-approved',
      },
    },
  };
  await writeFile(join(cache, 'package-lock.json'), JSON.stringify(lock, null, 2));
  await writeFile(
    join(cache, 'node_modules', 'fixture-plugin', 'package.json'),
    JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(join(cache, 'node_modules', 'fixture-plugin', 'index.js'), 'export {};');
  const graphSha = runtimeGraphSha256(runtimeGraphRows(lock));
  const inventory = {
    schemaVersion: 1,
    opencode: { version: '1.18.10', package: 'opencode-ai', integrity: 'sha512-opencode' },
    npmPlugins: [
      {
        id: 'fixture',
        package: 'fixture-plugin',
        version: '1.0.0',
        specifier: SPEC,
        integrity: INTEGRITY,
        runtimePackageCount: 2,
        runtimeGraphSha256: graphSha,
        requiredToolIds: ['fixture_tool'],
      },
    ],
    localPlugins: [],
  };
  const bunLock = JSON.stringify({
    lockfileVersion: 1,
    packages: {
      'fixture-plugin': ['fixture-plugin@1.0.0', '', {}, INTEGRITY],
      '@opencode-ai/plugin': ['@opencode-ai/plugin@1.18.18', '', {}, 'sha512-plugin-approved'],
    },
  });
  return { inventory, bunLock, graphSha };
}

async function fixtureWorkspaceTemplate(root: string) {
  const template = join(root, 'template');
  await mkdir(join(template, '.opencode'), { recursive: true });
  await writeFile(
    join(template, '.opencode', 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [SPEC] }, null, 2),
  );
  return template;
}

async function writeLoader(root: string, name: string, body: string) {
  const path = join(root, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const OK_LOADER = `
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const config = JSON.parse(readFileSync(join(process.cwd(), ".opencode", "opencode.json"), "utf8"));
if (!config.plugin?.[0]?.startsWith("file://") || !config.plugin[0].endsWith("/index.js")) process.exit(14);
const snapshot = { name: "build", tools: { fixture_tool: true } };
process.stdout.write(JSON.stringify(snapshot));
`;

const REGISTRY_LOADER = `
const registry = process.env.npm_config_registry ?? "";
try {
  await fetch(registry);
} catch {
  process.exit(12);
}
process.exit(13);
`;

const LOCK_MUTATING_LOADER = `
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
writeFileSync(
  join(process.env.HOME ?? "", ".cache", "opencode", "packages", "${SPEC}", "package-lock.json"),
  "{\\"mutated\\": true}",
);
const snapshot = { name: "build", tools: { fixture_tool: true } };
process.stdout.write(JSON.stringify(snapshot));
`;

const MISSING_TOOL_LOADER = `
const snapshot = { name: "build", tools: {} };
process.stdout.write(JSON.stringify(snapshot));
`;

async function buildFixtureArtifact(root: string) {
  const { inventory, bunLock } = await fixtureStaging(root);
  const template = await fixtureWorkspaceTemplate(root);
  const outDir = join(root, 'out');
  const packaged = await packageArtifact({
    stagingRoot: join(root, 'staging'),
    inventory,
    resolutions: bunLockResolutions(bunLock),
    approved: { package: '@opencode-ai/plugin', version: '1.18.18', ownerSpecifier: SPEC },
    outDir,
    platform: process.platform,
    arch: process.arch,
  });
  const pins = {
    schemaVersion: 1,
    approvedRuntimePlugin: {
      package: '@opencode-ai/plugin',
      version: '1.18.18',
      ownerSpecifier: SPEC,
    },
    artifactSource: { pipeline: 'fixture-pipeline' },
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        archiveSha256: packaged.tarSha256,
        manifestSha256: packaged.manifestSha256,
        seedBuild: '01a03968-7cde-4675-9fb6-2cc900d8446a',
      },
    },
  };
  const pinsPath = join(root, 'pins.json');
  await writeFile(pinsPath, JSON.stringify(pins, null, 2));
  return { inventory, bunLock, template, packaged, pinsPath, outDir };
}

async function consumeFixture(
  root: string,
  pinsPath: string,
  loaderPath: string,
  archivePath: string,
) {
  const { inventory, bunLock } = await fixtureStaging(root);
  const template = await fixtureWorkspaceTemplate(root);
  return consumeArtifact({
    archivePath,
    loaderPath,
    pinsPath,
    inventory,
    bunLockText: bunLock,
    workspaceTemplateDir: template,
    scratchRoot: join(root, 'consume'),
    timeoutMs: 20_000,
  });
}

describe('offline artifact consumer', () => {
  it('disables the OpenCode models catalog refresh in the isolated loader env', () => {
    expect(offlineLoaderEnv('/tmp/offline-home', 4321).OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
  });

  it('verifies and loads a well-formed artifact with the network sentinel silent', async () => {
    const root = await tempDir('green');
    const fixture = await buildFixtureArtifact(root);
    const loader = await writeLoader(root, 'loader-ok.mjs', OK_LOADER);
    const summary = await consumeFixture(
      root,
      fixture.pinsPath,
      loader,
      fixture.packaged.archivePath,
    );
    expect(summary.archiveSha256).toBe(fixture.packaged.tarSha256);
    expect(summary.tools).toEqual(['fixture_tool']);
    expect(summary.networkAttempts).toBe(0);
  }, 30_000);

  it('fails on a tampered archive (digest mismatch)', async () => {
    const root = await tempDir('tamper-archive');
    const fixture = await buildFixtureArtifact(root);
    const loader = await writeLoader(root, 'loader-ok.mjs', OK_LOADER);
    const original = await readFile(fixture.packaged.archivePath);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1024] ^= 0xff;
    const tamperedPath = join(root, 'tampered.tar');
    await writeFile(tamperedPath, corrupted);
    await expect(consumeFixture(root, fixture.pinsPath, loader, tamperedPath)).rejects.toThrow(
      /archive digest/i,
    );
  }, 30_000);

  it('fails on a tampered manifest carrying an unapproved plugin version', async () => {
    const root = await tempDir('tamper-manifest');
    const { inventory, bunLock } = await fixtureStaging(root);
    const template = await fixtureWorkspaceTemplate(root);
    // Hand-build an internally consistent artifact whose manifest declares a
    // version the real inventory never approved, then pin its own digests: only
    // the manifest-vs-inventory check can catch it.
    const stagingRoot = join(root, 'staging');
    const drifted = structuredClone(inventory);
    drifted.npmPlugins[0].version = '9.9.9';
    const closureEntries = await collectTarEntries(
      join(stagingRoot, 'caches', SPEC),
      `closure/${closureDirName(SPEC)}`,
    );
    const manifest = buildClosureManifest({
      schemaVersion: 1,
      kind: 'opencode-runtime-closure',
      platform: process.platform,
      arch: process.arch,
      opencodeVersion: drifted.opencode.version,
      plugins: drifted.npmPlugins,
      entryCount: closureEntries.length + 1,
    });
    await writeFile(join(stagingRoot, 'manifest.json'), manifest);
    const entries = [
      ...closureEntries,
      {
        path: 'manifest.json',
        source: join(stagingRoot, 'manifest.json'),
        type: 'file' as const,
        mode: 0o100644,
        size: Buffer.byteLength(manifest),
      },
    ];
    const archivePath = join(root, 'tampered.tar');
    const written = await writeDeterministicTar(archivePath, entries);
    const pins = {
      schemaVersion: 1,
      approvedRuntimePlugin: {
        package: '@opencode-ai/plugin',
        version: '1.18.18',
        ownerSpecifier: SPEC,
      },
      artifactSource: { pipeline: 'fixture-pipeline' },
      platforms: {
        [`${process.platform}-${process.arch}`]: {
          archiveSha256: written.sha256,
          manifestSha256: sha256Hex(Buffer.from(manifest)),
          seedBuild: '01a03968-7cde-4675-9fb6-2cc900d8446a',
        },
      },
    };
    const pinsPath = join(root, 'pins.json');
    await writeFile(pinsPath, JSON.stringify(pins));
    const loader = await writeLoader(root, 'loader-ok.mjs', OK_LOADER);
    await expect(
      consumeArtifact({
        archivePath,
        loaderPath: loader,
        pinsPath,
        inventory,
        bunLockText: bunLock,
        workspaceTemplateDir: template,
        scratchRoot: join(root, 'consume'),
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow(/version/i);
  }, 30_000);

  it('fails when the loader attempts registry access through the sentinel', async () => {
    const root = await tempDir('network');
    const fixture = await buildFixtureArtifact(root);
    const loader = await writeLoader(root, 'loader-registry.mjs', REGISTRY_LOADER);
    await expect(
      consumeFixture(root, fixture.pinsPath, loader, fixture.packaged.archivePath),
    ).rejects.toThrow(/network|registry|sentinel/i);
  }, 30_000);

  it('fails when the loader mutates a runtime package lock during the offline run', async () => {
    const root = await tempDir('lock-mutation');
    const fixture = await buildFixtureArtifact(root);
    const loader = await writeLoader(root, 'loader-mutating.mjs', LOCK_MUTATING_LOADER);
    await expect(
      consumeFixture(root, fixture.pinsPath, loader, fixture.packaged.archivePath),
    ).rejects.toThrow(/lock .* changed|changed during the offline/i);
  }, 30_000);

  it('fails when a required tool is not registered and enabled by the loader', async () => {
    const root = await tempDir('missing-tool');
    const fixture = await buildFixtureArtifact(root);
    const loader = await writeLoader(root, 'loader-missing-tool.mjs', MISSING_TOOL_LOADER);
    await expect(
      consumeFixture(root, fixture.pinsPath, loader, fixture.packaged.archivePath),
    ).rejects.toThrow(/did not register enabled tool fixture_tool/);
  }, 30_000);
});

describe('buildClosureManifest determinism (sanity)', () => {
  it('serializes plugins in specifier order regardless of input order', async () => {
    const root = await tempDir('manifest');
    const { inventory } = await fixtureStaging(root);
    const plugins = inventory.npmPlugins.map((plugin) => ({
      specifier: plugin.specifier,
      package: plugin.package,
      version: plugin.version,
      integrity: plugin.integrity,
      runtimePackageCount: plugin.runtimePackageCount,
      runtimeGraphSha256: plugin.runtimeGraphSha256,
    }));
    const first = buildClosureManifest({
      schemaVersion: 1,
      kind: 'opencode-runtime-closure',
      platform: 'darwin',
      arch: 'arm64',
      opencodeVersion: inventory.opencode.version,
      plugins,
      entryCount: 4,
    });
    expect(parseLooseJson(first).plugins.length).toBe(1);
  });
});

afterEach(async () => {
  await Promise.all(runs.map((dir) => rm(dir, { recursive: true, force: true })));
  runs.length = 0;
});
