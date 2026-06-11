// YUK-95 P5 Lane-C — unit tests for the pure hub mesh curation (ADR-0020 §9).
// No DB: exercises the 4 inclusion rules + exclusions + multi-level tree
// descendants + provenance tagging over in-memory snapshots.

import { describe, expect, it } from 'vitest';

import {
  type HubMeshAtomicInput,
  type HubMeshEdge,
  resolveHubMeshAtomics,
  treeDescendantIds,
} from './hub-mesh';
import type { KnowledgeNode } from './tree';

function node(id: string, parent_id: string | null = null): KnowledgeNode {
  return {
    id,
    name: id,
    domain: parent_id ? null : 'wenyan',
    parent_id,
    archived_at: null,
    mastery: null,
    evidence_count: 0,
    last_evidence_at: null,
    last_active_at: new Date('2026-01-01T00:00:00Z'),
    effective_domain: 'wenyan',
  };
}

function atomic(artifact_id: string, knowledgeId: string, title = artifact_id): HubMeshAtomicInput {
  return { artifact_id, title, knowledge_ids: [knowledgeId] };
}

const HUB = { hub_artifact_id: 'hub_art', knowledge_ids: ['k_hub'] };

describe('treeDescendantIds', () => {
  it('walks parent_id to a multi-level fixpoint (roots excluded)', () => {
    const nodes = [
      node('k_hub'),
      node('k_child', 'k_hub'),
      node('k_grandchild', 'k_child'),
      node('k_unrelated'),
    ];
    const descendants = treeDescendantIds(nodes, ['k_hub']);
    expect([...descendants].sort()).toEqual(['k_child', 'k_grandchild']);
    expect(descendants.has('k_hub')).toBe(false);
    expect(descendants.has('k_unrelated')).toBe(false);
  });

  it('returns empty when a leaf has no children', () => {
    const nodes = [node('k_hub'), node('k_other')];
    expect(treeDescendantIds(nodes, ['k_hub']).size).toBe(0);
  });
});

