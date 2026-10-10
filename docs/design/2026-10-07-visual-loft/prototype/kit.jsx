// Small shared kit for the product prototype: math, icons, figure. Pure presentational.
import katex from 'katex';
import { useMemo } from 'react';

/* ── Math ─────────────────────────────────────────────── */
const texCache = new Map();
function tex(src) {
  if (!texCache.has(src)) texCache.set(src, katex.renderToString(src, { throwOnError: false, output: 'html' }));
  return texCache.get(src);
}

// Preload rule: render every formula of the likely next screen in idle chunks, so the
// screen switch never pays for KaTeX inside the transition frame.
export function warmMath(strings) {
  const queue = strings.flatMap((s) => s.match(/\$[^$]+\$/g) ?? []).map((m) => m.slice(1, -1)).filter((m) => !texCache.has(m));
  const idle = window.requestIdleCallback ?? ((fn) => window.setTimeout(() => fn({ timeRemaining: () => 8 }), 1));
  const step = (deadline) => {
    while (queue.length && deadline.timeRemaining() > 2) tex(queue.shift());
    if (queue.length) idle(step);
  };
  idle(step);
}

// The same rendering as an HTML string, for transient ghosts outside React.
export function mathHTML(text) {
  const esc = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return text
    .split(/(\$[^$]+\$)/g)
    .filter(Boolean)
    .map((p) => (p.startsWith('$') ? `<span class="tex">${tex(p.slice(1, -1))}</span>` : esc(p)))
    .join('');
}

export function MathText({ text, as: Tag = 'span', className }) {
  const parts = useMemo(() => text.split(/(\$[^$]+\$)/g).filter(Boolean), [text]);
  return (
    <Tag className={className}>
      {parts.map((p, i) =>
        p.startsWith('$') ? (
          // biome-ignore lint: prototype renders trusted fixture TeX
          <span key={i} className="tex" data-tex={p.slice(1, -1)} dangerouslySetInnerHTML={{ __html: tex(p.slice(1, -1)) }} />
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </Tag>
  );
}

/* ── Icons (1.5px stroke, 24 grid) ───────────────────── */
const P = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z',
  pen: 'M15.5 4.5l4 4L8 20H4v-4zM13.5 6.5l4 4',
  book: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  layers: 'M12 4 3 9l9 5 9-5zM3 14l9 5 9-5',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 11a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  paste: 'M9 4h6v3H9zM7 5.5H5V20h14V5.5h-2M8 12h8M8 16h5',
  mic: 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v3',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  clock: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 8v4l3 2',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4.5 20a7.5 7.5 0 0 1 15 0',
  settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19 12l2-1-1-3-2.2.3-1.3-1.3L16.8 4.8l-3-1-1 2h-1.6l-1-2-3 1 .3 2.2L6.2 8.3 4 8l-1 3 2 1v.1l-2 1 1 3 2.2-.3 1.3 1.3-.3 2.2 3 1 1-2h1.6l1 2 3-1-.3-2.2 1.3-1.3 2.2.3 1-3-2-1z',
  thread: 'M7 4v16M7 8h7a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H7',
  pause: 'M8 5v14M16 5v14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  panel: 'M4 5h16v14H4zM4 14h16',
  question: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  photo: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 8.5h.01',
  undo: 'M9 7 5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  tray: 'M4 13h4l1.5 3h5l1.5-3h4M4 13l2.5-7h11L20 13v6H4z',
  chat: 'M5 5h14v10H9l-4 4z',
  note: 'M6 4h9l3 3v13H6zM9 10h6M9 14h6',
  stack: 'M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4',
  send: 'M5 12l14-7-5 14-3-6z',
  at: 'M16 12a4 4 0 1 1-1.2-2.8V13a2 2 0 0 0 4 0v-1a7 7 0 1 0-2.6 5.4',
  quote: 'M7 7h4v4H8v3H5v-3zM15 7h4v4h-3v3h-3v-3z',
  panel_right: 'M4 5h16v14H4zM15 5v14',
  filter: 'M4 6h16M7 12h10M10 18h4',
  tray: 'M4 13h4l1.5 3h5l1.5-3h4M4 13l2.5-7h11L20 13v6H4z',
};

export function Icon({ name, size, className }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size ?? 18}
      height={size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={P[name]} />
    </svg>
  );
}

export function Kbd({ children }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ── Figure ───────────────────────────────────────────── */
export function EllipseFigure() {
  // x²/4 + y²/3 = 1, scale 56px/unit, origin (170,125); l: x = 0.5y + 1.
  return (
    <svg className="fig" viewBox="0 0 340 250" role="img" aria-label="椭圆 C、焦点 F1 F2 与过 F2 的直线 l 交 C 于 A、B">
      <line className="fig-axis" x1="20" y1="125" x2="324" y2="125" />
      <line className="fig-axis" x1="170" y1="240" x2="170" y2="10" />
      <path className="fig-axis" d="M318 121l6 4-6 4M166 16l4-6 4 6" />
      <ellipse className="fig-curve" cx="170" cy="125" rx="112" ry="97" />
      <polygon className="fig-area" points="114,125 256.7,63.6 177.6,221.8" />
      <line className="fig-line" x1="167.2" y1="242.6" x2="268" y2="41" />
      <line className="fig-dash" x1="226" y1="41" x2="226" y2="125" />
      {[
        [114, 125],
        [226, 125],
        [256.7, 63.6],
        [177.6, 221.8],
        [226, 41],
      ].map(([x, y]) => (
        <circle key={`${x},${y}`} className="fig-pt" cx={x} cy={y} r="3" />
      ))}
      <g className="fig-label">
        <text x="98" y="143">F₁</text>
        <text x="232" y="143">F₂</text>
        <text x="262" y="60">A</text>
        <text x="186" y="236">B</text>
        <text x="232" y="38">P</text>
        <text x="156" y="141">O</text>
        <text x="314" y="143">x</text>
        <text x="178" y="20">y</text>
        <text x="246" y="104" className="fig-l">l</text>
      </g>
    </svg>
  );
}

