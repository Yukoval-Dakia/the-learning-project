// Apparatus: the data names the equipment, what is in it and how it connects. Every shape, port,
// pipe route and label position comes from this library, so a figure can't have a crossed label or a
// flask floating off its stand. Below 620px of its own width the same chain wraps onto two benches.
import { type ReactNode, useId } from 'react';
import { ChemTspans } from './Chem';
import { roundedPath, textWidth, wrapText } from './text';

export type ApparatusDevice =
  | { id: string; type: 'heated_flask_funnel'; flask: string; funnel: string; name: string; role: string }
  | { id: string; type: 'wash_bottle'; liquid: 'brine' | 'acid'; name: string; role: string }
  | { id: string; type: 'collect_bottle'; gas: 'chlorine'; name: string; role: string }
  | { id: string; type: 'absorb_beaker'; liquid: 'base'; name: string; role: string };

export interface ApparatusData {
  key: string;
  devices: ApparatusDevice[];
  /** Each device feeds the next one named here. */
  chain: string[];
  /** Devices per bench when it has to wrap. */
  wrap: string[][];
}

interface Spec {
  left: number;
  right: number;
  top: number;
  in?: { x: number; y: number };
  out?: { x: number; y: number };
  draw: (uid: string) => ReactNode;
}

function Tube({ d }: { d: string }) {
  return (
    <>
      <path d={d} className="ap-tube" />
      <path d={d} className="ap-tube-core" />
    </>
  );
}

function Leader({ text, sub, y, tx }: { text: string; sub?: string; y: number; tx: number }) {
  return (
    <g>
      <path d={`M-100,${y} L${tx},${y}`} className="ap-leader" />
      <circle cx={tx} cy={y} r={1.8} className="ap-leader-dot" />
      <text x={-104} y={sub ? y - 2 : y + 4} textAnchor="end" className="ap-part">
        {text}
      </text>
      {sub ? (
        <text x={-104} y={y + 13} textAnchor="end" className="ap-part-sub">
          <ChemTspans text={sub} />
        </text>
      ) : null}
    </g>
  );
}

