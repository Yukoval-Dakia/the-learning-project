// M3 知识面 — 图谱视图（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（MeshGraph）：
// 可平移缩放的 mesh，5 类 typed 边用 glyph/虚线/箭头做非颜色 cue（REL_CUE，
// data-2b.jsx）。布局 = 移植的 cytoscape+fcose headless（layout.ts，#363 形态
// 裁决产物）；渲染层按设计稿重写为轻量 SVG。

import { useMemo, useRef, useState } from 'react';

import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';
import { LAYOUT_HEIGHT, LAYOUT_WIDTH, computeLayout } from './layout';
import { masteryTone } from './mastery-tone';

// 5 类 typed 边的非颜色 cue（设计稿 data-2b.jsx REL_CUE）。
export const REL_CUE: Record<
  string,
  { glyph: string; dash: string; label: string; arrow: boolean }
> = {
  prerequisite: { glyph: '→', dash: '0', label: '前置', arrow: true },
  related_to: { glyph: '—', dash: '0', label: '相关', arrow: false },
  contrasts_with: { glyph: '⇆', dash: '5 4', label: '对比', arrow: false },
  applied_in: { glyph: '↦', dash: '1 5', label: '应用', arrow: true },
  derived_from: { glyph: '↳', dash: '8 3', label: '派生', arrow: true },
};

export function MeshGraph({
  nodes,
  edges,
  onPick,
  activeId,
}: {
  nodes: KnowledgeTreeNode[];
  edges: KnowledgeEdgeRow[];
  onPick: (node: KnowledgeTreeNode) => void;
  activeId?: string | null;
}) {
  // LayoutNode/LayoutEdge 字段名与 wire 一致（parent_id / from_knowledge_id），直传。
  const pos = useMemo(() => computeLayout(nodes, edges), [nodes, edges]);

  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <section className="kg-stage" aria-label="知识关系图">
      <svg
        className="mesh-canvas"
        viewBox={`0 0 ${LAYOUT_WIDTH} ${LAYOUT_HEIGHT}`}
        style={{ cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setView((v) => ({
            ...v,
            x: (drag.current?.ox ?? 0) + (e.clientX - (drag.current?.sx ?? 0)),
            y: (drag.current?.oy ?? 0) + (e.clientY - (drag.current?.sy ?? 0)),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onWheel={(e) => {
          const k = Math.min(2.4, Math.max(0.5, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
          setView((v) => ({ ...v, k }));
        }}
        role="img"
      >
        <title>知识关系图：拖拽平移、滚轮缩放、点节点开抽屉</title>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((e) => {
            const a = pos.get(e.from_knowledge_id);
            const b = pos.get(e.to_knowledge_id);
            if (!a || !b) return null;
            const cue = REL_CUE[e.relation_type] ?? REL_CUE.related_to;
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2 - 18;
            return (
              <g key={e.id} className="mesh-edge">
                <path
                  d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                  fill="none"
                  stroke="var(--ink-5)"
                  strokeWidth={1.4}
                  strokeDasharray={cue.dash === '0' ? undefined : cue.dash}
                  markerEnd={cue.arrow ? 'url(#mesh-arrow)' : undefined}
                  opacity={0.75}
                />
                <text x={mx} y={my + 6} textAnchor="middle" className="mesh-edge-glyph mono">
                  {cue.glyph}
                </text>
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const pct = n.mastery == null ? null : Math.round(n.mastery * 100);
            const tone = masteryTone(n.mastery ?? undefined);
            return (
              <g
                key={n.id}
                className={`mesh-node${activeId === n.id ? ' is-active' : ''}`}
                transform={`translate(${p.x} ${p.y})`}
                // biome-ignore lint/a11y/useSemanticElements: SVG <g> 不能是 <button>；role=button + tabIndex 是可聚焦图节点的正确 ARIA（旧 KnowledgeGraph 同例）
                role="button"
                tabIndex={0}
                style={{ cursor: 'pointer' }}
                onClick={() => onPick(byId.get(n.id) ?? n)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onPick(byId.get(n.id) ?? n);
                }}
              >
                <circle
                  className={`mesh-disc tone-${pct == null ? 'none' : tone}`}
                  r={16}
                  stroke={activeId === n.id ? 'var(--coral)' : 'var(--line)'}
                  strokeWidth={activeId === n.id ? 2.5 : 1.2}
                />
                {pct != null && (
                  <text y={4} textAnchor="middle" className="mesh-node-pct mono">
                    {pct}
                  </text>
                )}
                <text y={32} textAnchor="middle" className="mesh-node-label wenyan">
                  {n.name.length > 8 ? `${n.name.slice(0, 8)}…` : n.name}
                </text>
              </g>
            );
          })}
        </g>
        <defs>
          <marker
            id="mesh-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--ink-5)" />
          </marker>
        </defs>
      </svg>
      <div className="key-hints mono" style={{ padding: 'var(--s-2) var(--s-4)' }}>
        拖拽平移 · 滚轮缩放 · 点节点开抽屉
      </div>
    </section>
  );
}
