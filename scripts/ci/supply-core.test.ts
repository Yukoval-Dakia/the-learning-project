import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildClosureManifest,
  bunLockResolutions,
  closureDirName,
  parseLooseJson,
  runtimeGraphRows,
  runtimeGraphSha256,
  validateClosureGraph,
  validateManifestAgainstInventory,
} from './supply-graph.mjs';
import { loadPins } from './supply-pins.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const supplyRoot = join(repoRoot, '.buildkite', 'supply');

const REAL_SPECS = [
  '@cortexkit/opencode-magic-context@0.33.0',
  '@zenobius/opencode-skillful@1.2.5',
  'oh-my-openagent@4.17.0',
];

async function loadInventory() {
  return parseLooseJson(
    await readFile(
      join(repoRoot, '.opencode', 'plugins', 'supply-chain', 'inventory.json'),
      'utf8',
    ),
  ) as Promise<{
    opencode: { version: string };
    npmPlugins: Array<{
      id: string;
      package: string;
      version: string;
      specifier: string;
      integrity: string;
      runtimePackageCount: number;
      runtimeGraphSha256: string;
      requiredToolIds: string[];
    }>;
  }>;
}

describe('loose JSON parsing', () => {
  it('parses the real bun.lock despite trailing commas', async () => {
    const text = await readFile(join(repoRoot, '.opencode', 'plugins', 'bun.lock'), 'utf8');
    const lock = parseLooseJson(text) as { packages: Record<string, string[]> };
    expect(Object.keys(lock.packages).length).toBeGreaterThan(300);
  });

  it('keeps commas that live inside string literals', () => {
    const parsed = parseLooseJson('{"a": "x, y", "b": [1, 2,],}') as Record<string, unknown>;
    expect(parsed.a).toBe('x, y');
    expect(parsed.b).toEqual([1, 2]);
  });
});

describe('runtime graph validation', () => {
  it('committed closures reproduce the inventory-approved graphs', async () => {
    const inventory = await loadInventory();
    const resolutions = bunLockResolutions(
      await readFile(join(repoRoot, '.opencode', 'plugins', 'bun.lock'), 'utf8'),
    );
    for (const spec of REAL_SPECS) {
      const plugin = inventory.npmPlugins.find((entry) => entry.specifier === spec);
      expect(plugin, `inventory entry for ${spec}`).toBeTruthy();
      if (!plugin) continue;
      const lock = parseLooseJson(
        await readFile(
          join(supplyRoot, 'closure', closureDirName(spec), 'package-lock.json'),
          'utf8',
        ),
      );
      const rows = runtimeGraphRows(lock);
      expect(runtimeGraphSha256(rows)).toBe(plugin.runtimeGraphSha256);
      expect(() => validateClosureGraph(lock, plugin, resolutions)).not.toThrow();
    }
  });

  it('flags a graph row that is absent from the approved bun.lock superset', () => {
    const lock = {
      packages: {
        '': { dependencies: { 'fixture-plugin': '1.0.0' } },
        'node_modules/fixture-plugin': {
          version: '1.0.0',
          integrity: 'sha512-approved',
        },
        'node_modules/rogue-dep': {
          version: '9.9.9',
          integrity: 'sha512-rogue',
        },
      },
    };
    const plugin = {
      id: 'fixture',
      package: 'fixture-plugin',
      version: '1.0.0',
      specifier: 'fixture-plugin@1.0.0',
      integrity: 'sha512-approved',
      runtimePackageCount: 2,
      runtimeGraphSha256: runtimeGraphSha256(runtimeGraphRows(lock)),
      requiredToolIds: [],
    };
    const resolutions = new Set([JSON.stringify(['fixture-plugin', '1.0.0', 'sha512-approved'])]);
    expect(() => validateClosureGraph(lock, plugin, resolutions)).toThrow(/not in bun\.lock/);
  });

  it('enforces the approved @opencode-ai/plugin resolution inside the owner closure', () => {
    const lock = {
      packages: {
        '': {},
        'node_modules/fixture-plugin': { version: '1.0.0', integrity: 'sha512-approved' },
        'node_modules/@opencode-ai/plugin': {
          version: '1.18.23',
          integrity: 'sha512-drifted',
        },
      },
    };
    const plugin = {
      id: 'fixture',
      package: 'fixture-plugin',
      version: '1.0.0',
      specifier: 'fixture-plugin@1.0.0',
      integrity: 'sha512-approved',
      runtimePackageCount: 2,
      runtimeGraphSha256: runtimeGraphSha256(runtimeGraphRows(lock)),
      requiredToolIds: [],
    };
    const resolutions = new Set([
      JSON.stringify(['fixture-plugin', '1.0.0', 'sha512-approved']),
      JSON.stringify(['@opencode-ai/plugin', '1.18.23', 'sha512-drifted']),
    ]);
    const approved = {
      package: '@opencode-ai/plugin',
      version: '1.18.18',
      ownerSpecifier: 'fixture-plugin@1.0.0',
    };
    expect(() => validateClosureGraph(lock, plugin, resolutions, approved)).toThrow(
      /@opencode-ai\/plugin.*1\.18\.18.*1\.18\.23/s,
    );
  });
});

describe('manifest and pins', () => {
  it('builds a deterministic manifest and validates it against the inventory', async () => {
    const inventory = await loadInventory();
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
      entryCount: 12,
    });
    const second = buildClosureManifest({
      arch: 'arm64',
      platform: 'darwin',
      plugins: [...plugins].reverse(),
      opencodeVersion: inventory.opencode.version,
      entryCount: 12,
      kind: 'opencode-runtime-closure',
      schemaVersion: 1,
    });
    expect(second).toBe(first);
    const parsed = parseLooseJson(first) as { plugins: unknown[] };
    expect(parsed.plugins.length).toBe(plugins.length);
    expect(() =>
      validateManifestAgainstInventory(parsed, inventory, {
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).not.toThrow();
  });

  it('rejects a manifest whose plugin version drifted from the inventory', async () => {
    const inventory = await loadInventory();
    const plugins = inventory.npmPlugins.map((plugin) => ({
      specifier: plugin.specifier,
      package: plugin.package,
      version: plugin.version,
      integrity: plugin.integrity,
      runtimePackageCount: plugin.runtimePackageCount,
      runtimeGraphSha256: plugin.runtimeGraphSha256,
    }));
    plugins[0] = { ...plugins[0], version: '0.99.0' };
    const manifest = parseLooseJson(
      buildClosureManifest({
        schemaVersion: 1,
        kind: 'opencode-runtime-closure',
        platform: 'darwin',
        arch: 'arm64',
        opencodeVersion: inventory.opencode.version,
        plugins,
        entryCount: 1,
      }),
    );
    expect(() =>
      validateManifestAgainstInventory(manifest, inventory, { platform: 'darwin', arch: 'arm64' }),
    ).toThrow(/version|inventory/i);
  });

  it('loads the committed supply pins in the fail-closed bootstrap state', async () => {
    const pins = await loadPins(join(supplyRoot, 'runtime-artifact-pins.json'));
    expect(pins.approvedRuntimePlugin).toEqual({
      package: '@opencode-ai/plugin',
      version: '1.18.18',
      ownerSpecifier: '@cortexkit/opencode-magic-context@0.33.0',
    });
    expect(pins.artifactSource.pipeline).toBe('the-learning-project-ci-shadow');
    expect(pins.platforms['darwin-arm64'].seedRequired).toBe(true);
    expect(pins.platforms['linux-x64'].seedRequired).toBe(true);
  });
});
