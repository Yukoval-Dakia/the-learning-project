// YUK-95 P5 Lane-C (Wave 7) — pure hub mesh curation per ADR-0020 §9 "iii-curated".
//
// Given a hub note + the loaded knowledge tree snapshot + mesh edges + the set of
// candidate atomic artifacts, decide which atomics belong in the hub's
// `AutoLinksContainer` auto-zone, and tag each with the relation rule that pulled
// it in (so Lane-D can render the "via X" chip).
//
// This module is PURE: all inputs are already-loaded in-memory rows. No DB, no
// IO. The DB-touching worker (`hub_auto_sync_nightly.ts`) loads the snapshots and
// calls `resolveHubMeshAtomics`. Keeping the set algebra here makes the 4
// inclusion rules unit-testable without a Postgres container.
//
// The 4 inclusion rules (ADR-0020 §9, restated in the Wave 7 plan D5 / P5 Lane-C
// row) — an atomic is included when ANY of these hold against the hub's
// knowledge_ids:
//
//   subtopic     (rule i)   atomic.knowledge_ids ⊆ hub.knowledge_ids (literal set
//                           containment), OR
//                (rule ii)  atomic's node is a tree-descendant of any hub
//                           knowledge_id (multi-level, parent_id backbone).
//                           Both surface as the `subtopic` relation chip.
//   prerequisite (rule iii) a `prerequisite` edge whose `to` ∈ hub.knowledge_ids
//                           (incoming): the atomic's node is a prerequisite OF the
//                           hub's concept.
//   derived_from (rule iii) a `derived_from` edge whose `to` ∈ hub.knowledge_ids:
//                           per ADR-0010 the edge reads `from 派生自 to`, so the
//                           atomic (`from`) is a derivation/variant of the hub's
//                           base concept (`to`). See the direction note below.
//   contrasts_with(rule iii) a `contrasts_with` edge touching any hub
//                           knowledge_id on EITHER endpoint (symmetric).
//
// EXCLUDED (rule iv): `related_to`, `applied_in`, and any `experimental:*`
// relation. (related_to / applied_in are future per-hub opt-in, not day1.)
//
// ── derived_from direction finding (task-flagged contradiction) ──────────────
// ADR-0010 §relation_type table is AUTHORITATIVE: `derived_from` edge
// `from --derived_from--> to` means "`from` 派生自 `to`" (from is DERIVED FROM to),
// e.g. "之-主谓间用法" --derived_from--> "之-用法". So `from` = the variant/derived
// node, `to` = the base concept.
//
// `src/server/ai/tools/knowledge-readers.ts` DEFAULT_RELATIONS says derived_from
// meaning = "target concept extends source" — that comment is the OPPOSITE of
// ADR-0010 and is therefore wrong. We follow ADR-0010.
//
// A hub note is the entry point for a base/general concept, so the hub holds the
// `to` (base) endpoint and the related atomics are its derivations (`from`). The
// spec's shorthand "derived_from outgoing" is written from the reader's mental
// model of the hub reaching out to its variants; concretely, against the raw
// edge table, that is edges whose `to_knowledge_id ∈ hub.knowledge_ids` and whose
// `from` is the atomic's node. We key the rule on `to ∈ hub` and surface the
// atomic at the `from` endpoint. (Documented in the Lane-C finish report.)

import type { KnowledgeNode } from '@/server/knowledge/tree';

// Relation provenance attached to each curated atomic. Drives the Lane-D chip:
//   subtopic → "via 子主题", prerequisite → "via prerequisite",
//   derived_from → "via 派生", contrasts_with → "via 对比".
export type HubMeshRelation = 'subtopic' | 'prerequisite' | 'derived_from' | 'contrasts_with';

// Rule-priority order when an atomic matches several rules — we surface the
// single strongest/most-specific relation for the chip. subtopic (it literally
// belongs under the hub) wins over mesh relations.
const RELATION_PRIORITY: HubMeshRelation[] = [
  'subtopic',
  'prerequisite',
  'derived_from',
  'contrasts_with',
];

// Mesh relations that are EXCLUDED from curation (rule iv). experimental:* is
// matched by prefix below, not enumerated here.
const EXCLUDED_RELATIONS = new Set(['related_to', 'applied_in']);

function isExcludedRelation(relationType: string): boolean {
  return EXCLUDED_RELATIONS.has(relationType) || relationType.startsWith('experimental:');
}

// Minimal edge shape the curation needs — compatible with both
// `KnowledgeEdgeRow` (edges.ts) and the readers' `EdgeRow`.
export interface HubMeshEdge {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

// Minimal atomic-artifact shape the curation needs.
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
  /** The strongest matching relation, for the Lane-D chip. */
  relation: HubMeshRelation;
}

