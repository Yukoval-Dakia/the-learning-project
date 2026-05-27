type EventPartial = {
  action: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function addScope(scopes: Set<string>, scope: string) {
  if (scope.length > 0) scopes.add(scope);
}

/**
 * Minimal deterministic scope tagging for ADR-0017's fixed prefix taxonomy.
 *
 * This intentionally avoids LLM invention: suffixes come only from explicit
 * event fields already present in SoT rows.
 */
export function computeAffectedScopes(input: EventPartial): string[] {
  const payload = asRecord(input.payload);
  const scopes = new Set<string>(['global']);

  const subjectId =
    typeof payload.subject_id === 'string'
      ? payload.subject_id
      : typeof payload.subject === 'string'
        ? payload.subject
        : typeof payload.domain === 'string'
          ? payload.domain
          : undefined;
  if (subjectId) addScope(scopes, `subject:${slug(subjectId)}`);

  for (const knowledgeId of [
    ...stringArray(payload.referenced_knowledge_ids),
    ...stringArray(payload.knowledge_ids),
    ...(input.subject_kind === 'knowledge' ? [input.subject_id] : []),
  ]) {
    addScope(scopes, `topic:${knowledgeId}`);
  }

  const cause = asRecord(payload.cause);
  const primaryCategory =
    typeof cause.primary_category === 'string'
      ? cause.primary_category
      : typeof payload.primary_category === 'string'
        ? payload.primary_category
        : undefined;
  if (primaryCategory) addScope(scopes, `mistake_cluster:${slug(primaryCategory)}`);

  if (
    input.subject_kind === 'query' ||
    input.action.includes('chat') ||
    input.action.includes('tool_use') ||
    input.action.includes('orchestrator')
  ) {
    scopes.add('meta:orchestrator_self');
  }

  return [...scopes];
}