describe('resolveHubMeshAtomics', () => {
  const baseNodes = [node('k_hub'), node('k_child', 'k_hub'), node('k_far')];

  it('rule i — literal knowledge_ids containment → subtopic', () => {
    const result = resolveHubMeshAtomics(baseNodes, [], HUB, [atomic('a_same', 'k_hub')]);
    expect(result).toEqual([{ artifact_id: 'a_same', title: 'a_same', relation: 'subtopic' }]);
  });

  it('rule ii — multi-level tree descendant → subtopic', () => {
    const nodes = [node('k_hub'), node('k_child', 'k_hub'), node('k_grandchild', 'k_child')];
    const result = resolveHubMeshAtomics(nodes, [], HUB, [atomic('a_gc', 'k_grandchild')]);
    expect(result).toEqual([{ artifact_id: 'a_gc', title: 'a_gc', relation: 'subtopic' }]);
  });

  it('rule iii — prerequisite incoming (to ∈ hub) → prerequisite', () => {
    const edges: HubMeshEdge[] = [
      { from_knowledge_id: 'k_prereq', to_knowledge_id: 'k_hub', relation_type: 'prerequisite' },
    ];
    const nodes = [...baseNodes, node('k_prereq')];
    const result = resolveHubMeshAtomics(nodes, edges, HUB, [atomic('a_prereq', 'k_prereq')]);
    expect(result).toEqual([
      { artifact_id: 'a_prereq', title: 'a_prereq', relation: 'prerequisite' },
    ]);
  });

  it('rule iii — prerequisite OUTGOING (from ∈ hub) is NOT pulled in', () => {
    // hub --prerequisite--> k_downstream means the hub is a prereq of
    // k_downstream; that does not make k_downstream a hub auto-link.
    const edges: HubMeshEdge[] = [
      {
        from_knowledge_id: 'k_hub',
        to_knowledge_id: 'k_downstream',
        relation_type: 'prerequisite',
      },
    ];
    const nodes = [...baseNodes, node('k_downstream')];
    const result = resolveHubMeshAtomics(nodes, edges, HUB, [atomic('a_down', 'k_downstream')]);
    expect(result).toEqual([]);
  });

  it('rule iii — derived_from with to ∈ hub → derived_from (atomic is the from/variant)', () => {
    // ADR-0010: from 派生自 to. Variant (from) --derived_from--> base (to=hub).
    const edges: HubMeshEdge[] = [
      { from_knowledge_id: 'k_variant', to_knowledge_id: 'k_hub', relation_type: 'derived_from' },
    ];
    const nodes = [...baseNodes, node('k_variant')];
    const result = resolveHubMeshAtomics(nodes, edges, HUB, [atomic('a_var', 'k_variant')]);
    expect(result).toEqual([{ artifact_id: 'a_var', title: 'a_var', relation: 'derived_from' }]);
  });

  it('rule iii — contrasts_with is symmetric (either endpoint)', () => {
    const edgesFrom: HubMeshEdge[] = [
      {
        from_knowledge_id: 'k_hub',
        to_knowledge_id: 'k_contrast',
        relation_type: 'contrasts_with',
      },
    ];
    const edgesTo: HubMeshEdge[] = [
      {
        from_knowledge_id: 'k_contrast',
        to_knowledge_id: 'k_hub',
        relation_type: 'contrasts_with',
      },
    ];
    const nodes = [...baseNodes, node('k_contrast')];
    const atomics = [atomic('a_contrast', 'k_contrast')];
    expect(resolveHubMeshAtomics(nodes, edgesFrom, HUB, atomics)).toEqual([
      { artifact_id: 'a_contrast', title: 'a_contrast', relation: 'contrasts_with' },
    ]);
    expect(resolveHubMeshAtomics(nodes, edgesTo, HUB, atomics)).toEqual([
      { artifact_id: 'a_contrast', title: 'a_contrast', relation: 'contrasts_with' },
    ]);
  });

  it('rule iv — related_to / applied_in / experimental:* are excluded', () => {
    const nodes = [...baseNodes, node('k_rel'), node('k_app'), node('k_exp')];
    const edges: HubMeshEdge[] = [
      { from_knowledge_id: 'k_rel', to_knowledge_id: 'k_hub', relation_type: 'related_to' },
      { from_knowledge_id: 'k_app', to_knowledge_id: 'k_hub', relation_type: 'applied_in' },
      {
        from_knowledge_id: 'k_exp',
        to_knowledge_id: 'k_hub',
        relation_type: 'experimental:contrasts_register',
      },
    ];
    const result = resolveHubMeshAtomics(nodes, edges, HUB, [
      atomic('a_rel', 'k_rel'),
      atomic('a_app', 'k_app'),
      atomic('a_exp', 'k_exp'),
    ]);
    expect(result).toEqual([]);
  });

  it('tags the strongest relation when an atomic matches multiple rules (subtopic wins)', () => {
    // k_child is a tree-descendant of k_hub (subtopic) AND has a prerequisite
    // edge into the hub. subtopic has higher priority → chip = subtopic.
    const edges: HubMeshEdge[] = [
      { from_knowledge_id: 'k_child', to_knowledge_id: 'k_hub', relation_type: 'prerequisite' },
    ];
    const result = resolveHubMeshAtomics(baseNodes, edges, HUB, [atomic('a_child', 'k_child')]);
    expect(result).toEqual([{ artifact_id: 'a_child', title: 'a_child', relation: 'subtopic' }]);
  });

  it('excludes the hub artifact itself and atomics with no knowledge_ids', () => {
    const result = resolveHubMeshAtomics(baseNodes, [], HUB, [
      { artifact_id: 'hub_art', title: 'self', knowledge_ids: ['k_hub'] },
      { artifact_id: 'a_empty', title: 'empty', knowledge_ids: [] },
    ]);
    expect(result).toEqual([]);
  });

  it('returns empty when the hub has no knowledge_ids', () => {
    const result = resolveHubMeshAtomics(
      baseNodes,
      [],
      { hub_artifact_id: 'hub_art', knowledge_ids: [] },
      [atomic('a_same', 'k_hub')],
    );
    expect(result).toEqual([]);
  });

  it('is stable-sorted by title then artifact_id', () => {
    const result = resolveHubMeshAtomics(baseNodes, [], HUB, [
      { artifact_id: 'z', title: 'Beta', knowledge_ids: ['k_hub'] },
      { artifact_id: 'a', title: 'Alpha', knowledge_ids: ['k_hub'] },
      { artifact_id: 'b', title: 'Alpha', knowledge_ids: ['k_hub'] },
    ]);
    expect(result.map((c) => c.artifact_id)).toEqual(['a', 'b', 'z']);
  });
});
