// The single node-name equality rule shared by the propose_new reuse gate, the
// accept-side same-name guard and the root-placement refile match. Equality is
// exact after normalization — NFKC fold, surrounding whitespace, case — and
// nothing else: no semantic similarity, no internal-whitespace collapse.
export function normalizeKnowledgeNodeName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}
