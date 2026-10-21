// Implementation lives in the shared extraction-summary read model. This file is an
// explicit compat re-export for ingestion consumers and the public surface.

export {
  bodyBlockSummaries,
  excerpt,
  knowledgeContext,
  knowledgeEdgeTouches,
  recordKnowledgeContainsAny,
} from '@/kernel/read-models/extraction-summary';
