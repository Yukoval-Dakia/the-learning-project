// Flow: the data says steps, links, groups and emphasis. The system lays it out (ELK) and draws it
// with tokens. Below 560px of its own width it reads as a list, not a tall chart: both forms come
// from the same data and a container query picks one.
import ELK from 'elkjs/lib/elk.bundled.js';
import { use, useId } from 'react';
import { roundedPath, textWidth, wrapText } from './text';

export interface FlowNode {
  id: string;
  label: string;
  sub?: string;
  kind?: 'step' | 'decision' | 'end';
  emphasis?: boolean;
  group?: string;
}
export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  back?: boolean;
}
export interface FlowData {
  key: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups?: Array<{ id: string; label: string }>;
  direction?: 'RIGHT' | 'DOWN';
  groupDirection?: 'RIGHT' | 'DOWN';
}

const FS = 13.5;
const SUB = 12;
const NODE_W = 176;
const PAD_X = 12;

function nodeSize(n: FlowNode) {
  const inner = NODE_W - PAD_X * 2;
  const labelLines = wrapText(n.label, FS, inner);
  const subLines = n.sub ? wrapText(n.sub, SUB, inner) : [];
  return {
    labelLines,
    subLines,
    width: NODE_W,
    height: 20 + labelLines.length * 18 + subLines.length * 16 + (subLines.length ? 2 : 0),
  };
}

const elk = new ELK();
const layouts = new Map<string, Promise<Laid>>();

interface Pt {
  x: number;
  y: number;
}
interface Laid {
  width: number;
  height: number;
  nodes: Array<FlowNode & Pt & { w: number; h: number; labelLines: string[]; subLines: string[] }>;
  groups: Array<{ id: string; label: string; x: number; y: number; w: number; h: number }>;
  edges: Array<{ edge: FlowEdge; points: Pt[]; labelAt?: Pt & { w: number; h: number } }>;
}

const BASE_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '18',
  'elk.layered.spacing.nodeNodeBetweenLayers': '36',
  'elk.spacing.edgeNode': '14',
  'elk.spacing.edgeEdge': '10',
  'elk.spacing.edgeLabel': '3',
  'elk.layered.mergeEdges': 'true',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
};

// biome-ignore lint/suspicious/noExplicitAny: throwaway prototype
async function runElk(nodes: FlowNode[], edges: FlowEdge[], direction: string): Promise<any> {
  return elk.layout({
    id: 'root',
    layoutOptions: { ...BASE_OPTIONS, 'elk.direction': direction },
    children: nodes.map((n) => ({ id: n.id, width: NODE_W, height: nodeSize(n).height })),
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.from],
      targets: [e.to],
      ...(e.label ? { labels: [{ text: e.label, width: textWidth(e.label, SUB) + 10, height: 18 }] } : {}),
    })),
    // biome-ignore lint/suspicious/noExplicitAny: throwaway prototype
  } as any);
}

