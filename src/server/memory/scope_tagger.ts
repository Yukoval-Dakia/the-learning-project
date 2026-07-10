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
  // YUK-598 PR2（v2 AMEND-1）：subject 后缀收 RAW——active-subjects.ts / brief.ts
  // 两侧从来是裸 id（`subject:${subjectId}`），这里曾独走 slug 形成 L1 三点分歧。
  // 已证为 cosmetic 死代码（live brief 走 loadSubjectBriefEvents），本处是卫生统一
  // 非 bug 修；opaque ASCII custom id 下分歧本就从根消失。slug() 保留给
  // mistake_cluster（:下方）——那是自由文本分类名，语义确实要归一。
  if (subjectId) addScope(scopes, `subject:${subjectId}`);

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
