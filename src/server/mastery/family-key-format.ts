// Single source of the family_key string format.
//
// family_key = `${subject}:${primaryKnowledgeId}:${kind}:${source}` is the
// item_family_calibration primary key. Keeping the format in one dependency-free
// module stops the read and write keys from drifting apart, without introducing a
// family-key ↔ personalized-difficulty import cycle.
export function buildFamilyKey(
  subject: string,
  primaryKnowledgeId: string,
  kind: string,
  source: string,
): string {
  return `${subject}:${primaryKnowledgeId}:${kind}:${source}`;
}
