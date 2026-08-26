import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';

export type MeshGraphNode = KnowledgeTreeNode & {
  readonly isGhost?: boolean;
};

export interface GhostEndpointResult {
  readonly nodes: MeshGraphNode[];
  readonly ghostIds: ReadonlySet<string>;
  readonly crossEdgeIds: ReadonlySet<string>;
}

export function deriveGhostEndpoints(
  scopedNodes: readonly KnowledgeTreeNode[],
  fullNodes: readonly KnowledgeTreeNode[],
  edges: readonly KnowledgeEdgeRow[],
): GhostEndpointResult {
  const scopedIds = new Set(scopedNodes.map((node) => node.id));
  const fullById = new Map(fullNodes.map((node) => [node.id, node]));
  const externalIds = new Set<string>();

  for (const edge of edges) {
    const fromIsScoped = scopedIds.has(edge.from_knowledge_id);
    const toIsScoped = scopedIds.has(edge.to_knowledge_id);
    if (fromIsScoped === toIsScoped) continue;
    externalIds.add(fromIsScoped ? edge.to_knowledge_id : edge.from_knowledge_id);
  }

  const ghostNodes = [...externalIds].flatMap((id) => {
    const node = fullById.get(id);
    return node ? [{ ...node, isGhost: true }] : [];
  });
  const ghostIds = new Set(ghostNodes.map((node) => node.id));
  const nodeIds = new Set([...scopedIds, ...ghostIds]);
  const crossEdgeIds = new Set(
    edges
      .filter(
        (edge) =>
          nodeIds.has(edge.from_knowledge_id) &&
          nodeIds.has(edge.to_knowledge_id) &&
          ghostIds.has(edge.from_knowledge_id) !== ghostIds.has(edge.to_knowledge_id),
      )
      .map((edge) => edge.id),
  );

  return {
    nodes: [...scopedNodes, ...ghostNodes],
    ghostIds,
    crossEdgeIds,
  };
}
