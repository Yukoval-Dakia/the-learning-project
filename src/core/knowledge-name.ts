// The single node-name equality rule shared by the propose_new reuse gate, the
// accept-side same-name guard and the root-placement refile match. Equality is
// exact after trimming surrounding whitespace and Unicode NFC — case and
// compatibility characters stay significant (Co ≠ CO, x² ≠ x2, ℝ ≠ R), and
// nothing else folds: no semantic similarity, no internal-whitespace collapse.
export function normalizeKnowledgeNodeName(name: string): string {
  return name.normalize('NFC').trim();
}
