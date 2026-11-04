// Function plots: the data is only a, b, c. Scale, ticks, roots, vertex and every label are computed,
// so the curve can't be wrong and nothing can collide.
const W = 208;
const H = 132;
const PAD = { l: 10, r: 10, t: 6, b: 20 };

export interface QuadCase {
  a: number;
  b: number;
  c: number;
}

function sign(n: number, first: boolean, unit: string): string {
  if (n === 0) return '';
  const abs = Math.abs(n);
  const body = abs === 1 && unit ? unit : `${abs}${unit}`;
  if (first) return `${n < 0 ? '−' : ''}${body}`;
  return ` ${n < 0 ? '−' : '+'} ${body}`;
}

export function quadFormula({ a, b, c }: QuadCase): string {
  return `y = ${sign(a, true, 'x²')}${sign(b, false, 'x')}${sign(c, false, '')}`;
}

function Plot({ q }: { q: QuadCase }) {
  const delta = q.b * q.b - 4 * q.a * q.c;
  const vx = -q.b / (2 * q.a);
  const vy = q.a * vx * vx + q.b * vx + q.c;
  const roots = delta > 0
    ? [(-q.b - Math.sqrt(delta)) / (2 * q.a), (-q.b + Math.sqrt(delta)) / (2 * q.a)]
    : delta === 0
      ? [vx]
      : [];
  const span = Math.max(3, ...roots.map((r) => Math.abs(r - vx) + 1.4));
  const x0 = vx - span;
  const x1 = vx + span;
  const f = (x: number) => q.a * x * x + q.b * x + q.c;
  const yHi = Math.max(f(x0), 2);
  const yLo = Math.min(vy, -1.2);
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => PAD.t + ((yHi - y) / (yHi - yLo)) * (H - PAD.t - PAD.b);
  let d = '';
  for (let i = 0; i <= 80; i++) {
    const x = x0 + ((x1 - x0) * i) / 80;
    d += `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(f(x)).toFixed(1)}`;
  }
  const yAxisX = x0 < 0 && x1 > 0 ? sx(0) : PAD.l;
  return (
    <svg className="pl-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
      <path d={`M${PAD.l},${sy(0)} L${W - PAD.r},${sy(0)}`} className="pl-axis" />
      <path d={`M${yAxisX},${PAD.t} L${yAxisX},${H - PAD.b}`} className="pl-axis" />
      <text x={W - PAD.r} y={sy(0) - 5} textAnchor="end" className="pl-axis-name">x</text>
      <text x={yAxisX + 5} y={PAD.t + 9} className="pl-axis-name">y</text>
      <path d={d} className="pl-curve" />
      {roots.map((r, i) => (
        <g key={r}>
          <circle cx={sx(r)} cy={sy(0)} r={3.4} className="pl-root" />
          <text
            x={sx(r)}
            y={sy(0) + 15}
            textAnchor={roots.length === 1 ? 'middle' : i === 0 ? 'end' : 'start'}
            className="pl-root-label"
          >
            {`${Number.isInteger(r) ? r : r.toFixed(1)}`.replace('-', '−')}
          </text>
        </g>
      ))}
      {delta < 0 ? <circle cx={sx(vx)} cy={sy(vy)} r={2.6} className="pl-vertex" /> : null}
    </svg>
  );
}

const WORDS = (delta: number) =>
  delta > 0 ? '两个不相等的实数根' : delta === 0 ? '两个相等的实数根' : '没有实数根';

export function PlotBlock({ cases, caption }: { cases: QuadCase[]; caption: string }) {
  return (
    <figure className="lp-block pl">
      <div className="pl-grid">
        {cases.map((q) => {
          const delta = q.b * q.b - 4 * q.a * q.c;
          const rel = delta > 0 ? '> 0' : delta === 0 ? '= 0' : '< 0';
          return (
            <div key={quadFormula(q)} className="pl-cell">
              <Plot q={q} />
              <div className="pl-text">
                <span className="pl-formula">{quadFormula(q)}</span>
                <span className="pl-delta">{delta === 0 ? 'Δ = 0' : `Δ = ${delta < 0 ? '−' : ''}${Math.abs(delta)} ${rel}`}</span>
                <span className="pl-result">{WORDS(delta)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <figcaption className="lp-caption">{caption}</figcaption>
    </figure>
  );
}
