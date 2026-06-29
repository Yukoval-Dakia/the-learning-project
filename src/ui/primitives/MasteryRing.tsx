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
  /**
   * A5 S1 (YUK-354 ⑥治理) — 是否渲环内裸 pct 数字。knowledge 面传 false → 只留 tone 环弧
   * （定性程度 glance），离散档 / 区间 / 来源由旁侧 BandChip 承载，绝不裸概率。默认 true
   * 保基元通用 + 向后兼容。showNumber=false 时环为装饰性（aria-hidden），语义交给 BandChip，
   * 避免与 chip 重复读屏。
   */
  showNumber?: boolean;
}

export function MasteryRing({ mastery, size = 30, showNumber = true }: MasteryRingProps) {
  const m = Math.max(0, Math.min(1, mastery ?? 0));
  const pct = Math.round(m * 100);
  const tone = masteryTone(m);
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  // showNumber=false（knowledge 面）：环真装饰化——撤 role/aria-label、加 aria-hidden，让屏读
  // 跳过这个无信息的程度环，语义档交给旁侧 BandChip（真正消除重复读屏）。noSvgWithoutTitle
  // 对 aria-hidden 豁免。showNumber=true（默认）保 role=img + pct aria-label。
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="mastery-ring"
      role={showNumber ? 'img' : undefined}
      aria-label={showNumber ? `掌握度 ${pct}%` : undefined}
      aria-hidden={showNumber ? undefined : true}
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
      {/* ⑥治理：showNumber=false（knowledge 面）不渲裸 pct，档由旁侧 BandChip 给。 */}
      {showNumber && (
        <text
          x="50%"
          y="52%"
          dominantBaseline="middle"
          textAnchor="middle"
          className="mastery-ring-t mono"
        >
          {pct}
        </text>
      )}
    </svg>
  );
}
