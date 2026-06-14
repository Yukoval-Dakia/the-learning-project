// Mastery → design 3-tone (good / hard / again) — the single source of the
// 0.67 / 0.45 thresholds shared by KnowledgeGraph (disc fill + arc) and the tree-row
// MasteryRing. Deliberately a DEPENDENCY-FREE leaf module (no cytoscape / react): a
// synchronously-rendered consumer like MasteryRing imports `masteryTone` from here, so
// it does NOT pull in the cytoscape-bearing KnowledgeGraph module — which the knowledge
// page code-splits via dynamic() precisely to keep cytoscape out of the initial bundle.
//
// NULL mastery (never practiced) → 0 → 'again': the design has no untrained/insufficient
// tone, and that grey "证据不足" encoding was intentionally dropped as the node color
// (the evidence gate still drives the 掌握度 FILTER + isWeakish in KnowledgeGraph, just
// not the disc fill). S5 (YUK-335): thresholds unified to 0.67 / 0.45 to match
// NodeDrawer.decayCue (was 0.7 / 0.4 here vs 0.67 / 0.45 there) — the mismatch made a
// ~43% node read 'hard'/yellow on the ring but '衰减中'/again-red on the decay pill
// (audit §3.8). disc color, the decay cue, and the legend now all agree.
export type MasteryTone = 'good' | 'hard' | 'again';

export function masteryTone(mastery: number | null | undefined): MasteryTone {
  const m = mastery ?? 0;
  if (m >= 0.67) return 'good';
  if (m >= 0.45) return 'hard';
  return 'again';
}
