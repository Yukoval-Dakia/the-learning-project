// cytoscape-fcose ships no type definitions of its own (verified 2026-05-29,
// v2.2.0 — package.json has no "types" field, no bundled .d.ts). This minimal
// declaration types the default export as a cytoscape extension factory so it
// can be passed to `cytoscape.use(fcose)`. cytoscape exposes its types via the
// `export = cytoscape` namespace, so we reference `cytoscape.Ext` rather than a
// named import. Drop this file if upstream ships its own types.
declare module 'cytoscape-fcose' {
  import type cytoscape from 'cytoscape';

  // The fcose layout option bag (subset we use + permissive index for the rest
  // of fcose's many tuning knobs — see the upstream README). `name` is fixed to
  // the registered layout id.
  export interface FcoseLayoutOptions {
    name: 'fcose';
    quality?: 'draft' | 'default' | 'proof';
    randomize?: boolean;
    animate?: boolean;
    animationDuration?: number;
    fit?: boolean;
    padding?: number;
    nodeSeparation?: number;
    nodeRepulsion?: number | ((node: cytoscape.NodeSingular) => number);
    idealEdgeLength?: number | ((edge: cytoscape.EdgeSingular) => number);
    [key: string]: unknown;
  }

  const fcose: cytoscape.Ext;
  export default fcose;
}
