// M3 知识面 — 图谱视图（YUK-317）。
// 设计基准 docs/design/loom-refresh/project/screen-knowledge.jsx（MeshGraph）：
// 可平移缩放的 mesh，5 类 typed 边用 glyph/虚线/箭头做非颜色 cue（REL_CUE，
// data-2b.jsx）。布局 = 移植的 cytoscape+fcose headless（layout.ts，#363 形态
// 裁决产物）；渲染层按设计稿重写为轻量 SVG。

import { ArrowRight, Inbox, Link2, Minus, Plus, RotateCcw } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';

import { subjectContentPropsForDomain } from '@/ui/lib/subject';
import { Button, IconButton } from '@/ui-next/public';
import type { MeshGraphNode } from './ghost-endpoints';
import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';
import { isKnowledgeContainer } from './knowledge-node-kind';
import { layoutMeshLabel } from './label-layout';
import { LAYOUT_HEIGHT, LAYOUT_WIDTH, computeLayout } from './layout';
import { masteryTone } from './mastery-tone';
import { REL_CUE } from './relation-cue';

// wire 的 KnowledgeTreeNode 无 kind 字段——hub 用「是否有子节点」代理判定
// （存在别的 node.parent_id === 本 id ⇒ hub）。设计稿 kind:'hub' 节点 r=24，
// 叶 r=18（screen-knowledge.jsx L84）。
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.4;
const clampZoom = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

// Dash pattern of one edge: cross-subject edges share one dash; otherwise the relation's own cue.
function edgeDash(isCrossSubject: boolean, dash: string): string | undefined {
  if (isCrossSubject) return '6 4';
  return dash === '0' ? undefined : dash;
}