function heatedFlask(d: Extract<ApparatusDevice, { type: 'heated_flask_funnel' }>): Spec {
  return {
    left: 164,
    right: 46,
    top: 296,
    out: { x: 5, y: -182 },
    draw: (uid) => (
      <g>
        <defs>
          <clipPath id={`${uid}-flask`}>
            <path d="M-9,-172 L-9,-138 A34,34 0 1 0 9,-138 L9,-172 Z" />
          </clipPath>
          <clipPath id={`${uid}-bulb`}>
            <path d="M-11,-284 L3,-284 C20,-268 20,-254 -2,-238 L-6,-238 C-28,-254 -28,-268 -11,-284 Z" />
          </clipPath>
        </defs>
        {/* stand */}
        <rect x={-92} y={-6} width={120} height={6} rx={2} className="ap-steel" />
        <rect x={-64} y={-292} width={4} height={286} rx={2} className="ap-steel" />
        <path d="M-62,-70 L-36,-70" className="ap-arm" />
        <path d="M-62,-156 L-12,-156" className="ap-arm" />
        <rect x={-14} y={-162} width={28} height={12} rx={4} className="ap-clamp" />
        <path d="M-62,-226 L-9,-226" className="ap-arm" />
        <rect x={-66} y={-160} width={8} height={8} rx={2} className="ap-steel" />
        <rect x={-66} y={-74} width={8} height={8} rx={2} className="ap-steel" />
        <rect x={-66} y={-230} width={8} height={8} rx={2} className="ap-steel" />
        {/* lamp and flame */}
        <path d="M-19,-12 Q-19,-6 -13,-6 L13,-6 Q19,-6 19,-12 L19,-26 Q19,-34 8,-36 L-8,-36 Q-19,-34 -19,-26 Z" className="ap-glass" />
        <path d="M-19,-18 L19,-18 L19,-12 Q19,-6 13,-6 L-13,-6 Q-19,-6 -19,-12 Z" className="ap-liquid ap-liquid-lamp" />
        <rect x={-3} y={-42} width={6} height={6} rx={1} className="ap-steel" />
        <path d="M0,-66 C7,-56 6,-48 0,-43 C-6,-48 -7,-56 0,-66 Z" className="ap-flame" />
        {/* gauze */}
        <path d="M-36,-70 L36,-70" className="ap-gauze" />
        {/* flask */}
        <g clipPath={`url(#${uid}-flask)`}>
          <rect x={-40} y={-92} width={80} height={30} className="ap-liquid ap-liquid-acid" />
        </g>
        <g className="ap-solid">
          <circle cx={-10} cy={-76} r={2.4} />
          <circle cx={-3} cy={-74.4} r={2.6} />
          <circle cx={5} cy={-74.8} r={2.3} />
          <circle cx={11} cy={-77} r={2.1} />
          <circle cx={1} cy={-78.6} r={2} />
        </g>
        <path d="M-9,-172 L-9,-138 A34,34 0 1 0 9,-138 L9,-172" className="ap-glass" />
        {/* funnel */}
        <g clipPath={`url(#${uid}-bulb)`}>
          <rect x={-30} y={-264} width={56} height={30} className="ap-liquid ap-liquid-acid" />
        </g>
        <path d="M-11,-284 L3,-284 C20,-268 20,-254 -2,-238 L-6,-238 C-28,-254 -28,-268 -11,-284 Z" className="ap-glass" />
        <rect x={-10} y={-291} width={12} height={8} rx={2} className="ap-rubber" />
        <Tube d="M-4,-238 L-4,-150" />
        <rect x={-10} y={-214} width={12} height={5} rx={2} className="ap-cock" />
        {/* stopper and outlet */}
        <rect x={-12} y={-182} width={24} height={12} rx={2.5} className="ap-rubber" />
        <Tube d="M5,-182 L5,-164" />
        {/* part names, placed by the system */}
        <Leader text="分液漏斗" sub={d.funnel} y={-258} tx={-20} />
        <Leader text="圆底烧瓶" sub={d.flask} y={-110} tx={-33} />
        <Leader text="陶土网" y={-70} tx={-34} />
        <Leader text="酒精灯" y={-24} tx={-19} />
      </g>
    ),
  };
}

function bottleBody(uid: string, inner: ReactNode) {
  const path =
    'M-28,-8 Q-28,0 -20,0 L20,0 Q28,0 28,-8 L28,-76 Q28,-90 15,-94 L15,-104 L-15,-104 L-15,-94 Q-28,-90 -28,-76 Z';
  return (
    <>
      <defs>
        <clipPath id={`${uid}-b`}>
          <path d={path} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${uid}-b)`}>{inner}</g>
      <path d={path} className="ap-glass" />
      <rect x={-18} y={-112} width={36} height={10} rx={2.5} className="ap-rubber" />
    </>
  );
}

function bubbles(x: number, y: number) {
  return (
    <g className="ap-bubble">
      <circle cx={x + 3} cy={y - 7} r={1.7} />
      <circle cx={x - 2} cy={y - 15} r={1.3} />
      <circle cx={x + 2} cy={y - 23} r={1} />
    </g>
  );
}

function washBottle(d: Extract<ApparatusDevice, { type: 'wash_bottle' }>): Spec {
  return {
    left: 30,
    right: 30,
    top: 112,
    in: { x: -7, y: -112 },
    out: { x: 7, y: -112 },
    draw: (uid) => (
      <g>
        {bottleBody(uid, <rect x={-30} y={-56} width={60} height={60} className={`ap-liquid ap-liquid-${d.liquid}`} />)}
        <Tube d="M-7,-112 L-7,-13" />
        {bubbles(-7, -13)}
        <Tube d="M7,-112 L7,-88" />
      </g>
    ),
  };
}

function collectBottle(_d: Extract<ApparatusDevice, { type: 'collect_bottle' }>): Spec {
  return {
    left: 30,
    right: 30,
    top: 112,
    in: { x: -7, y: -112 },
    out: { x: 7, y: -112 },
    draw: (uid) => (
      <g>
        <defs>
          <linearGradient id={`${uid}-g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="ap-gas-top" />
            <stop offset="1" className="ap-gas-bottom" />
          </linearGradient>
        </defs>
        {bottleBody(uid, <rect x={-30} y={-104} width={60} height={106} fill={`url(#${uid}-g)`} />)}
        <Tube d="M-7,-112 L-7,-12" />
        <Tube d="M7,-112 L7,-90" />
      </g>
    ),
  };
}