// biome-ignore lint/suspicious/noExplicitAny: throwaway prototype
function placeEdges(out: any, edges: FlowEdge[], ox: number, oy: number): Laid['edges'] {
  // biome-ignore lint/suspicious/noExplicitAny: throwaway prototype
  return (out.edges ?? []).map((e: any, i: number) => {
    const s = e.sections?.[0];
    const label = e.labels?.[0];
    const shift = (p: Pt) => ({ x: p.x + ox, y: p.y + oy });
    return {
      edge: edges[i] as FlowEdge,
      points: s ? [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(shift) : [],
      ...(label ? { labelAt: { x: label.x + ox, y: label.y + oy, w: label.width, h: label.height } } : {}),
    };
  });
}

async function layout(data: FlowData): Promise<Laid> {
  const place = (n: FlowNode, x: number, y: number, w: number, h: number): Laid['nodes'][number] => {
    const s = nodeSize(n);
    return { ...n, x, y, w, h, labelLines: s.labelLines, subLines: s.subLines };
  };
  if (!data.groups?.length) {
    const forward = data.edges.filter((e) => !e.back);
    const out = await runElk(data.nodes, forward, data.direction ?? 'RIGHT');
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    return {
      width: out.width,
      height: out.height,
      // biome-ignore lint/suspicious/noExplicitAny: throwaway prototype
      nodes: out.children.map((c: any) => place(byId.get(c.id) as FlowNode, c.x, c.y, c.width, c.height)),
      groups: [],
      edges: placeEdges(out, forward, 0, 0),
    };
  }
  // Grouped: each group lays out on its own, top to bottom; groups sit side by side. Links between
  // groups and links going back are routed here, in the gutters ELK left alone.
  const GUTTER = 44;
  const INSET = { l: 30, r: 16, t: 34, b: 16 };
  const groupOf = new Map(data.nodes.map((n) => [n.id, n.group]));
  const inner = data.edges.filter((e) => !e.back && groupOf.get(e.from) === groupOf.get(e.to));
  const laidGroups = await Promise.all(
    data.groups.map(async (g) => ({
      g,
      out: await runElk(
        data.nodes.filter((n) => n.group === g.id),
        inner.filter((e) => groupOf.get(e.from) === g.id),
        'DOWN',
      ),
    })),
  );
  const maxH = Math.max(...laidGroups.map((x) => x.out.height));
  const nodes: Laid['nodes'] = [];
  const groups: Laid['groups'] = [];
  const edges: Laid['edges'] = [];
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  let x = 0;
  for (const { g, out } of laidGroups) {
    const w = out.width + INSET.l + INSET.r;
    groups.push({ id: g.id, label: g.label, x, y: 0, w, h: maxH + INSET.t + INSET.b });
    for (const c of out.children) {
      nodes.push(place(byId.get(c.id) as FlowNode, x + INSET.l + c.x, INSET.t + c.y, c.width, c.height));
    }
    edges.push(...placeEdges(out, inner.filter((e) => groupOf.get(e.from) === g.id), x + INSET.l, INSET.t));
    x += w + GUTTER;
  }
  const at = new Map(nodes.map((n) => [n.id, n]));
  for (const e of data.edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b) continue;
    if (e.back) {
      // A retry loop runs up the group's left inset.
      const lane = Math.min(a.x, b.x) - 16;
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      const label = e.label ? textWidth(e.label, SUB) + 10 : 0;
      edges.push({
        edge: e,
        points: [{ x: a.x, y: ay }, { x: lane, y: ay }, { x: lane, y: by }, { x: b.x, y: by }],
        ...(e.label ? { labelAt: { x: lane - label / 2, y: (ay + by) / 2 - 9, w: label, h: 18 } } : {}),
      });
    } else if (groupOf.get(e.from) !== groupOf.get(e.to)) {
      const ay = a.y + a.h / 2;
      const by = b.y + b.h / 2;
      const midX = a.x + a.w + 34;
      const label = e.label ? textWidth(e.label, SUB) + 10 : 0;
      edges.push({
        edge: e,
        points: [{ x: a.x + a.w, y: ay }, { x: midX, y: ay }, { x: midX, y: by }, { x: b.x, y: by }],
        ...(e.label ? { labelAt: { x: a.x + a.w + 9, y: ay - 9, w: label, h: 18 } } : {}),
      });
    }
  }
  return { width: x - GUTTER, height: maxH + INSET.t + INSET.b, nodes, groups, edges };
}

function layoutOf(data: FlowData): Promise<Laid> {
  let p = layouts.get(data.key);
  if (!p) {
    p = layout(data);
    layouts.set(data.key, p);
  }
  return p;
}

