const LEARNER_HIDDEN_KNOWLEDGE_PREFIXES = ['synthetic:', 'kc_yuk792_canary_'] as const;

export function isLearnerVisibleKnowledgeId(id: string): boolean {
  return !LEARNER_HIDDEN_KNOWLEDGE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function learnerVisibleKnowledgeIds(ids: readonly string[]): string[] {
  return ids.filter(isLearnerVisibleKnowledgeId);
}
