// YUK-1571 — explicit compatibility entry. The complete tree snapshot read
// engine (loadTreeSnapshot + KnowledgeRow/KnowledgeNode + LOAD_TREE_SNAPSHOT_LIMIT
// + warnIfTreeSnapshotTruncated, including the knowledge_mastery join, the
// getMasteryProjection overlay, the effective-domain parent walk, and the
// optional subject filter) moved verbatim to
// `@/kernel/read-models/knowledge-graph`. This module re-exports the same
// bindings so existing deep importers keep working without an import-path
// change.

export type { KnowledgeNode } from '@/kernel/read-models/knowledge-graph';
export {
  LOAD_TREE_SNAPSHOT_LIMIT,
  loadTreeSnapshot,
  warnIfTreeSnapshotTruncated,
} from '@/kernel/read-models/knowledge-graph';