// Text in the middle of a node: containers say so, unpracticed nodes show a dash.
function nodeCenterText(isContainer: boolean, pct: number | null): string | number {
  if (isContainer) return '容器';
  return pct == null ? '—' : pct;
}

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
  isCrossSubject,
}: {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  relationType: string;
  isCrossSubject: boolean;
}) {
  // F2 (Codex #400)：未知/experimental:* 关系类型 cue 回退 related_to，
  // class 必须同源折回——否则 className 拼出无 CSS 匹配的 kn-rel-experimental:*，
  // 而 .kn-edge-path 无默认 stroke → 边描边 none 不可见（cue 已折回但颜色没折，
  // 用户看到悬空「— 相关」标签却没连线）。relKey 让 cue 与 class 共用一个键。
  const relKey = REL_CUE[relationType] ? relationType : 'related_to';
  const cue = REL_CUE[relKey];
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2 - 18;
  return (
    <g className="kn-edge">
      {/* 颜色由 .kn-rel-{type} 类驱动（knowledge-m3e.css，M3 角色）；dash + 箭头
          仍是非颜色 cue，typed 边即便色盲也能解码。 */}
      <path
        d={`M ${ax} ${ay} Q ${mx} ${my} ${bx} ${by}`}
        className={`kn-edge-path kn-rel-${relKey}${isCrossSubject ? ' is-cross' : ''}`}
        strokeDasharray={edgeDash(isCrossSubject, cue.dash)}
        markerEnd={cue.arrow ? 'url(#mesh-arrow)' : undefined}
      />
      <text x={mx} y={my + 6} textAnchor="middle" className="kn-edge-label">
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
  isContainer,
  onPick,
}: {
  node: MeshGraphNode;
  x: number;
  y: number;
  isActive: boolean;
  isHub: boolean;
  isContainer: boolean;
  onPick: (node: KnowledgeTreeNode) => void;
}) {
  const m = isContainer ? null : node.mastery;
  const pct = m == null ? null : Math.round(m * 100);
  const tone = masteryTone(m ?? undefined);
  const r = isHub ? 24 : 18;
  const circ = 2 * Math.PI * r;
  const label = layoutMeshLabel(node.name);
  return (
    <g
      className={`kn-node${isActive ? ' is-active' : ''}${node.isGhost ? ' is-ghost' : ''}`}
      transform={`translate(${x} ${y})`}
      aria-label={`${label.fullName}${node.isGhost ? '（其他科目）' : ''}`}
      // biome-ignore lint/a11y/useSemanticElements: SVG <g> 不能是 <button>；role=button + tabIndex 是可聚焦图节点的正确 ARIA（旧 KnowledgeGraph 同例）
      role="button"
      tabIndex={0}
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
      <title>{label.fullName}</title>
      {/* 透明命中圈：比可见 disc 大一圈，保证小节点也好点（A2）。 */}
      <circle className="kn-node-hit" r={r + 6} />
      {/* 三层节点：填充 disc → 满轨底环 → 掌握度弧。选中 / 聚焦 / 他科 的描边全交给 CSS
          （.kn-node.is-active .kn-disc 胜过 .kn-disc.tone-*），颜色走 M3 角色。 */}
      <circle className={`kn-disc tone-${pct == null ? 'none' : tone}`} r={r} />
      <circle r={r} fill="none" className="kn-track" />
      {/* mastery=null（从未练）只渲 track，不渲 arc——无掌握度可绘。 */}
      {m != null && (
        <circle
          r={r}
          fill="none"
          className={`kn-arc tone-${tone}`}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - m)}
          transform="rotate(-90)"
        />
      )}
      <text y={4} textAnchor="middle" className="kn-node-pct">
        {nodeCenterText(isContainer, pct)}
      </text>
      <rect
        x={-label.width / 2}
        y={r + 7}
        width={label.width}
        height={label.height}
        rx={8}
        className="kn-node-label-bg"
      />
      {/* subject-driven: serif-CJK only for genuine yuwen nodes */}
      <text
        y={r + 21}
        textAnchor="middle"
        {...subjectContentPropsForDomain(node.effective_domain, {
          className: 'kn-node-label',
        })}
      >
        {label.lines.map((line, index) => (
          <tspan key={`${line}-${line.length}`} x="0" dy={index === 0 ? 0 : label.lineHeight}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
});

export function MeshGraph({
  nodes,
  edges,
  onPick,
  activeId,
  navigate,
}: {
  nodes: readonly MeshGraphNode[];
  edges: readonly KnowledgeEdgeRow[];
  onPick: (node: MeshGraphNode) => void;
  activeId?: string | null;
  navigate?: (to: string) => void;
}) {
  // LayoutNode/LayoutEdge 字段名与 wire 一致（parent_id / from_knowledge_id），直传。
  const pos = useMemo(() => computeLayout([...nodes], [...edges]), [nodes, edges]);

  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // hub 代理判定：有任意子节点的 node 视为 hub（r=24），否则叶（r=18）。
  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.parent_id != null) set.add(n.parent_id);
    return set;
  }, [nodes]);

  const ghostIds = useMemo(
    () => new Set(nodes.filter((node) => node.isGhost).map((node) => node.id)),
    [nodes],
  );

  const crossEdgeCount = useMemo(
    () =>
      edges.filter((edge) => {
        const from = pos.get(edge.from_knowledge_id);
        const to = pos.get(edge.to_knowledge_id);
        return (
          from !== undefined &&
          to !== undefined &&
          ghostIds.has(edge.from_knowledge_id) !== ghostIds.has(edge.to_knowledge_id)
        );
      }).length,
    [edges, ghostIds, pos],
  );

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
        const isCrossSubject =
          ghostIds.has(e.from_knowledge_id) !== ghostIds.has(e.to_knowledge_id);
        return (
          <MeshEdge
            key={e.id}
            ax={a.x}
            ay={a.y}
            bx={b.x}
            by={b.y}
            relationType={e.relation_type}
            isCrossSubject={isCrossSubject}
          />
        );
      }),
    [edges, ghostIds, pos],
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
            isContainer={isKnowledgeContainer(n)}
            onPick={onPick}
          />
        );
      }),
    [nodes, pos, activeId, hasChildren, onPick],
  );

  return (
    <div className="kn-graph" role="group" aria-label="知识关系图">
      {edges.length === 0 && (
        <div className="kn-graph-empty" role="status">
          <Link2 size={16} aria-hidden="true" />
          <strong>关系图还没有连接</strong>
          <span>先从树视图打开一个知识点，或在详情里建立关系。</span>
          {navigate && (
            <Button size="sm" onClick={() => navigate('/inbox')}>
              <Inbox size={14} aria-hidden="true" />
              查看 AI 关系提议
              <ArrowRight size={14} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}

      {/* 点阵底 stage（M3 surface-container-low + outline-variant 点阵）。pan/zoom 指针手势
          挂在内层 <svg> 上，键盘交互由各节点 <g> 提供。 */}
      <div className="kn-graph-stage">
        {/* 缩放 controls：缩小 / 百分比 / 放大 / 复位。浮在图上，所以用玻璃（T3）。 */}
        <div className="kn-graph-controls un-glass">
          <IconButton
            label="缩小"
            icon={<Minus size={16} />}
            onClick={() => setView((v) => ({ ...v, k: clampZoom(v.k - 0.1) }))}
          />
          <span className="kn-graph-zoom un-num">{Math.round(view.k * 100)}%</span>
          <IconButton
            label="放大"
            icon={<Plus size={16} />}
            onClick={() => setView((v) => ({ ...v, k: clampZoom(v.k + 0.1) }))}
          />
          <span className="kn-graph-ctrl-div" aria-hidden="true" />
          <IconButton
            label="复位"
            icon={<RotateCcw size={16} />}
            onClick={() => setView({ x: 0, y: 0, k: 1 })}
          />
        </div>
        <svg
          className="kn-graph-svg"
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
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edgeEls}
            {nodeEls}
          </g>
        </svg>
      </div>

      {/* 关系图例：typed 边的解码钥匙。 */}
      <ul className="kn-graph-legend" aria-label="关系图例">
        {Object.entries(REL_CUE).map(([type, cue]) => (
          <li key={type} className="kn-legend-item">
            <svg width="26" height="10" aria-hidden="true">
              <line
                className={`kn-rel-${type}`}
                x1="1"
                y1="5"
                x2="25"
                y2="5"
                strokeDasharray={cue.dash === '0' ? undefined : cue.dash}
                markerEnd={cue.arrow ? 'url(#mesh-arrow)' : undefined}
              />
            </svg>
            <span>
              <span className="kn-glyph">{cue.glyph}</span> {cue.label}
            </span>
          </li>
        ))}
        {crossEdgeCount > 0 && (
          <li className="kn-legend-item kn-legend-cross">
            <span className="kn-legend-cross-mark" aria-hidden="true" />
            <span role="status" aria-label={`跨科连接 ${crossEdgeCount}`}>
              跨科连接 {crossEdgeCount}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}
