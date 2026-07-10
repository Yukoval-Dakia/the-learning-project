import { resolveKnownSubjectId, resolveSubjectProfile } from '@/subjects/profile';

export interface KnowledgeNodeForCauseOptions {
  id: string;
  name: string;
  effective_domain: string | null;
}

export interface CauseOption {
  id: string;
  label: string;
}

// YUK-598 — subjectRows 参数（useSubjects().subjects）：custom 科目的错因分类法只有
// provider 行认识（编译期 registry 只有 builtin）。省略 = 原编译期行为逐位不变。
export interface SubjectRowWithCauses {
  id: string;
  causeCategories: Array<{ id: string; label: string }>;
}

export function causeOptionsForSelectedKnowledge(
  nodes: KnowledgeNodeForCauseOptions[],
  selectedKnowledgeIds: string[],
  subjectRows?: readonly SubjectRowWithCauses[],
): CauseOption[] {
  const firstSelectedNode = selectedKnowledgeIds
    .map((id) => nodes.find((node) => node.id === id))
    .find((node): node is KnowledgeNodeForCauseOptions => node !== undefined);
  const domain = firstSelectedNode?.effective_domain ?? null;
  if (subjectRows && domain) {
    const canonical = resolveKnownSubjectId(domain) ?? domain;
    const row = subjectRows.find((s) => s.id === canonical || s.id === domain);
    if (row) return row.causeCategories.map((c) => ({ id: c.id, label: c.label }));
  }
  const profile = resolveSubjectProfile(domain);
  return profile.causeCategories.map((category) => ({
    id: category.id,
    label: category.label,
  }));
}
