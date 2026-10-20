// YUK-1571 — explicit compatibility entry. The hub-mesh curation algorithm
// moved verbatim to `@/kernel/hub-mesh` (the notes hub-sync reconciler is its
// only production consumer); this module re-exports the same bindings so
// existing deep importers keep working without an import-path change.
// Curation relations stay 'subtopic' | 'prerequisite' | 'derived_from' |
// 'contrasts_with'; 'related_to' / 'applied_in' / 'experimental:*' remain
// excluded per ADR-0020 §9.
export type {
  CuratedAtomic,
  HubMeshAtomicInput,
  HubMeshEdge,
  HubMeshInput,
  HubMeshRelation,
} from '@/kernel/hub-mesh';
export { resolveHubMeshAtomics, treeDescendantIds } from '@/kernel/hub-mesh';
