import { resolveSubjectProfile } from '@/subjects/profile';

export interface KnowledgeNodeForCauseOptions {
  id: string;
  name: string;
  effective_domain: string | null;
}

export interface CauseOption {
  id: string;
  label: string;
}

export function causeOptionsForSelectedKnowledge(
  nodes: KnowledgeNodeForCauseOptions[],
  selectedKnowledgeIds: string[],
): CauseOption[] {
  const firstSelectedNode = selectedKnowledgeIds
    .map((id) => nodes.find((node) => node.id === id))
    .find((node): node is KnowledgeNodeForCauseOptions => node !== undefined);
  const profile = resolveSubjectProfile(firstSelectedNode?.effective_domain ?? null);
  return profile.causeCategories.map((category) => ({
    id: category.id,
    label: category.label,
  }));
}
