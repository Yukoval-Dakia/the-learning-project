import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RETIRED_MODULE_NAMES = [
  'confusable-contrast-discovery',
  'dispatcher',
  'evidence-demand',
  'inventory-projection',
  'jyeoo-loom-adapter',
  'jyeoo-spawn',
  'jyeoo-supply-config',
  'placement-starter-attempts',
  'placement-starter-identity',
  'placement-starter-store',
  'placement-starter',
  'placement-supply-lock',
  'refill',
  'route-planner',
  'target-discovery',
] as const;

const MOVED_RUNTIME_MODULE_NAMES = [
  'dispatcher',
  'jyeoo-loom-adapter',
  'jyeoo-spawn',
  'placement-starter-attempts',
  'placement-starter-identity',
  'placement-starter-store',
  'placement-starter',
  'placement-supply-lock',
  'refill',
] as const;

const SUPPLY_READ_MODULES = [
  'evidence-demand.ts',
  'jyeoo-loom-adapter.ts',
  'jyeoo-supply-config.ts',
  'placement-starter-identity.ts',
  'route-planner.ts',
  'target-discovery.ts',
] as const;

const DIRECTED_COMMAND_EXPORTS = [
  'dispatchSupplyTarget as dispatchPracticeSupplyTarget',
  'dispatchSupplyTargets as dispatchPracticeSupplyTargets',
  'spawnJyeooFetch as spawnPracticeJyeooFetch',
] as const;

const OWNERSHIP_TEST =
  'src/capabilities/practice/server/question-supply/ownership.unit.test.ts' as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.[cm]?[jt]sx?$/.test(name)
        ? [path]
        : [];
  });
}

describe('Practice question-supply ownership', () => {
  it('keeps predecessor modules deleted and rejects their legacy import paths', () => {
    const root = process.cwd();
    const retiredFiles = RETIRED_MODULE_NAMES.map(
      (name) => `src/server/question-supply/${name}.ts`,
    );
    expect(retiredFiles.filter((path) => existsSync(resolve(root, path)))).toEqual([]);

    const forbiddenImports = sourceFiles(resolve(root, 'src')).flatMap((path) => {
      const projectPath = relative(root, path);
      if (projectPath === OWNERSHIP_TEST) return [];
      const source = readFileSync(path, 'utf8');
      return RETIRED_MODULE_NAMES.filter((name) =>
        source.includes(`@/server/question-supply/${name}`),
      ).map((name) => `${projectPath}:@/server/question-supply/${name}`);
    });
    expect(forbiddenImports).toEqual([]);
  });

  it('requires non-Practice consumers to use the public seam instead of deep imports', () => {
    const root = process.cwd();
    const practiceRoot = resolve(root, 'src/capabilities/practice');
    const deepPrefix = ['@/capabilities/practice', 'server/question-supply'].join('/');
    const deepConsumers = sourceFiles(resolve(root, 'src'))
      .filter((path) => !path.startsWith(`${practiceRoot}/`))
      .filter((path) => readFileSync(path, 'utf8').includes(deepPrefix))
      .map((path) => relative(root, path));
    expect(deepConsumers).toEqual([]);
  });

  it('does not publish question-supply write operations as read DTOs', () => {
    const publicSurface = readFileSync(
      resolve(process.cwd(), 'src/capabilities/practice/public.ts'),
      'utf8',
    );
    expect(publicSurface).not.toContain('writeInventoryShadowComparisonEvents');
    expect(publicSurface).not.toContain('runInventoryShadowDualRead');
  });

  it('keeps published question-supply read ports free of queue and database mutations', () => {
    const supplyRoot = resolve(process.cwd(), 'src/capabilities/practice/server/question-supply');
    const mutations = [
      { label: 'boss.send', pattern: /boss\.send/ },
      { label: 'DB insert', pattern: /\b(?:db|tx|sp)\.insert\(/ },
      { label: 'DB update', pattern: /\b(?:db|tx|sp)\.update\(/ },
      { label: 'DB delete', pattern: /\b(?:db|tx|sp)\.delete\(/ },
    ] as const;
    const violations = SUPPLY_READ_MODULES.flatMap((moduleName) => {
      const source = readFileSync(resolve(supplyRoot, moduleName), 'utf8');
      return mutations
        .filter(({ pattern }) => pattern.test(source))
        .map(({ label }) => `${moduleName}:${label}`);
    });
    expect(violations).toEqual([]);
  });

  it('publishes supply side effects as explicitly directed Practice commands', () => {
    const publicSurface = readFileSync(
      resolve(process.cwd(), 'src/capabilities/practice/public.ts'),
      'utf8',
    );
    expect(
      DIRECTED_COMMAND_EXPORTS.filter((commandExport) => !publicSurface.includes(commandExport)),
    ).toEqual([]);
  });

  it('keeps owned supply implementations independent of the Practice public barrel', () => {
    const supplyRoot = resolve(process.cwd(), 'src/capabilities/practice/server/question-supply');
    const barrelConsumers = sourceFiles(supplyRoot)
      .filter((path) => relative(process.cwd(), path) !== OWNERSHIP_TEST)
      .filter((path) => readFileSync(path, 'utf8').includes('@/capabilities/practice/public'))
      .map((path) => relative(process.cwd(), path));
    expect(barrelConsumers).toEqual([]);
  });

  it('routes moved runtime dependencies through sanctioned owner and kernel seams', () => {
    const supplyRoot = resolve(process.cwd(), 'src/capabilities/practice/server/question-supply');
    const legacyServerConsumers = MOVED_RUNTIME_MODULE_NAMES.filter((moduleName) =>
      readFileSync(resolve(supplyRoot, `${moduleName}.ts`), 'utf8').includes('@/server/'),
    );
    expect(legacyServerConsumers).toEqual([]);
  });
});
