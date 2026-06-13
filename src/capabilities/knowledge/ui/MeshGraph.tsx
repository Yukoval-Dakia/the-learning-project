// M3 知识面 — 图谱视图（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（MeshGraph）：
// 可平移缩放的 mesh，5 类 typed 边用 glyph/虚线/箭头做非颜色 cue（REL_CUE，
// data-2b.jsx）。布局 = 移植的 cytoscape+fcose headless（layout.ts，#363 形态
// 裁决产物）；渲染层按设计稿重写为轻量 SVG。

import { useMemo, useRef, useState } from 'react';

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';
import { LAYOUT_HEIGHT, LAYOUT_WIDTH, computeLayout } from './layout';
import { masteryTone } from './mastery-tone';

// wire 的 KnowledgeTreeNode 无 kind 字段——hub 用「是否有子节点」代理判定
// （存在别的 node.parent_id === 本 id ⇒ hub）。设计稿 kind:'hub' 节点 r=24，
// 叶 r=18（screen-knowledge.jsx L84）。
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.4;
const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

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

  // hub 代理判定：有任意子节点的 node 视为 hub（r=24），否则叶（r=18）。
  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.parent_id != null) set.add(n.parent_id);
    return set;
  }, [nodes]);

  return (
    <div className="mesh-wrap" aria-label="知识关系图">
      {/* 缩放 controls（screen-knowledge.jsx L62-68）：缩小 / 百分比 / 放大 / 复位。 */}
      <div className="mesh-controls">
        <button
          type="button"
          className="mesh-zoom-btn"
          title="缩小"
          aria-label="缩小"
          onClick={() => setView((v) => ({ ...v, k: clampZoom(v.k - 0.1) }))}
        >
          <LoomIcon name="minus" size={15} />
        </button>
        <span className="mono mesh-zoom">{Math.round(view.k * 100)}%</span>
        <button
          type="button"
          className="mesh-zoom-btn"
          title="放大"
          aria-label="放大"
          onClick={() => setView((v) => ({ ...v, k: clampZoom(v.k + 0.1) }))}
        >
          <LoomIcon name="plus" size={15} />
        </button>
        <span className="mesh-ctrl-div" />
        <button
          type="button"
          className="mesh-zoom-btn"
          title="复位"
          aria-label="复位"
          onClick={() => setView({ x: 0, y: 0, k: 1 })}
        >
          <LoomIcon name="refresh" size={15} />
        </button>
      </div>

      {/* 点阵底 stage：复用 globals .kg-svg-stage（radial-gradient 点阵 + paper-sunk
          + grab），消除旧 .mesh-canvas 的「纯白双框」。pan/zoom 指针手势挂在内层
          <svg> 上（与旧渲染层同例，键盘交互由各节点 <g> 提供）。 */}
      <div className="kg-svg-stage">
        <svg
          className="kg-svg"
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
            const k = clampZoom(view.k * (e.deltaY < 0 ? 1.1 : 0.9));
            setView((v) => ({ ...v, k }));
          }}
          role="img"
        >
          <title>知识关系图：拖拽平移、滚轮缩放、点节点开抽屉</title>
          <defs>
            {/* 箭头色跟边色：fill=context-stroke 让 marker 继承 path 的 stroke
                （现代 SVG marker 上下文色），typed 边各自显本色箭头。 */}
            <marker
              id="mesh-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
            </marker>
            {/* feDropShadow：填充 disc 与点阵纸面分离（screen-knowledge.jsx L75-77）。 */}
            <filter id="nodeShadow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(60,50,30,0.18)" />
            </filter>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e) => {
              const a = pos.get(e.from_knowledge_id);
              const b = pos.get(e.to_knowledge_id);
              if (!a || !b) return null;
              const cue = REL_CUE[e.relation_type] ?? REL_CUE.related_to;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2 - 18;
              return (
                <g key={e.id} className="mesh-edge-g">
                  {/* 颜色由 .rel-{type} 类驱动（screens-2b.css L20-26）；dash + 箭头
                      仍是非颜色 cue，typed 边即便色盲也能解码。 */}
                  <path
                    d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                    className={`mesh-edge2 rel-${e.relation_type}`}
                    strokeDasharray={cue.dash === '0' ? undefined : cue.dash}
                    markerEnd={cue.arrow ? 'url(#mesh-arrow)' : undefined}
                  />
                  <text x={mx} y={my + 6} textAnchor="middle" className="mesh-edge-label mono">
                    {cue.glyph} {cue.label}
                  </text>
                </g>
              );
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const m = n.mastery;
              const pct = m == null ? null : Math.round(m * 100);
              const tone = masteryTone(m ?? undefined);
              const r = hasChildren.has(n.id) ? 24 : 18;
              const circ = 2 * Math.PI * r;
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
                  {/* 三层节点：填充 disc（+shadow）→ 满轨底环 → 掌握度弧。
                      S5 (YUK-335): stroke/选中态全交给 CSS——.mesh-node.is-active
                      .mesh-disc 的 coral stroke 胜过 .mesh-disc.tone-* 规则。 */}
                  <circle
                    className={`mesh-disc tone-${pct == null ? 'none' : tone}`}
                    r={r}
                    filter="url(#nodeShadow)"
                  />
                  <circle r={r} fill="none" className="mesh-track" />
                  {/* mastery=null（从未练）只渲 track，不渲 arc——无掌握度可绘。 */}
                  {m != null && (
                    <circle
                      r={r}
                      fill="none"
                      className="mesh-arc"
                      stroke={`var(--${tone})`}
                      strokeWidth="3.5"
                      strokeLinecap="round"
                      strokeDasharray={circ}
                      strokeDashoffset={circ * (1 - m)}
                      transform="rotate(-90)"
                    />
                  )}
                  <text y={4} textAnchor="middle" className="mesh-node-pct mono">
                    {pct == null ? '—' : pct}
                  </text>
                  <text y={r + 18} textAnchor="middle" className="mesh-node-label wenyan">
                    {n.name.length > 8 ? `${n.name.slice(0, 8)}…` : n.name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* 关系图例：typed 边的解码钥匙（screen-knowledge.jsx L108-115）。
          替换旧的「一行 key-hints 文字」。 */}
      <div className="mesh-legend">
        {Object.entries(REL_CUE).map(([type, cue]) => (
          <span key={type} className="rel-legend">
            <svg width="26" height="10" aria-hidden="true">
              <line
                className={`rel-${type}`}
                x1="1"
                y1="5"
                x2="25"
                y2="5"
                strokeDasharray={cue.dash === '0' ? undefined : cue.dash}
                markerEnd={cue.arrow ? 'url(#mesh-arrow)' : undefined}
              />
            </svg>
            <span className="mono">
              {cue.glyph} {cue.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
