// Loom · shared primitives + hooks. Non-module Babel; exported to window.
const { useState, useEffect, useRef, useCallback } = React;

/* ---- count-up hook: animates a number when it scrolls into view ---- */
function useCountUp(target, { dur = 900, decimals = 0 } = {}) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const run = () => {
      if (done.current) return; done.current = true;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setVal(target); return; }
      const t0 = performance.now();
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        setVal(target * e);
        if (p < 1) requestAnimationFrame(tick); else setVal(target);
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((es) => es.forEach(e => e.isIntersecting && run()), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [target, dur]);
  const shown = decimals ? val.toFixed(decimals) : Math.round(val).toLocaleString();
  return [shown, ref];
}

function CountVal({ value, decimals = 0, unit }) {
  const [shown, ref] = useCountUp(value, { decimals });
  return <span ref={ref} className="tnum">{shown}{unit && <span className="unit">{unit}</span>}</span>;
}

function Badge({ tone = 'neutral', dot, pulse, children }) {
  return <span className={`badge tone-${tone}`}>{dot && <span className={`dot ${pulse ? 'pulse' : ''}`} />}{children}</span>;
}

function Glyph({ name, tone = '', lg }) {
  return <span className={`glyph ${tone ? 'glyph-' + tone : ''} ${lg ? 'glyph-lg' : ''}`}><Icon name={name} size={lg ? 24 : 20} /></span>;
}

function Bar({ pct, tone = 'coral' }) {
  return <div className="bar"><span style={{ width: pct + '%', background: `var(--${tone})` }} /></div>;
}

/* segmented progress (e.g. FSRS state mix) */
function SegBar({ segments }) {
  const total = segments.reduce((a, s) => a + s.v, 0) || 1;
  return (
    <div className="bar seg" style={{ height: 8 }}>
      {segments.map((s, i) => <span key={i} title={s.label} style={{ width: (s.v / total * 100) + '%', background: `var(--${s.tone})` }} />)}
    </div>
  );
}

function Ring({ pct, size = 64, stroke = 7, tone = 'coral', label, sub }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const ref = useRef(null); const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf; const io = new IntersectionObserver((es) => es.forEach(e => {
      if (e.isIntersecting) {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(pct); return; }
        const t0 = performance.now();
        const tick = (t) => { const p = Math.min(1, (t - t0) / 900); setShown(pct * (1 - Math.pow(1 - p, 3))); if (p < 1) raf = requestAnimationFrame(tick); };
        raf = requestAnimationFrame(tick);
      }
    }), { threshold: 0.5 });
    if (ref.current) io.observe(ref.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [pct]);
  return (
    <div ref={ref} style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--paper-tint)" strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={`var(--${tone})`} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - shown / 100)} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', lineHeight: 1 }}>
        <div>
          <div className="serif tnum" style={{ fontSize: size > 56 ? 18 : 15 }}>{Math.round(shown)}{label}</div>
          {sub && <div className="meta" style={{ fontSize: 10, marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ icon = 'sparkle', title, body, action, soon }) {
  return (
    <div className="empty">
      <Glyph name={icon} tone="coral" lg />
      <div className="empty-title serif">{title}</div>
      <div className="empty-body">{body}</div>
      {soon && <div className="soon"><Icon name="clock" size={13} /> {soon}</div>}
      {action}
    </div>
  );
}

function SectionHead({ title, link, onLink, children }) {
  return (
    <div className="section-head">
      <h2 className="section-title serif">{title}</h2>
      {children}
      {link && <button className="section-link" onClick={onLink}>{link} <Icon name="arrowRight" size={14} /></button>}
    </div>
  );
}

/* sparkline (decorative trend) */
function Spark({ data, w = 120, h = 36, tone = 'coral' }) {
  const max = Math.max(...data), min = Math.min(...data), rng = max - min || 1;
  const pts = data.map((v, i) => [i / (data.length - 1) * w, h - ((v - min) / rng) * (h - 6) - 3]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      <path d={area} fill={`var(--${tone})`} opacity="0.1" />
      <path d={d} fill="none" stroke={`var(--${tone})`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r="3" fill={`var(--${tone})`} />
    </svg>
  );
}

Object.assign(window, { useCountUp, CountVal, Badge, Glyph, Bar, SegBar, Ring, EmptyState, SectionHead, Spark });