function absorbBeaker(d: Extract<ApparatusDevice, { type: 'absorb_beaker' }>): Spec {
  const path = 'M-37,-74 L-33,-70 L-33,-6 Q-33,0 -27,0 L27,0 Q33,0 33,-6 L33,-70 L37,-74';
  return {
    left: 38,
    right: 38,
    top: 92,
    in: { x: 0, y: -92 },
    draw: (uid) => (
      <g>
        <defs>
          <clipPath id={`${uid}-b`}>
            <path d="M-33,-70 L-33,-6 Q-33,0 -27,0 L27,0 Q33,0 33,-6 L33,-70 Z" />
          </clipPath>
        </defs>
        <g clipPath={`url(#${uid}-b)`}>
          <rect x={-34} y={-42} width={68} height={44} className={`ap-liquid ap-liquid-${d.liquid}`} />
        </g>
        <path d={path} className="ap-glass" />
        <Tube d="M0,-92 L0,-14" />
        {bubbles(0, -14)}
      </g>
    ),
  };
}

function specOf(d: ApparatusDevice): Spec {
  switch (d.type) {
    case 'heated_flask_funnel':
      return heatedFlask(d);
    case 'wash_bottle':
      return washBottle(d);
    case 'collect_bottle':
      return collectBottle(d);
    case 'absorb_beaker':
      return absorbBeaker(d);
  }
}

const LANE = -146;
const CROSS_LANE = -170;
const NAME = 13;
const ROLE = 12;

