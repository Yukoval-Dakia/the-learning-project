import { createStartKnowledgeEdge } from './knowledge-edge-create-operation';
import { readStartKnowledgeEdges } from './knowledge-edges-reader';
import { readStartKnowledgeMisconceptions } from './knowledge-misconceptions-reader';
import { readStartKnowledgeNodePage } from './knowledge-node-reader';

// One family surface, constructed in the API graph when a Start operation first asks
// for it; each adapter keeps owning its own conversion, error and deadline handling.
export const knowledgeAdapters = {
  createStartKnowledgeEdge,
  readStartKnowledgeEdges,
  readStartKnowledgeMisconceptions,
  readStartKnowledgeNodePage,
};