function FlowWide({ data }: { data: FlowData }) {
  const laid = use(layoutOf(data));
  const mid = `lp-arrow-${useId().replaceAll(':', '')}`;
  return (
    <svg
      className="lp-flow-svg"
      viewBox={`0 0 ${laid.width} ${laid.height}`}
      style={{ maxWidth: laid.width }}
      role="img"
      aria-hidden="true"
    >
      <defs>
        <marker id={mid} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1 L7 4 L1 7" className="lp-arrow" />
        </marker>
      </defs>
      {laid.groups.map((g) => (
        <g key={g.id}>
          <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={14} className="lp-group" />
          <text x={g.x + 14} y={g.y + 22} className="lp-group-label">
            {g.label}
          </text>
        </g>
      ))}
      {laid.edges.map(({ edge, points }) => (
        <path
          key={`${edge.from}-${edge.to}`}
          d={roundedPath(points, 8)}
          className={edge.back ? 'lp-edge lp-edge-back' : 'lp-edge'}
          markerEnd={`url(#${mid})`}
        />
      ))}
      {laid.nodes.map((n) => {
        let y = n.y + 10;
        return (
          <g key={n.id} data-kind={n.kind ?? 'step'} data-em={n.emphasis ? '1' : undefined} className="lp-node">
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10} />
            {n.labelLines.map((line) => {
              y += 18;
              return (
                <text key={line} x={n.x + PAD_X} y={y - 4} className="lp-node-label">
                  {line}
                </text>
              );
            })}
            {n.subLines.map((line) => {
              y += 16;
              return (
                <text key={line} x={n.x + PAD_X} y={y - 2} className="lp-node-sub">
                  {line}
                </text>
              );
            })}
          </g>
        );
      })}
      {laid.edges.map(({ edge, labelAt }) =>
        labelAt ? (
          <g key={`l-${edge.from}-${edge.to}`}>
            <rect x={labelAt.x} y={labelAt.y} width={labelAt.w} height={labelAt.h} rx={5} className="lp-edge-label-bg" />
            <text x={labelAt.x + labelAt.w / 2} y={labelAt.y + 13} textAnchor="middle" className="lp-edge-label">
              {edge.label}
            </text>
          </g>
        ) : null,
      )}
    </svg>
  );
}

/** The list form: walk the forward path; side exits become lines under their decision. */
function FlowList({ data }: { data: FlowData }) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const outOf = (id: string) => data.edges.filter((e) => e.from === id);
  const hasIn = new Set(data.edges.filter((e) => !e.back).map((e) => e.to));
  const order: FlowNode[] = [];
  const seen = new Set<string>();
  const inlined = new Set<string>();
  for (const n of data.nodes) {
    if (n.kind !== 'decision') continue;
    const forward = outOf(n.id).filter((e) => !e.back);
    if (forward.length > 1) {
      for (const e of forward) if (outOf(e.to).length === 0) inlined.add(e.to);
    }
  }
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    if (!inlined.has(id)) order.push(n);
    for (const e of outOf(id)) if (!e.back) walk(e.to);
  };
  for (const n of data.nodes) if (!hasIn.has(n.id)) walk(n.id);

  let lastGroup: string | undefined;
  let step = 0;
  return (
    <ol className="lp-list">
      {order.map((n) => {
        const groupLabel = n.group !== lastGroup ? data.groups?.find((g) => g.id === n.group)?.label : undefined;
        lastGroup = n.group;
        step += 1;
        const exits = outOf(n.id).filter((e) => e.back || inlined.has(e.to));
        return (
          <li key={n.id} className="lp-li" data-kind={n.kind ?? 'step'} data-em={n.emphasis ? '1' : undefined}>
            {groupLabel ? <span className="lp-li-group">{groupLabel}</span> : null}
            <span className="lp-li-mark" aria-hidden="true">
              {step}
            </span>
            <span className="lp-li-label">{n.label}</span>
            {n.sub ? <span className="lp-li-sub">{n.sub}</span> : null}
            {exits.map((e) => (
              <span key={e.to} className="lp-li-exit" data-back={e.back ? '1' : undefined}>
                {e.label ? <b>{e.label}</b> : null}
                {e.back ? `回到「${byId.get(e.to)?.label}」` : byId.get(e.to)?.label}
              </span>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

export function FlowBlock({ data, caption }: { data: FlowData; caption: string }) {
  return (
    <figure className="lp-block lp-flow">
      <div className="lp-flow-wide">
        <FlowWide data={data} />
      </div>
      <div className="lp-flow-narrow">
        <FlowList data={data} />
      </div>
      <figcaption className="lp-caption">{caption}</figcaption>
    </figure>
  );
}
