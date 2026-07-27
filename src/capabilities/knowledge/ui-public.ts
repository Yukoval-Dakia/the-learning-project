// Client-only public contribution surface.
export { getTree } from './ui/knowledge-api';
export type { KnowledgeTreeNode } from './ui/knowledge-api';
export { masteryTone } from './ui/mastery-tone';

export const loadKnowledgePage = () =>
  import('./ui/KnowledgePage').then((module) => module.default);
export const loadKnowledgeDetailPage = () =>
  import('./ui/KnowledgeDetailPage').then((module) => module.default);