function Bench({ data, rows, form }: { data: ApparatusData; rows: string[][]; form: string }) {
  // One id per rendered copy: a hidden form's clip paths must not capture the visible form's.
  const instance = useId().replaceAll(':', '');
  const byId = new Map(data.devices.map((d) => [d.id, d]));
  const labelW = form === 'wide' ? 96 : 88;
  const gap = form === 'wide' ? 10 : 6;
  const placed = new Map<
    string,
    { d: ApparatusDevice; spec: Spec; cx: number; base: number; labelX: number; n: number }
  >();
  const margin = 12;
  let y = 0;
  let width = 0;
  const benches: Array<{ y: number; w: number }> = [];
  const labels: ReactNode[] = [];
  let n = 0;
  for (const row of rows) {
    const specs = row.map((id) => {
      const d = byId.get(id) as ApparatusDevice;
      return { d, spec: specOf(d) };
    });
    // A later bench leaves room above for the pipe arriving from the bench before it.
    const top = Math.max(...specs.map((s) => s.spec.top), benches.length > 0 ? -CROSS_LANE : 0) + 14;
    const base = y + top;
    let x = 0;
    let labelH = 0;
    for (const { d, spec } of specs) {
      n += 1;
      const w = Math.max(spec.left + spec.right, labelW);
      const cx = x + (w - (spec.left + spec.right)) / 2 + spec.left;
      const labelSpan = spec.left > 100 ? spec.left + spec.right - 104 : w;
      const labelX = spec.left > 100 ? cx - spec.left + 104 + labelSpan / 2 : x + w / 2;
      placed.set(d.id, { d, spec, cx, base, labelX, n });
      const nameLines = wrapText(`${'①②③④⑤⑥'[n - 1]} ${d.name}`, NAME, labelSpan);
      const roleLines = wrapText(d.role, ROLE, labelSpan);
      labelH = Math.max(labelH, nameLines.length * 17 + roleLines.length * 16);
      labels.push(
        <g key={d.id}>
          {nameLines.map((line, i) => (
            <text key={line} x={labelX} y={base + 20 + i * 17} textAnchor="middle" className="ap-name">
              <ChemTspans text={line} />
            </text>
          ))}
          {roleLines.map((line, i) => (
            <text key={line} x={labelX} y={base + 20 + nameLines.length * 17 + i * 16} textAnchor="middle" className="ap-role">
              <ChemTspans text={line} />
            </text>
          ))}
        </g>,
      );
      x += w + gap;
    }
    width = Math.max(width, x - gap);
    benches.push({ y: base, w: x - gap });
    y = base + 14 + labelH + 26;
  }
  const height = y - 26;
  const totalW = width + (rows.length > 1 ? margin : 0);

  const pipes: Array<{ pts: Array<{ x: number; y: number }>; key: string }> = [];
  for (let i = 0; i < data.chain.length - 1; i++) {
    const a = placed.get(data.chain[i] as string);
    const b = placed.get(data.chain[i + 1] as string);
    if (!a || !b || !a.spec.out || !b.spec.in) continue;
    const ax = a.cx + a.spec.out.x;
    const ay = a.base + a.spec.out.y;
    const bx = b.cx + b.spec.in.x;
    const by = b.base + b.spec.in.y;
    const pts: Array<{ x: number; y: number }> = [{ x: ax, y: ay }];
    if (a.d.type === 'heated_flask_funnel') {
      // Clear the funnel stem, then come down to the shared lane.
      pts.push({ x: ax, y: a.base - 198 }, { x: a.cx + 38, y: a.base - 198 }, { x: a.cx + 38, y: a.base + LANE });
    } else {
      pts.push({ x: ax, y: a.base + LANE });
    }
    if (a.base === b.base) {
      pts.push({ x: bx, y: b.base + LANE }, { x: bx, y: by });
    } else {
      const edge = totalW - 2;
      pts.push({ x: edge, y: a.base + LANE }, { x: edge, y: b.base + CROSS_LANE }, { x: bx, y: b.base + CROSS_LANE }, { x: bx, y: by });
    }
    pipes.push({ pts, key: `${data.chain[i]}-${data.chain[i + 1]}` });
  }

  const flowMarks = pipes.flatMap(({ pts, key }) => {
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i] as { x: number; y: number };
      const q = pts[i + 1] as { x: number; y: number };
      if (p.y === q.y && Math.abs(q.x - p.x) > bestLen) {
        best = i;
        bestLen = Math.abs(q.x - p.x);
      }
    }
    if (best < 0) return [];
    const p = pts[best] as { x: number; y: number };
    const q = pts[best + 1] as { x: number; y: number };
    const dir = Math.sign(q.x - p.x);
    const mx = (p.x + q.x) / 2;
    return [
      <path key={`m-${key}`} d={`M${mx - dir * 3},${p.y - 4} L${mx + dir * 2},${p.y} L${mx - dir * 3},${p.y + 4}`} className="ap-flow" />,
    ];
  });

  return (
    <svg className="ap-svg" viewBox={`0 0 ${totalW} ${height}`} style={{ maxWidth: totalW }} role="img" aria-hidden="true">
      {benches.map((b) => (
        <path key={b.y} d={`M0,${b.y} L${totalW},${b.y}`} className="ap-bench" />
      ))}
      {[...placed.values()].map(({ d, spec, cx, base }) => (
        <g key={d.id} transform={`translate(${cx},${base})`}>
          {spec.draw(`${instance}-${d.id}`)}
        </g>
      ))}
      {pipes.map(({ pts, key }) => {
        const dd = roundedPath(pts, 7);
        return (
          <g key={key}>
            <path d={dd} className="ap-tube" />
            <path d={dd} className="ap-tube-core" />
          </g>
        );
      })}
      {flowMarks}
      {labels}
    </svg>
  );
}

export function ApparatusBlock({ data, caption }: { data: ApparatusData; caption: string }) {
  return (
    <figure className="lp-block ap">
      <div className="ap-wide">
        <Bench data={data} rows={[data.chain]} form="wide" />
      </div>
      <div className="ap-narrow">
        <Bench data={data} rows={data.wrap} form="narrow" />
      </div>
      <figcaption className="lp-caption">{caption}</figcaption>
    </figure>
  );
}

export const _width = textWidth;
