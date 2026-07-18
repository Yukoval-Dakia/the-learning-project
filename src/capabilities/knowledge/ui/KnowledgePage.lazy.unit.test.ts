import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('KnowledgePage graph loading boundary', () => {
  it('loads the Cytoscape-bearing graph only after the graph view is rendered', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/capabilities/knowledge/ui/KnowledgePage.tsx'),
      'utf8',
    );

    expect(source).not.toMatch(/^import\s+\{\s*MeshGraph\s*\}\s+from\s+['"]\.\/MeshGraph['"];?$/m);
    expect(source).toContain("await import('./MeshGraph')");
    expect(source).toContain('<Suspense');
    expect(source).toContain('<output');
    expect(source).toContain('aria-live="polite"');
  });
});
