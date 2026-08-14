import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RETIRED_MODULE_NAMES = [
  'confusable-contrast-discovery',
  'evidence-demand',
  'inventory-projection',
  'jyeoo-supply-config',
  'route-planner',
  'target-discovery',
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
  it('keeps the six predecessor modules deleted and rejects their legacy import paths', () => {
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
});
