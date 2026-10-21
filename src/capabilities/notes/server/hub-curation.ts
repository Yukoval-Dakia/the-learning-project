// Pure hub mesh curation (ADR-0020 §9). Given a hub, the loaded tree, mesh edges
// and candidate atomics, decide which atomics join the auto-zone and which
// relation chip to show. All inputs are in-memory; no IO.
//
// An atomic is included when any holds against the hub's knowledge_ids:
//   subtopic: atomic ids are contained in the hub's ids, or its node is a tree
//             descendant;
//   prerequisite: incoming edge to the hub;
//   derived_from: an edge whose `to` is in the hub (ADR-0010: from 派生自 to, so
//                 the atomic is the derived node);
//   contrasts_with: either endpoint in the hub.
// related_to/applied_in and experimental:* are excluded.
//
// Rule priority: subtopic > prerequisite > derived_from > contrasts_with.

// Only the tree backbone the algorithm reads; wider knowledge rows remain assignable.
export interface HubMeshNode {
  id: string;
  parent_id: string | null;
}

// Relation provenance shown on the curated atomic's chip.
export type HubMeshRelation = 'subtopic' | 'prerequisite' | 'derived_from' | 'contrasts_with';

// Most specific matching relation wins the chip.
const RELATION_PRIORITY: HubMeshRelation[] = [
  'subtopic',
  'prerequisite',
  'derived_from',
  'contrasts_with',
];

// Excluded relations; experimental:* is matched by prefix.
const EXCLUDED_RELATIONS = new Set(['related_to', 'applied_in']);

function isExcludedRelation(relationType: string): boolean {
  return EXCLUDED_RELATIONS.has(relationType) || relationType.startsWith('experimental:');
}

// Edge shape shared by both edge row types.
export interface HubMeshEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

// Candidate artifact shape the curation needs.
export interface HubMeshAtomicInput {
  artifact_id: string;
  title: string;
  knowledge_ids: string[];
}

export interface HubMeshInput {
  hub_artifact_id: string;
  knowledge_ids: string[];
}

export interface CuratedAtomic {
  artifact_id: string;
  title: string;
  /** Strongest matching relation. */
  relation: HubMeshRelation;
}

/**
 * Tree descendants of rootIds, multi-level. Roots are excluded; literal
 * containment of the hub's own ids is handled by the subtopic rule.
 */
export function treeDescendantIds(nodes: HubMeshNode[], rootIds: Iterable<string>): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parent_id) {
      const list = childrenByParent.get(node.parent_id) ?? [];
      list.push(node.id);
      childrenByParent.set(node.parent_id, list);
    }
  }

  const descendants = new Set<string>();
  const queue: string[] = [...rootIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (!descendants.has(childId)) {
        descendants.add(childId);
        queue.push(childId);
      }
    }
  }
  return descendants;
}

/**
 * Knowledge ids reachable from the hub per mesh relation; set algebra over loaded
 * edges, not a pg array query.
 */
function meshRelatedKnowledgeIds(
  edges: HubMeshEdge[],
  hubKnowledgeIds: Set<string>,
): Record<Exclude<HubMeshRelation, 'subtopic'>, Set<string>> {
  const prerequisite = new Set<string>();
  const derived_from = new Set<string>();
  const contrasts_with = new Set<string>();

  for (const edge of edges) {
    if (isExcludedRelation(edge.relation_type)) continue;

    const fromInHub = hubKnowledgeIds.has(edge.from_knowledge_id);
    const toInHub = hubKnowledgeIds.has(edge.to_knowledge_id);

    switch (edge.relation_type) {
      case 'prerequisite':
        // Incoming: `to` in hub → `from` is a prerequisite of the hub.
        if (toInHub && !fromInHub) prerequisite.add(edge.from_knowledge_id);
        break;
      case 'derived_from':
        // ADR-0010: `from 派生自 to`; `to` in hub → `from` is the derived node.
        if (toInHub && !fromInHub) derived_from.add(edge.from_knowledge_id);
        break;
      case 'contrasts_with':
        // Symmetric: either endpoint in the hub pulls in the other.
        if (toInHub && !fromInHub) contrasts_with.add(edge.from_knowledge_id);
        if (fromInHub && !toInHub) contrasts_with.add(edge.to_knowledge_id);
        break;
      default:
        // Already filtered by isExcludedRelation; stay defensive.
        break;
    }
  }

  return { prerequisite, derived_from, contrasts_with };
}

/**
 * Atomics in the hub's auto-zone with their strongest relation. The hub itself is
 * excluded; output is stable-sorted so the worker's diff is deterministic.
 */
export function resolveHubMeshAtomics(
  nodes: HubMeshNode[],
  edges: HubMeshEdge[],
  hub: HubMeshInput,
  atomics: HubMeshAtomicInput[],
): CuratedAtomic[] {
  const hubKnowledgeIds = new Set(hub.knowledge_ids);
  if (hubKnowledgeIds.size === 0) return [];

  // Subtopic rule: hub ids plus all tree descendants.
  const subtopicKnowledgeIds = new Set<string>(hubKnowledgeIds);
  for (const id of treeDescendantIds(nodes, hubKnowledgeIds)) subtopicKnowledgeIds.add(id);

  const mesh = meshRelatedKnowledgeIds(edges, hubKnowledgeIds);

  const curated: CuratedAtomic[] = [];
  for (const atomic of atomics) {
    if (atomic.artifact_id === hub.hub_artifact_id) continue;
    const atomicKnowledgeIds = atomic.knowledge_ids;
    if (atomicKnowledgeIds.length === 0) continue;

    const matched = new Set<HubMeshRelation>();

    // Every atomic id in the subtopic set counts as subtopic.
    if (atomicKnowledgeIds.every((id) => subtopicKnowledgeIds.has(id))) {
      matched.add('subtopic');
    }
    // Mesh rules: any atomic id in the relation's reachable set.
    if (atomicKnowledgeIds.some((id) => mesh.prerequisite.has(id))) matched.add('prerequisite');
    if (atomicKnowledgeIds.some((id) => mesh.derived_from.has(id))) matched.add('derived_from');
    if (atomicKnowledgeIds.some((id) => mesh.contrasts_with.has(id))) matched.add('contrasts_with');

    if (matched.size === 0) continue;

    const relation = RELATION_PRIORITY.find((r) => matched.has(r)) as HubMeshRelation;
    curated.push({ artifact_id: atomic.artifact_id, title: atomic.title, relation });
  }

  curated.sort(
    (a, b) => a.title.localeCompare(b.title) || a.artifact_id.localeCompare(b.artifact_id),
  );
  return curated;
}
