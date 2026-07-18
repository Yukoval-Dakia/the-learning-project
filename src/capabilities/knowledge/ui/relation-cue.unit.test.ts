import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REL_CUE } from './relation-cue';

const uiFile = (name: string) =>
  readFileSync(join(process.cwd(), 'src/capabilities/knowledge/ui', name), 'utf8');

describe('relation cue dependency boundary', () => {
  it('retains all five non-color relation cues', () => {
    expect(REL_CUE).toEqual({
      prerequisite: { glyph: '→', dash: '0', label: '前置', arrow: true },
      related_to: { glyph: '—', dash: '0', label: '相关', arrow: false },
      contrasts_with: { glyph: '⇆', dash: '5 4', label: '对比', arrow: false },
      applied_in: { glyph: '↦', dash: '1 5', label: '应用', arrow: true },
      derived_from: { glyph: '↳', dash: '8 3', label: '派生', arrow: true },
    });
  });

  it('keeps non-graph consumers away from the Cytoscape-bearing MeshGraph module', () => {
    const cueSource = uiFile('relation-cue.ts');
    const detailSource = uiFile('KnowledgeDetailPage.tsx');
    const drawerSource = uiFile('NodeDrawer.tsx');
    const graphSource = uiFile('MeshGraph.tsx');

    expect(cueSource).not.toMatch(/^import\s/m);
    expect(detailSource).toContain("from './relation-cue'");
    expect(drawerSource).toContain("from './relation-cue'");
    expect(graphSource).toContain("from './relation-cue'");
    expect(detailSource).not.toContain("from './MeshGraph'");
    expect(drawerSource).not.toContain("from './MeshGraph'");
  });
});
