// Loom · icon set + brand mark + shared primitives.
// Non-module Babel file; exports to window.
const { useState, useEffect, useRef, useCallback } = React;

/* ----- Icon set: feather-style 24px stroke paths ----- */
const ICONS = {
  today:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  record:   '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  review:   '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  mistakes: '<path d="M10.3 4.3 2.7 18a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  items:    '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h10"/>',
  knowledge:'<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8 7.2 16 7.5M8 8 9 15.6M16 10l-6 6"/>',
  inbox:    '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>',
  copilot:  '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  teach:    '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M7 9v5c0 1 2.2 2.5 5 2.5s5-1.5 5-2.5V9"/><path d="M21 7v6"/>',
  search:   '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sun:      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:     '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  menu:     '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close:    '<path d="M18 6 6 18M6 6l12 12"/>',
  arrow:    '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowL:   '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  check:    '<path d="m4 12 5 5L20 6"/>',
  checkCircle:'<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5L16 9"/>',
  flame:    '<path d="M12 3c2 3 5 4.5 5 8a5 5 0 0 1-10 0c0-1.4.6-2.4 1.4-3.2C8.9 9 9 11 12 11c0-2.5-1-5 0-8Z"/>',
  send:     '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
  sparkle:  '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z"/>',
  link:     '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  doc:      '<path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-5Z"/><path d="M8 13h8M8 17h6"/>',
  mic:      '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  image:    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 19 5-5 3 3 2-2 4 4"/>',
  clip:     '<path d="M21 11.5 12 20.5a5.5 5.5 0 0 1-8-8l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.5 1.5 0 0 1-2-2l8.5-8.5"/>',
  tag:      '<path d="M3 8.5V4a1 1 0 0 1 1-1h4.5L21 15.5a2 2 0 0 1 0 3l-3 3a2 2 0 0 1-3 0L3 8.5Z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  filter:   '<path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z"/>',
  dots:     '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  graph:    '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="9" r="2"/><circle cx="9" cy="18" r="2"/><circle cx="17" cy="19" r="2"/><path d="M6.7 7 17 8.5M7 7.5l1.6 8.6M10.8 18l5-1"/>',
  tree:     '<path d="M12 4v4M12 8H6v3M12 8h6v3M6 11v3M18 11v3M12 8v9"/><circle cx="12" cy="4" r="1.6"/><circle cx="6" cy="15" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="18" cy="15" r="1.6"/>',
  pencil:   '<path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17v3Z"/><path d="M14 6l3 3"/>',
  trash:    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  reverse:  '<path d="M3 7h13a4 4 0 0 1 0 8H8"/><path d="m6 4-3 3 3 3"/>',
  bolt:     '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
  layers:   '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5M3 18l9 5 9-5"/>',
  book:     '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Z"/><path d="M4 19a2 2 0 0 1 2-2h13"/>',
  target:   '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  eye:      '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  refresh:  '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7-3.3M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7 3.3"/><path d="M21 4v5h-5M3 20v-5h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V20a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 13H4a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.6 1.6 0 0 0 19.4 9H20a2 2 0 1 1 0 4h-.6Z"/>',
  spark2:   '<path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3Z"/>',
  merge:    '<path d="M7 3v4a5 5 0 0 0 5 5h5"/><path d="M7 21v-4a5 5 0 0 1 5-5"/><path d="m15 8 4 4-4 4"/>',
  undo:     '<path d="M9 7 4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-1"/>',
  camera:   '<path d="M4 8a2 2 0 0 1 2-2h1l1.2-2h5.6L17 6h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"/><circle cx="12" cy="13" r="3.2"/>',
  alert:    '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  archive:  '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  lock:     '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  grip:     '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  slash:    '<path d="M9 20 15 4"/>',
  fx:       '<path d="M5 19c2 0 3-1 3.5-4L11 4M7 9h6M14 12l6 7M20 12l-6 7"/>',
  quiz:     '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.7-.9 1.4v.6"/><path d="M12 17h.01"/>',
  hash:     '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  list:     '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  history:  '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  download: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  panelLeft:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="M5.5 8h1.5M5.5 11h1.5"/>',
  panelRight:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="M17 8h1.5M17 11h1.5"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  minimize2: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  minus:    '<path d="M5 12h14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
};

function Icon({ name, size = 18, className = "", style }) {
  const d = ICONS[name] || "";
  return React.createElement("svg", {
    className: "ico " + className, width: size, height: size, viewBox: "0 0 24 24",
    fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round",
    strokeLinejoin: "round", style, dangerouslySetInnerHTML: { __html: d },
  });
}

