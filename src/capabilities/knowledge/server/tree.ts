// Compatibility entry for the tree snapshot engine now owned by the kernel
// read model.

export type { KnowledgeNode } from '@/kernel/read-models/knowledge-graph';
export {
  LOAD_TREE_SNAPSHOT_LIMIT,
  loadTreeSnapshot,
  warnIfTreeSnapshotTruncated,
} from '@/kernel/read-models/knowledge-graph';
