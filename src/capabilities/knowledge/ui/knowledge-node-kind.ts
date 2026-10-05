import type { KnowledgeTreeNode } from './knowledge-api';

export function isKnowledgeContainer(node: Pick<KnowledgeTreeNode, 'id' | 'parent_id'>): boolean {
  return node.parent_id === null && node.id.startsWith('seed:') && node.id.endsWith(':root');
}
