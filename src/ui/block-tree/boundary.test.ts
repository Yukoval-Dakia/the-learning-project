import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('block-tree bundle boundary', () => {
  it('keeps the read renderer free of TipTap editor runtime imports', () => {
    const renderer = readFileSync(join(root, 'src/ui/block-tree/BlockTreeRenderer.tsx'), 'utf8');
    expect(renderer).not.toContain('@tiptap/react');
    expect(renderer).not.toContain('EditorContent');
    expect(renderer).not.toContain('useEditor');
  });

  it('loads the editor through a dynamic client boundary', () => {
    const panel = readFileSync(join(root, 'src/ui/block-tree/ArtifactBlockTree.tsx'), 'utf8');
    expect(panel).toContain('dynamic(');
    expect(panel).toContain("import('./BlockTreeEditor')");
    expect(panel).not.toContain("from './BlockTreeEditor'");
  });
});
