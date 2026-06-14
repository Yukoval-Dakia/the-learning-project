// MasteryRing — small tone-coloured mastery dial (track + arc + pct), ported from
// the Loom prototype's MasteryRing (screen-knowledge.jsx L11-22). Used in the
// knowledge TREE rows so they read mastery the SAME way as the graph nodes
// (disc/arc + design 3-tone). Tone is derived by the shared `masteryTone` (the single
// source of the 0.67 / 0.45 thresholds) so the tree and graph never disagree. NULL
// mastery (never practiced) → 0 → 'again', matching the graph.
//
// Imported from the dep-free knowledge-graph/mastery-tone leaf (NOT from KnowledgeGraph)
// so this synchronously-rendered primitive doesn't drag cytoscape — which the knowledge
// page code-splits via dynamic() — into the initial bundle.

import { masteryTone } from '@/capabilities/knowledge/ui/mastery-tone';

interface MasteryRingProps {
  /** 0-1 mastery (knowledge_mastery view); null / undefined = never practiced → 0. */
  mastery: number | null | undefined;
  /** outer px size of the square ring (design default 30 in the tree row). */
  size?: number;
}

export function MasteryRing({ mastery, size = 30 }: MasteryRingProps) {
  const m = Math.max(0, Math.min(1, mastery ?? 0));
  const pct = Math.round(m * 100);
  const tone = masteryTone(m);
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="mastery-ring"
      role="img"
      aria-label={`掌握度 ${pct}%`}
    >
      {/* track */}
      <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--line)" strokeWidth={3} />
      {/* tone arc */}
      <circle
        cx={mid}
        cy={mid}
        r={r}
        fill="none"
        stroke={`var(--${tone})`}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - m)}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
      <text
        x="50%"
        y="52%"
        dominantBaseline="middle"
        textAnchor="middle"
        className="mastery-ring-t mono"
      >
        {pct}
      </text>
    </svg>
  );
}
