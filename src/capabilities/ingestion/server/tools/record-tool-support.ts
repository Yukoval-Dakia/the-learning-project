// YUK-1571 — implementation moved verbatim to
// @/kernel/read-models/extraction-summary (shared cross-capability read
// model); this file remains as an explicit compat re-export for
// ingestion-internal consumers and the ingestion/public surface.

export {
  bodyBlockSummaries,
  excerpt,
  knowledgeContext,
  knowledgeEdgeTouches,
  recordKnowledgeContainsAny,
} from '@/kernel/read-models/extraction-summary';
