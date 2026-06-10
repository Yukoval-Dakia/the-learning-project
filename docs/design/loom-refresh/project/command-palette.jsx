// Loom · ⌘K command palette — makes the topbar search real.
// Searches pages, knowledge nodes, 题库, 错题, 学习项; ↑↓/↵/esc + click.

const PALETTE_PAGES = [
  { id: "today",     label: "今日",   icon: "today" },
  { id: "practice",  label: "练习",   icon: "layers" },
  { id: "record",    label: "录入",   icon: "record" },
  { id: "inbox",     label: "收件箱", icon: "inbox" },
  { id: "mistakes",  label: "错题",   icon: "mistakes" },
  { id: "questions", label: "题库",   icon: "quiz" },
  { id: "items",     label: "学习项", icon: "items" },
  { id: "knowledge", label: "知识",   icon: "knowledge" },
];

function paletteIndex() {
  const D = window.DATA || {};
  const strip = (s) => String(s || "").replace(/\*\*/g, "");
  const rows = [];
  PALETTE_PAGES.forEach((p) => rows.push({ group: "页面", icon: p.icon, title: p.label, meta: "/" + p.id, route: p.id, hay: p.label + " " + p.id }));
  (D.knowledge || []).forEach((n) => rows.push({ group: "知识节点", icon: "knowledge", title: n.title, meta: n.tag, route: "knowledge/" + n.id, hay: n.title + " " + n.tag + " " + n.id }));
  (D.questions || []).forEach((q) => { const t = strip(q.stem); rows.push({ group: "题库", icon: "quiz", title: t, meta: q.id, route: "questions/" + q.id, hay: t + " " + q.id + " " + (q.knowledge || []).join(" ") }); });
  (D.mistakes || []).forEach((m) => rows.push({ group: "错题", icon: "mistakes", title: m.q, meta: m.state || "", route: "mistakes", hay: m.q + " " + (m.knowledge || []).map((k) => k.label + " " + k.tag).join(" ") }));
  (D.items || []).forEach((it) => { if (it.status !== "archived" && it.status !== "dismissed") rows.push({ group: "学习项", icon: "items", title: it.title, meta: it.kind, route: "items/" + it.id, hay: it.title + " " + it.id + " " + it.kind }); });
  return rows;
}

function CommandPalette({ open, onClose, go }) {
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);
  const index = React.useMemo(() => (open ? paletteIndex() : []), [open]);

  const results = React.useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      // rest state: pages + a few knowledge entry points
      return index.filter((r) => r.group === "页面").concat(index.filter((r) => r.group === "知识节点").slice(0, 4));
    }
    const terms = query.split(/\s+/);
    const PER_GROUP = 5;
    const seen = {};
    return index.filter((r) => {
      const hay = r.hay.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
      seen[r.group] = (seen[r.group] || 0) + 1;
      return seen[r.group] <= PER_GROUP;
    });
  }, [q, index]);

  React.useEffect(() => { setSel(0); }, [q, open]);
  React.useEffect(() => { if (open) { setQ(""); requestAnimationFrame(() => inputRef.current && inputRef.current.focus()); } }, [open]);

  // keep selection visible
  React.useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('[data-sel="1"]');
    if (el && listRef.current) {
      const t = el.offsetTop, b = t + el.offsetHeight, st = listRef.current.scrollTop, h = listRef.current.clientHeight;
      if (t < st) listRef.current.scrollTop = t - 8;
      else if (b > st + h) listRef.current.scrollTop = b - h + 8;
    }
  }, [sel, results]);

  const pick = (r) => { if (!r) return; onClose(); go(r.route); };

  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  if (!open) return null;
  let lastGroup = null;
  return (
    <div className="cmdk-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="搜索">
        <div className="cmdk-head">
          <Icon name="search" size={16} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="搜索卡片、节点、错题…" aria-label="搜索" />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">没有匹配「{q}」的结果。</div>}
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? <div className="cmdk-group" key={"g" + i}>{r.group}</div> : null;
            lastGroup = r.group;
            return (
              <React.Fragment key={i}>
                {head}
                <button className={"cmdk-row" + (i === sel ? " on" : "")} data-sel={i === sel ? "1" : "0"}
                  onMouseEnter={() => setSel(i)} onClick={() => pick(r)}>
                  <span className="cmdk-ic"><Icon name={r.icon} size={15} /></span>
                  <span className="cmdk-title">{r.title}</span>
                  {r.meta ? <span className="cmdk-meta mono">{r.meta}</span> : null}
                  <Icon name="arrow" size={13} className="cmdk-go" />
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="cmdk-foot mono">↑↓ 选择 · ↵ 打开 · esc 关闭</div>
      </div>
    </div>
  );
}

window.CommandPalette = CommandPalette;