/**
 * Build the set of tree-descendant knowledge_ids for `rootIds`, walking the
 * `parent_id` backbone to a multi-level fixpoint. Roots themselves are NOT
 * included (a node is not its own descendant); literal containment of the hub's
 * own knowledge_ids is handled separately by the subtopic rule-i path.
 *
 * Reusable helper (extracted per the Lane-C brief): mirrors the BFS fixpoint in
 * knowledge-readers.ts `executeOverview` but parameterised over arbitrary roots.
 */
export function treeDescendantIds(nodes: KnowledgeNode[], rootIds: Iterable<string>): Set<string> {
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
 * Resolve which knowledge_ids are reachable from the hub via each mesh relation,
 * keyed by the rule. Pure set algebra over the loaded edges (XC-4: app-side
 * containment, NOT pg array `@>`). Returns the per-relation set of
 * KNOWLEDGE_IDs (not atomics) that an atomic must touch to be pulled in by that
 * relation.
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
        // incoming: `to` ∈ hub → the `from` node is a prerequisite of the hub.
        if (toInHub && !fromInHub) prerequisite.add(edge.from_knowledge_id);
        break;
      case 'derived_from':
        // `to` ∈ hub → the `from` node is derived from the hub's concept
        // (ADR-0010: `from 派生自 to`). See module header direction note.
        if (toInHub && !fromInHub) derived_from.add(edge.from_knowledge_id);
        break;
      case 'contrasts_with':
        // symmetric: either endpoint in hub pulls in the OTHER endpoint.
        if (toInHub && !fromInHub) contrasts_with.add(edge.from_knowledge_id);
        if (fromInHub && !toInHub) contrasts_with.add(edge.to_knowledge_id);
        break;
      default:
        // Any other relation is excluded (defensive; isExcludedRelation already
        // dropped related_to / applied_in / experimental:*).
        break;
    }
  }

  return { prerequisite, derived_from, contrasts_with };
}

/**
 * Decide which atomics belong in the hub's auto-zone and tag each with its
 * strongest matching relation.
 *
 * @param nodes      loaded tree snapshot (`loadTreeSnapshot`).
 * @param edges      loaded non-archived mesh edges (`listKnowledgeEdges`).
 * @param hub        the hub artifact (id + knowledge_ids).
 * @param atomics    candidate atomic artifacts to test (typically all
 *                   non-archived `note_atomic` artifacts, excluding the hub).
 *
 * Self-reference (an atomic that IS the hub) is excluded by id. The result is
 * stable-sorted by title then artifact_id so the worker's diff is deterministic.
 */
export function resolveHubMeshAtomics(
  nodes: KnowledgeNode[],
  edges: HubMeshEdge[],
  hub: HubMeshInput,
  atomics: HubMeshAtomicInput[],
): CuratedAtomic[] {
  const hubKnowledgeIds = new Set(hub.knowledge_ids);
  if (hubKnowledgeIds.size === 0) return [];

  // rule i + ii: knowledge_ids that count as "subtopic" of the hub —
  // the hub's own knowledge_ids (for literal ⊆ containment) PLUS all
  // tree-descendants of any hub knowledge_id.
  const subtopicKnowledgeIds = new Set<string>(hubKnowledgeIds);
  for (const id of treeDescendantIds(nodes, hubKnowledgeIds)) subtopicKnowledgeIds.add(id);

  const mesh = meshRelatedKnowledgeIds(edges, hubKnowledgeIds);

  const curated: CuratedAtomic[] = [];
  for (const atomic of atomics) {
    if (atomic.artifact_id === hub.hub_artifact_id) continue;
    const atomicKnowledgeIds = atomic.knowledge_ids;
    if (atomicKnowledgeIds.length === 0) continue;

    const matched = new Set<HubMeshRelation>();

    // rule i: literal containment — every atomic knowledge_id is a hub
    // knowledge_id. rule ii: every atomic knowledge_id is a subtopic (hub id or
    // tree-descendant). Both collapse to "all atomic knowledge_ids ∈ subtopic
    // set". (atomic.knowledge_ids length is 1 per ADR-0020 §3, but we treat it
    // generally so a future multi-knowledge atomic still behaves.)
    if (atomicKnowledgeIds.every((id) => subtopicKnowledgeIds.has(id))) {
      matched.add('subtopic');
    }
    // mesh rules iii: any atomic knowledge_id sits in the relation's reachable
    // set.
    if (atomicKnowledgeIds.some((id) => mesh.prerequisite.has(id))) matched.add('prerequisite');
    if (atomicKnowledgeIds.some((id) => mesh.derived_from.has(id))) matched.add('derived_from');
    if (atomicKnowledgeIds.some((id) => mesh.contrasts_with.has(id))) matched.add('contrasts_with');

    if (matched.size === 0) continue;

    // Surface the single strongest relation for the chip.
    const relation = RELATION_PRIORITY.find((r) => matched.has(r)) as HubMeshRelation;
    curated.push({ artifact_id: atomic.artifact_id, title: atomic.title, relation });
  }

  curated.sort(
    (a, b) => a.title.localeCompare(b.title) || a.artifact_id.localeCompare(b.artifact_id),
  );
  return curated;
}
