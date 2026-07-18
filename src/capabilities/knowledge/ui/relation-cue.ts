export interface RelationCue {
  glyph: string;
  dash: string;
  label: string;
  arrow: boolean;
}

// Five typed-edge cues shared by the graph, node drawer, and detail page.
// Keep this module dependency-free so text-only surfaces do not pull in the
// Cytoscape/fcose layout engine through MeshGraph.
export const REL_CUE: Record<string, RelationCue> = {
  prerequisite: { glyph: '→', dash: '0', label: '前置', arrow: true },
  related_to: { glyph: '—', dash: '0', label: '相关', arrow: false },
  contrasts_with: { glyph: '⇆', dash: '5 4', label: '对比', arrow: false },
  applied_in: { glyph: '↦', dash: '1 5', label: '应用', arrow: true },
  derived_from: { glyph: '↳', dash: '8 3', label: '派生', arrow: true },
};
