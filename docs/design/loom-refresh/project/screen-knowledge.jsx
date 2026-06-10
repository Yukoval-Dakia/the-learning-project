// Loom · Knowledge (D, round-2b) — tree↔graph, per-node mastery,
// interactive pan/zoom mesh w/ 5 typed edges, node-detail drawer.

// decay → non-color cue (icon + label)
const DECAY_META = {
  stable:   { label: "稳定", icon: "check" },
  slow:     { label: "缓降", icon: "history" },
  decaying: { label: "衰减中", icon: "alert" },
};

function MasteryRing({ pct, size = 34 }) {
  const tone = pct >= 67 ? "good" : pct >= 45 ? "hard" : "again";
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mastery-ring" aria-label={"掌握度 " + pct + "%"}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--line)" strokeWidth="3" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={`var(--${tone})`} strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct/100)} transform={`rotate(-90 ${size/2} ${size/2})`} style={{ transition: "stroke-dashoffset 1s var(--ease-out)" }} />
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" className="mastery-ring-t mono">{pct}</text>
    </svg>
  );
}

// ── interactive pan/zoom mesh ───────────────────────────────────────────
function MeshGraph({ onPick, active }) {
  const nodes = DATA.knowledge;
  const edges = DATA.knowledgeEdges;
  // deterministic radial-ish layout by depth
  const pos = React.useMemo(() => {
    const byDepth = {}; nodes.forEach((n) => { (byDepth[n.depth] = byDepth[n.depth] || []).push(n); });
    const P = {};
    Object.keys(byDepth).forEach((d) => {
      const row = byDepth[d]; const y = 90 + (+d) * 115;
      row.forEach((n, i) => { P[n.id] = { x: 130 + i * (760 / Math.max(1, row.length)) + (+d % 2) * 60, y }; });
    });
    return P;
  }, [nodes]);

  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const drag = React.useRef(null);
  const onDown = (e) => { drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }; };
  const onMove = (e) => { if (!drag.current) return; setView((v) => ({ ...v, x: drag.current.x + (e.clientX - drag.current.px), y: drag.current.y + (e.clientY - drag.current.py) })); };
  const onUp = () => { drag.current = null; };
  const zoom = (d) => setView((v) => ({ ...v, k: Math.min(2, Math.max(0.5, +(v.k + d).toFixed(2))) }));
  const onWheel = (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? -0.1 : 0.1); };

  const edge = (ed, i) => {
    const A = pos[ed.a], B = pos[ed.b]; if (!A || !B) return null;
    const cue = REL_CUE[ed.rel];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    return (
      <g key={i} className="mesh-edge-g">
        <path d={`M${A.x} ${A.y} L${B.x} ${B.y}`} className={"mesh-edge2 rel-" + ed.rel}
          strokeDasharray={cue.dash === "0" ? undefined : cue.dash} markerEnd={cue.arrow ? "url(#arrow)" : undefined} />
        <text x={mx} y={my - 4} className="mesh-edge-label mono">{cue.glyph} {cue.label}</text>
      </g>
    );
  };

  return (
    <div className="mesh-wrap">
      <div className="mesh-controls">
        <button className="mesh-zoom-btn" title="缩小" onClick={() => zoom(-0.1)}><Icon name="minus" size={15} /></button>
        <span className="mono mesh-zoom">{Math.round(view.k * 100)}%</span>
        <button className="mesh-zoom-btn" title="放大" onClick={() => zoom(0.1)}><Icon name="plus" size={15} /></button>
        <span className="mesh-ctrl-div" />
        <button className="mesh-zoom-btn" title="复位" onClick={() => setView({ x: 0, y: 0, k: 1 })}><Icon name="refresh" size={15} /></button>
      </div>
      <div className="mesh-stage2" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
        <svg width="100%" height="100%" viewBox="0 0 1000 560" className="mesh-svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-4)" />
            </marker>
            <filter id="nodeShadow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(60,50,30,0.18)" />
            </filter>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map(edge)}
            {nodes.map((n, i) => {
              const p = pos[n.id]; if (!p) return null;
              const tone = n.mastery >= 67 ? "good" : n.mastery >= 45 ? "hard" : "again";
              const r = n.kind === "hub" ? 24 : 18;
              const circ = 2 * Math.PI * r;
              return (
                <g key={n.id} transform={`translate(${p.x} ${p.y})`} className={"mesh-node2 lvl" + n.depth + " tone-" + tone}
                  tabIndex={0} role="button" aria-label={n.title + " 掌握度 " + n.mastery + "%"}
                  onClick={() => onPick(n)} onKeyDown={(e) => e.key === "Enter" && onPick(n)}
                  style={{ animationDelay: i * 50 + "ms" }}>
                  {/* filled disc with shadow for separation from the paper grid */}
                  <circle r={r} className={"mesh-disc tone-" + tone} filter="url(#nodeShadow)" />
                  {/* full track ring */}
                  <circle r={r} fill="none" className="mesh-track" />
                  {/* mastery arc on top */}
                  <circle r={r} fill="none" className="mesh-arc"
                    stroke={`var(--${tone})`} strokeWidth="3.5" strokeLinecap="round"
                    strokeDasharray={circ} strokeDashoffset={circ * (1 - n.mastery/100)}
                    transform="rotate(-90)" />
                  <text y="4" textAnchor="middle" className="mesh-node-pct mono">{n.mastery}</text>
                  <text y={r + 18} textAnchor="middle" className="mesh-node-label wenyan">{n.title}</text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="mesh-legend">
        {Object.keys(REL_CUE).map((r) => (
          <span key={r} className="rel-legend">
            <svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" className={"rel-" + r} strokeDasharray={REL_CUE[r].dash === "0" ? undefined : REL_CUE[r].dash} markerEnd={REL_CUE[r].arrow ? "url(#arrow)" : undefined} /></svg>
            <span className="mono">{REL_CUE[r].glyph} {REL_CUE[r].label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── node detail drawer ──────────────────────────────────────────────────
function EdgeCreateForm({ node }) {
  const [rel, setRel] = React.useState("related_to");
  const [target, setTarget] = React.useState("");
  const [dir, setDir] = React.useState(true);
  const others = DATA.knowledge.filter((n) => n.id !== node.id);
  const directional = REL_CUE[rel].arrow;
  return (
    <div className="edge-form">
      <div className="field-label">新建关系边</div>
      <div className="chip-set" style={{ marginBottom: "var(--s-3)" }}>
        {Object.keys(REL_CUE).map((r) => (
          <button key={r} className={"chip" + (rel === r ? " is-on" : "")} onClick={() => setRel(r)}>
            <span className="mono">{REL_CUE[r].glyph}</span> {REL_CUE[r].label}
          </button>
        ))}
      </div>
      <select className="field-input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="目标节点">
        <option value="">选择目标节点…</option>
        {others.map((n) => <option key={n.id} value={n.id}>{n.title} ({n.tag})</option>)}
      </select>
      {directional && (
        <div className="dir-row">
          <span className="meta">方向</span>
          <button className="chip is-on" onClick={() => setDir((d) => !d)}>
            <span className="wenyan">{dir ? node.title : (others.find((n) => n.id === target)?.title || "目标")}</span>
            <Icon name="arrow" size={12} />
            <span className="wenyan">{dir ? (others.find((n) => n.id === target)?.title || "目标") : node.title}</span>
          </button>
          <IconBtn icon="reverse" size={13} title="反向" onClick={() => setDir((d) => !d)} />
        </div>
      )}
      <Btn variant="primary" size="sm" icon="plus" block disabled={!target} style={{ marginTop: "var(--s-3)" }}>建立 {REL_CUE[rel].label} 边</Btn>
    </div>
  );
}

function NodeDrawer({ node, open, onClose, go }) {
  const panelRef = React.useRef(null);
  useFocusTrap(open, onClose, panelRef);
  if (!node) return null;
  const parent = DATA.knowledge.find((n) => n.id === node.parent);
  const children = DATA.knowledge.filter((n) => n.parent === node.id);
  const rels = DATA.knowledgeEdges.filter((e) => e.a === node.id || e.b === node.id);
  const props = DATA.knowledgeEdgeProposals.filter((e) => e.a === node.id || e.b === node.id);
  const other = (e) => DATA.knowledge.find((n) => n.id === (e.a === node.id ? e.b : e.a));

  return (
    <>
      <div className={"scrim" + (open ? " open" : "")} onClick={onClose} />
      <aside ref={panelRef} className={"drawer" + (open ? " open" : "")} role="dialog" aria-modal={open} aria-label={node.title} aria-hidden={!open}>
        <div className="drawer-head">
          <MasteryRing pct={node.mastery} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title serif">{node.title}</div>
            <div className="meta mono">{node.tag} · {node.kind}</div>
          </div>
          <IconBtn icon="close" size={16} onClick={onClose} aria-label="关闭" />
        </div>

        <div className="drawer-body">
          <div className="node-metrics">
            <div className="nm"><div className="nm-n serif">{node.mastery}%</div><div className="nm-l meta">掌握度</div></div>
            <div className="nm"><div className="nm-n serif">{node.evidence}</div><div className="nm-l meta">evidence</div></div>
            <div className="nm"><div className="nm-n"><Badge tone={node.decay === "decaying" ? "again" : node.decay === "slow" ? "hard" : "good"}><Icon name={DECAY_META[node.decay].icon} size={12} />{DECAY_META[node.decay].label}</Badge></div><div className="nm-l meta">decay</div></div>
          </div>

          {/* hierarchy block — visually separate from typed relations */}
          <div className="drawer-sec">
            <div className="drawer-sec-h"><Icon name="tree" size={14} />层级 hierarchy</div>
            {parent ? (
              <button className="rel-row" onClick={() => go("knowledge/" + parent.id)}>
                <span className="rel-kind mono">parent</span><span className="wenyan">{parent.title}</span><Icon name="arrow" size={13} />
              </button>
            ) : <div className="quiet-empty">根节点（无父）</div>}
            {children.map((c) => (
              <button key={c.id} className="rel-row indent" onClick={() => go("knowledge/" + c.id)}>
                <span className="rel-kind mono">child</span><span className="wenyan">{c.title}</span><MasteryRing pct={c.mastery} size={24} />
              </button>
            ))}
          </div>

          {/* typed relations block */}
          <div className="drawer-sec">
            <div className="drawer-sec-h"><Icon name="link" size={14} />关系 typed edges</div>
            {rels.length === 0 && <div className="quiet-empty">暂无 typed 关系。</div>}
            {rels.map((e, i) => {
              const o = other(e), cue = REL_CUE[e.rel];
              return (
                <button key={i} className="rel-row" onClick={() => go("knowledge/" + o.id)}>
                  <span className={"rel-tag rel-tag-" + e.rel}><span className="mono">{cue.glyph}</span>{cue.label}</span>
                  <span className="wenyan">{o.title}</span><Icon name="arrow" size={13} />
                </button>
              );
            })}
          </div>

          {/* AI edge proposals — accept / reverse / change-type / dismiss */}
          {props.length > 0 && (
            <div className="drawer-sec">
              <div className="drawer-sec-h"><Icon name="sparkle" size={14} />AI 提议的边 · {props.length}</div>
              {props.map((e) => <EdgeProposalRow key={e.id} e={e} node={node} other={other(e)} />)}
            </div>
          )}

          <div className="drawer-sec"><EdgeCreateForm node={node} /></div>
        </div>

        <div className="drawer-foot">
          <Btn variant="primary" block iconEnd="arrow" onClick={() => go("knowledge/" + node.id)}>打开节点详情页</Btn>
        </div>
      </aside>
    </>
  );
}

function EdgeProposalRow({ e, node, other }) {
  const [done, setDone] = React.useState(null);
  const [dir, setDir] = React.useState(e.dir);
  const cue = REL_CUE[e.rel];
  if (done) return <div className="edge-prop resolved"><span className="badge tone-good"><Icon name="check" size={12} />{done}</span><span className="wenyan">{other.title}</span></div>;
  return (
    <div className="edge-prop">
      <div className="edge-prop-head">
        <span className={"rel-tag rel-tag-" + e.rel}><span className="mono">{cue.glyph}</span>{cue.label}</span>
        <span className="wenyan">{dir ? node.title : other.title} → {dir ? other.title : node.title}</span>
        <span className="meta mono" style={{ marginLeft: "auto" }}>{Math.round(e.confidence * 100)}%</span>
      </div>
      <div className="edge-prop-acts">
        <Btn size="sm" variant="good" icon="check" onClick={() => setDone("接受")}>接受</Btn>
        <Btn size="sm" variant="ghost" icon="reverse" onClick={() => setDir((d) => !d)}>反向</Btn>
        <Btn size="sm" variant="ghost" icon="refresh" onClick={() => setDone("已改类型")}>改类型</Btn>
        <Btn size="sm" variant="ghost" icon="close" onClick={() => setDone("已忽略")}>忽略</Btn>
      </div>
    </div>
  );
}

function ScreenKnowledge({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [view, setView] = React.useState("tree");
  const [picked, setPicked] = React.useState(null);

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">KNOWLEDGE · {DATA.knowledge.length} nodes · {DATA.knowledgeEdges.length} edges (mesh)</div>
        <div className="page-head-row">
          <h1 className="page-title serif">知识</h1>
          <div className="hero-cta">
            <div className="seg">
              <button className={view === "tree" ? "on" : ""} onClick={() => setView("tree")}><Icon name="tree" size={15} />树</button>
              <button className={view === "graph" ? "on" : ""} onClick={() => setView("graph")}><Icon name="graph" size={15} />图谱</button>
            </div>
            <Btn variant="primary" icon="plus">新建节点</Btn>
          </div>
        </div>
        <p className="page-lead">树是骨架（parent/child），mesh 是 5 类 typed 关系。点节点看详情抽屉；图可平移缩放。</p>
      </div>

      <Card pad sunk style={{ marginBottom: "var(--s-5)", display: "flex", alignItems: "center", gap: "var(--s-4)", flexWrap: "wrap", borderColor: "var(--coral-line)" }}>
        <span className="card-icon accent"><Icon name="link" size={18} /></span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 500 }}>AI 提议了 {DATA.knowledgeEdgeProposals.length} 条新关系</div>
          <div className="meta">来自昨晚 Dreaming + Maintenance · 选中节点后在抽屉内 accept / reverse / change-type / dismiss</div>
        </div>
        <Btn variant="secondary" size="sm" iconEnd="arrow" onClick={() => go("inbox")}>集中审批</Btn>
      </Card>

      <Stateful state={ds} onRetry={() => {}} errorText="知识图加载失败。"
        skeleton={<Card pad><SkLines rows={4} /></Card>}
        empty={<EmptyState icon="knowledge" title="知识网为空" text="录入材料后，AI 会从中抽取节点并提议关系。" />}>
        {view === "tree" ? (
          <Card>
            {DATA.knowledge.map((n) => (
              <button key={n.id} className={"know-node" + (n.decay === "decaying" ? " hot" : "")} style={{ paddingLeft: `calc(var(--s-5) + ${n.depth * 22}px)`, width: "100%", textAlign: "left", border: 0, background: "transparent" }} onClick={() => setPicked(n)}>
                {n.depth > 0 && <span className="know-twig">└</span>}
                <MasteryRing pct={n.mastery} size={30} />
                <span className="know-title wenyan">{n.title}</span>
                <span className="chip chip-k mono">{n.tag}</span>
                <Badge tone={n.decay === "decaying" ? "again" : n.decay === "slow" ? "hard" : "good"}><Icon name={DECAY_META[n.decay].icon} size={11} />{DECAY_META[n.decay].label}</Badge>
                <div className="know-end">
                  <span className="meta mono">{n.evidence} ev</span>
                  {n.mistakes > 0 && <Badge tone="again">{n.mistakes} 错</Badge>}
                  {n.mesh > 0 && <Badge tone="info"><Icon name="link" size={11} />{n.mesh}</Badge>}
                  <Icon name="arrow" size={15} className="thread-arrow" />
                </div>
              </button>
            ))}
          </Card>
        ) : (
          <MeshGraph onPick={setPicked} />
        )}
      </Stateful>

      <NodeDrawer node={picked} open={!!picked} onClose={() => setPicked(null)} go={go} />
    </div>
  );
}
window.ScreenKnowledge = ScreenKnowledge;