function BrandMark({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-label="Loom">
      <rect x="10" y="10" width="44" height="44" rx="5" stroke="currentColor" strokeOpacity="0.32" />
      <path d="M10 22 C 22 22, 22 30, 32 30 S 42 22, 54 22" />
      <path d="M10 32 C 22 32, 22 40, 32 40 S 42 32, 54 32" strokeOpacity="0.72" />
      <path d="M10 42 C 22 42, 22 50, 32 50 S 42 42, 54 42" strokeOpacity="0.46" />
    </svg>
  );
}

/* ----- count-up hook ----- */
function useCountUp(target, { dur = 900, start = true, decimals = 0 } = {}) {
  const [val, setVal] = useState(start ? 0 : target);
  const raf = useRef(0);
  useEffect(() => {
    if (!start) { setVal(target); return; }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setVal(target); return; }
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setVal(target * e);
      if (p < 1) raf.current = requestAnimationFrame(tick);
      else setVal(target);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, start, dur]);
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/* ----- primitives ----- */
function Badge({ tone = "neutral", children, dot, pulse }) {
  return (
    <span className={"badge tone-" + tone}>
      {dot && <span className={"dot" + (pulse ? " pulse" : "")} />}
      {children}
    </span>
  );
}

function Btn({ variant = "secondary", size, icon, iconEnd, children, block, ...rest }) {
  const cls = ["btn", "btn-" + variant, size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "", block ? "btn-block" : ""].filter(Boolean).join(" ");
  return (
    <button className={cls} {...rest}>
      {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={size === "sm" ? 15 : 17} />}
    </button>
  );
}

function IconBtn({ icon, size = 18, ...rest }) {
  return <button className="icon-btn" {...rest}><Icon name={icon} size={size} /></button>;
}

function Card({ pad, padLg, hover, sunk, className = "", children, ...rest }) {
  const cls = ["card", pad && "card-pad", padLg && "card-pad-lg", hover && "card-hover", sunk && "card-sunk", className].filter(Boolean).join(" ");
  return <div className={cls} {...rest}>{children}</div>;
}

function SectionLabel({ children, count }) {
  return (
    <div className="section-label">
      <h2 className="serif">{children}</h2>
      <span className="rule" />
      {count != null && <span className="count">{count}</span>}
    </div>
  );
}

function EmptyState({ icon = "sparkle", title, text, future, action }) {
  return (
    <div className="empty">
      <div className="empty-ico"><Icon name={icon} size={24} /></div>
      <div className="empty-title serif">{title}</div>
      <div className="empty-text">{text}</div>
      {future && <span className="future-tag">{future}</span>}
      {action}
    </div>
  );
}

function Ring({ percent = 0, animate = true }) {
  const p = useCountUp(percent, { start: animate, dur: 1100 });
  return (
    <div className="ring" style={{ "--p": p }}>
      <span className="ring-val serif tnum">{Math.round(p)}%</span>
    </div>
  );
}

// loading skeleton block
function SkLines({ rows = 3 }) {
  return (
    <div className="sk-stack">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="sk-line">
          <div className="sk" style={{ width: 38, height: 38, borderRadius: "var(--r-2)", flex: "none" }} />
          <div style={{ flex: 1 }}>
            <div className="sk" style={{ width: (60 - i * 8) + "%", height: 13, marginBottom: 8 }} />
            <div className="sk" style={{ width: (80 - i * 6) + "%", height: 11 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// error block with retry
function ErrorState({ text = "加载失败。", onRetry, compact }) {
  return (
    <div className={"errorstate" + (compact ? " compact" : "")} role="alert">
      <span className="errorstate-ic"><Icon name="alert" size={compact ? 16 : 20} /></span>
      <span className="errorstate-text">{text}</span>
      <Btn size="sm" variant="secondary" icon="refresh" onClick={onRetry}>重试</Btn>
    </div>
  );
}

// state switch: loading / empty / error / ok(children)
function Stateful({ state = "ok", skeleton, empty, errorText, onRetry, children }) {
  if (state === "loading") return skeleton || <SkLines />;
  if (state === "error") return <ErrorState text={errorText} onRetry={onRetry} />;
  if (state === "empty") return empty || null;
  return children;
}

// reusable drawer focus management — trap + restore + Esc
function useFocusTrap(open, onClose, panelRef) {
  const restoreRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const sel = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';
    const first = panel && panel.querySelector(sel);
    if (first) first.focus();
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !panel) return;
      const nodes = [...panel.querySelectorAll(sel)].filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const f = nodes[0], l = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === f) { e.preventDefault(); l.focus(); }
      else if (!e.shiftKey && document.activeElement === l) { e.preventDefault(); f.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (restoreRef.current && restoreRef.current.focus) restoreRef.current.focus(); };
  }, [open, onClose]);
}

Object.assign(window, { Icon, BrandMark, useCountUp, useFocusTrap, Badge, Btn, IconBtn, Card, SectionLabel, EmptyState, Ring, SkLines, ErrorState, Stateful, ICONS });
