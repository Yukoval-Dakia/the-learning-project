const LEARNER_HIDDEN_KNOWLEDGE_PREFIXES = ['synthetic:', 'kc_yuk792_canary_'] as const;

/** Prefixes that mark internal scaffolding/fixtures, never learner content. */
export const HIDDEN_KNOWLEDGE_ID_PREFIXES = LEARNER_HIDDEN_KNOWLEDGE_PREFIXES;

export function isLearnerVisibleKnowledgeId(id: string): boolean {
  return !LEARNER_HIDDEN_KNOWLEDGE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function learnerVisibleKnowledgeIds(ids: readonly string[]): string[] {
  return ids.filter(isLearnerVisibleKnowledgeId);
}
