// M3 知识面 — 图谱视图（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（MeshGraph）：
// 可平移缩放的 mesh，5 类 typed 边用 glyph/虚线/箭头做非颜色 cue（REL_CUE，
// data-2b.jsx）。布局 = 移植的 cytoscape+fcose headless（layout.ts，#363 形态
// 裁决产物）；渲染层按设计稿重写为轻量 SVG。

import { memo, useMemo, useRef, useState } from 'react';

import { subjectContentPropsForDomain } from '@/ui/lib/subject';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';
import { LAYOUT_HEIGHT, LAYOUT_WIDTH, computeLayout } from './layout';
import { masteryTone } from './mastery-tone';
import { REL_CUE } from './relation-cue';

// wire 的 KnowledgeTreeNode 无 kind 字段——hub 用「是否有子节点」代理判定
// （存在别的 node.parent_id === 本 id ⇒ hub）。设计稿 kind:'hub' 节点 r=24，
// 叶 r=18（screen-knowledge.jsx L84）。
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.4;
const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

// YUK-717 — pan/zoom 每帧 setView(~60/s)，但边/节点元素只依赖 pos/nodes/edges/
// activeId（与 view 无关）。把边/节点抽成 memo 化子组件，父层 useMemo 元素数组
// （见 MeshGraph）：pan/zoom 帧内元素数组引用不变 → React 跳过整棵子树，只改父
// <g> 的 transform 字符串。props 全为原始值或稳定引用（node/onPick 引用稳定），
// memo 判等诚实。
const MeshEdge = memo(function MeshEdge({
  ax,
  ay,
  bx,
  by,
  relationType,
}: {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  relationType: string;
}) {
  // F2 (Codex #400)：未知/experimental:* 关系类型 cue 回退 related_to，
  // class 必须同源折回——否则 className 拼出无 CSS 匹配的 rel-experimental:*，
  // 而 .mesh-edge2 无默认 stroke → 边描边 none 不可见（cue 已折回但颜色没折，
  // 用户看到悬空「— 相关」标签却没连线）。relKey 让 cue 与 class 共用一个键。
  const relKey = REL_CUE[relationType] ? relationType : 'related_to';
  const cue = REL_CUE[relKey];
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2 - 18;
  return (
    <g className="mesh-edge-g">
      {/* 颜色由 .rel-{type} 类驱动（screens-2b.css L20-26）；dash + 箭头
          仍是非颜色 cue，typed 边即便色盲也能解码。 */}
      <path
        d={`M ${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`}
        className={`mesh-edge2 rel-${relKey}`}
        strokeDasharray={cue.dash === '0' ? undefined : cue.dash}
        markerEnd={cue.arrow ? 'url(#mesh-arrow)' : undefined}
      />
      <text x={mx} y={my + 6} textAnchor="middle" className="mesh-edge-label mono">
        {cue.glyph} {cue.label}
      </text>
    </g>
  );
});

const MeshNode = memo(function MeshNode({
  node,
  x,
  y,
  isActive,
  isHub,
  onPick,
}: {
  node: KnowledgeTreeNode;
  x: number;
  y: number;
  isActive: boolean;
  isHub: boolean;
  onPick: (node: KnowledgeTreeNode) => void;
}) {
  const m = node.mastery;
  const pct = m == null ? null : Math.round(m * 100);
  const tone = masteryTone(m ?? undefined);
  const r = isHub ? 24 : 18;
  const circ = 2 * Math.PI * r;
  return (
    <g
      className={`mesh-node${isActive ? ' is-active' : ''}`}
      transform={`translate(${x} ${y})`}
      // biome-ignore lint/a11y/useSemanticElements: SVG <g> 不能是 <button>；role=button + tabIndex 是可聚焦图节点的正确 ARIA（旧 KnowledgeGraph 同例）
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      onClick={() => onPick(node)}
      onKeyDown={(e) => {
        // YUK-718 — role=button 图节点须同时响应 Space；preventDefault
        // 拦住 Space 页面滚动。沿用 QuestionsPage / DraftReviewPage 同例。
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(node);
        }
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
      {/* subject-driven: serif-CJK only for genuine yuwen nodes */}
      <text
        y={r + 18}
        textAnchor="middle"
        {...subjectContentPropsForDomain(node.effective_domain, {
          className: 'mesh-node-label',
        })}
      >
        {node.name.length > 8 ? `${node.name.slice(0, 8)}…` : node.name}
      </text>
    </g>
  );
});

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

  // hub 代理判定：有任意子节点的 node 视为 hub（r=24），否则叶（r=18）。
  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.parent_id != null) set.add(n.parent_id);
    return set;
  }, [nodes]);

  // YUK-717 — 边/节点元素数组只依赖真实输入（pos/edges/nodes/activeId/hasChildren/
  // onPick），与 view 无关。useMemo 后 pan/zoom 帧内引用不变 → 只有父 <g> 的
  // transform 字符串重算，未变元素零重建。activeId 变时数组重建，但 MeshNode 的
  // memo 让仅新旧 active 两节点重渲，其余仍跳过。
  const edgeEls = useMemo(
    () =>
      edges.map((e) => {
        const a = pos.get(e.from_knowledge_id);
        const b = pos.get(e.to_knowledge_id);
        if (!a || !b) return null;
        return (
          <MeshEdge key={e.id} ax={a.x} ay={a.y} bx={b.x} by={b.y} relationType={e.relation_type} />
        );
      }),
    [edges, pos],
  );

  const nodeEls = useMemo(
    () =>
      nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        return (
          <MeshNode
            key={n.id}
            node={n}
            x={p.x}
            y={p.y}
            isActive={activeId === n.id}
            isHub={hasChildren.has(n.id)}
            onPick={onPick}
          />
        );
      }),
    [nodes, pos, activeId, hasChildren, onPick],
  );

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
            {edgeEls}
            {nodeEls}
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
