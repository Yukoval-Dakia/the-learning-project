import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LEGACY_MODULE = 'src/server/orchestrator/learning_intent.ts';
const OWNED_MODULE = 'src/capabilities/agency/server/learning-intent.ts';
const OWNERSHIP_TEST = 'src/capabilities/agency/server/learning-intent.ownership.unit.test.ts';

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

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

describe('Agency learning-intent ownership', () => {
  it('deletes the central implementation and all imports of its predecessor path', () => {
    expect(existsSync(resolve(ROOT, LEGACY_MODULE))).toBe(false);
    expect(existsSync(resolve(ROOT, OWNED_MODULE))).toBe(true);

    const legacyConsumers = sourceFiles(resolve(ROOT, 'src'))
      .filter((path) => relative(ROOT, path) !== OWNERSHIP_TEST)
      .filter((path) =>
        source(relative(ROOT, path)).includes('@/server/orchestrator/learning_intent'),
      )
      .map((path) => relative(ROOT, path));
    expect(legacyConsumers).toEqual([]);
  });

  it('composes exact Notes and Knowledge public commands without closing a write cycle', () => {
    const owned = source(OWNED_MODULE);
    expect(owned).not.toMatch(/\.insert\((?:artifact|knowledge)\)/);
    expect(owned).not.toContain('boss.send');
    expect(owned).toContain(
      "import type { CreateLearningIntentKnowledgeNodeFn } from '@/capabilities/knowledge/public'",
    );
    expect(owned).not.toMatch(
      /import\s+\{[^}]*\}\s+from ['"]@\/capabilities\/knowledge\/public['"]/,
    );

    expect(source('src/capabilities/notes/public.ts')).toContain('createLearningIntentNote');
    expect(source('src/capabilities/knowledge/public.ts')).toContain(
      'createLearningIntentKnowledgeNode',
    );

    const composition = source('src/server/proposals/accept-action.ts');
    expect(composition).toContain("from '@/capabilities/notes/public'");
    expect(composition).toContain("from '@/capabilities/knowledge/public'");
    expect(composition).toContain('createLearningIntentNote');
    expect(composition).toContain('createLearningIntentKnowledgeNode');

    expect(source('src/capabilities/notes/server/learning-intent-note.ts')).not.toContain(
      '@/capabilities/agency',
    );
    expect(source('src/capabilities/knowledge/server/learning-intent-knowledge.ts')).not.toContain(
      '@/capabilities/agency',
    );
  });
});
