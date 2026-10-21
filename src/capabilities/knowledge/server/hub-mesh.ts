// Compatibility entry for the hub-mesh algorithm now owned by kernel/hub-mesh.
// Curation accepts subtopic, prerequisite, derived_from and contrasts_with only.
export type {
  CuratedAtomic,
  HubMeshAtomicInput,
  HubMeshEdge,
  HubMeshInput,
  HubMeshRelation,
} from '@/kernel/hub-mesh';
export { resolveHubMeshAtomics, treeDescendantIds } from '@/kernel/hub-mesh';
