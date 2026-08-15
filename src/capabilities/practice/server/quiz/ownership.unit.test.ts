import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RETIRED_QUIZ_MODULES = [
  'content-fingerprint',
  'fewshot-retrieve',
  'matcher-flags',
  'matcher',
  'pool-fetch',
  'selection-miss',
  'solve-lane',
  'sourcing-sequence',
] as const;

const RETIRED_JOB_MODULES = ['sourcing', 'jyeoo-fetch', 'quiz_gen'] as const;
const OWNERSHIP_TEST = 'src/capabilities/practice/server/quiz/ownership.unit.test.ts' as const;

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

describe('Practice quiz sourcing and generation ownership', () => {
  it('keeps predecessor modules deleted and rejects their legacy import paths', () => {
    const root = process.cwd();
    const retiredFiles = [
      ...RETIRED_QUIZ_MODULES.map((name) => `src/server/quiz/${name}.ts`),
      ...RETIRED_JOB_MODULES.map((name) => `src/server/boss/handlers/${name}.ts`),
    ];
    expect(retiredFiles.filter((path) => existsSync(resolve(root, path)))).toEqual([]);

    const forbiddenPrefixes = [
      ...RETIRED_QUIZ_MODULES.map((name) => `@/server/quiz/${name}`),
      ...RETIRED_JOB_MODULES.map((name) => `@/server/boss/handlers/${name}`),
    ];
    const forbiddenImports = sourceFiles(resolve(root, 'src')).flatMap((path) => {
      const projectPath = relative(root, path);
      if (projectPath === OWNERSHIP_TEST) return [];
      const source = readFileSync(path, 'utf8');
      return forbiddenPrefixes
        .filter((prefix) => source.includes(prefix))
        .map((prefix) => `${projectPath}:${prefix}`);
    });
    expect(forbiddenImports).toEqual([]);
  });

  it('requires non-Practice consumers to use the public seam instead of deep imports', () => {
    const root = process.cwd();
    const practiceRoot = resolve(root, 'src/capabilities/practice');
    const deepPrefixes = [
      ['@/capabilities/practice', 'server/quiz'].join('/'),
      ['@/capabilities/practice', 'jobs/sourcing'].join('/'),
      ['@/capabilities/practice', 'jobs/jyeoo-fetch'].join('/'),
      ['@/capabilities/practice', 'jobs/quiz_gen'].join('/'),
    ];
    const deepConsumers = sourceFiles(resolve(root, 'src'))
      .filter((path) => !path.startsWith(`${practiceRoot}/`))
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return deepPrefixes
          .filter((prefix) => source.includes(prefix))
          .map((prefix) => `${relative(root, path)}:${prefix}`);
      });
    expect(deepConsumers).toEqual([]);
  });

  it('removes the three predecessor registrations from handlers.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/server/boss/handlers.ts'), 'utf8');
    for (const name of RETIRED_JOB_MODULES) {
      expect(source, name).not.toContain(`./handlers/${name}`);
      expect(source, name).not.toContain(`createJobQueue(boss, '${name}'`);
    }
  });

  it('keeps owned sourcing and generation modules independent of the public barrel', () => {
    const root = process.cwd();
    const files = [
      ...RETIRED_QUIZ_MODULES.map((name) =>
        resolve(root, 'src/capabilities/practice/server/quiz', `${name}.ts`),
      ),
      ...RETIRED_JOB_MODULES.map((name) =>
        resolve(root, 'src/capabilities/practice/jobs', `${name}.ts`),
      ),
    ];
    expect(
      files
        .filter((path) => readFileSync(path, 'utf8').includes('@/capabilities/practice/public'))
        .map((path) => relative(root, path)),
    ).toEqual([]);
  });
});
