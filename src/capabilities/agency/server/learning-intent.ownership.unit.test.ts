import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const OWNED_MODULE = 'src/capabilities/agency/server/learning-intent.ts';

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('Agency learning-intent ownership', () => {
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

    const composition = source('src/capabilities/agency/server/proposal-accept-applier.ts');
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
