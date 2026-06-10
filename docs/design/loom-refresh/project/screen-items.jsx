// Loom · Learning items (F, round-2b) — intent→decompose, status tabs, cards.

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return <span className={"badge status-badge tone-" + m.tone}><span className="status-glyph" aria-hidden="true">{m.glyph}</span>{m.label}</span>;
}

// intent → AI decomposition
function IntentDecompose({ onAccept }) {
  const [topic, setTopic] = React.useState("");
  const [stage, setStage] = React.useState("idle"); // idle | thinking | proposed | accepted
  const prop = DATA.intentProposal;
  const [keep, setKeep] = React.useState(prop.atomic.map(() => true));
  const run = () => { setStage("thinking"); setTimeout(() => setStage("proposed"), 1400); };

  return (
    <Card pad className="intent-card">
      <div className="card-head">
        <span className="card-icon accent"><Icon name="sparkle" size={18} /></span>
        <div className="card-title">新意图 → AI 拆解</div>
        <span className="meta" style={{ marginLeft: "auto" }}>learning_item · propose</span>
      </div>

      {stage === "idle" && (
        <div className="intent-input">
          <input className="field-input" placeholder="输入一个学习意图，如「通假字系统」…" value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
          <Btn variant="primary" icon="sparkle" onClick={run}>拆解</Btn>
        </div>
      )}
      {stage === "thinking" && (<div><div className="vision-status nowrap-meta"><Icon name="refresh" size={14} className="spin" />AI 拆解中…</div><SkLines rows={3} /></div>)}
      {(stage === "proposed" || stage === "accepted") && (
        <div className="decomp fade-key">
          <div className="decomp-hub">
            <span className="badge tone-coral"><Icon name="items" size={12} />hub</span>
            <div><div className="item-title">{prop.hub.title}</div><div className="item-sub wenyan">{prop.hub.sub}</div></div>
            <span className="meta mono" style={{ marginLeft: "auto" }}>{Math.round(prop.confidence * 100)}% · {prop.cost}</span>
          </div>
          <div className="decomp-atomics">
            {prop.atomic.map((a, i) => (
              <label key={i} className={"decomp-atomic" + (keep[i] ? "" : " off")}>
                <input type="checkbox" checked={keep[i]} onChange={() => setKeep((k) => k.map((v, j) => j === i ? !v : v))} />
                <span className="badge tone-info">atomic</span>
                <div><div className="item-title">{a.title}</div><div className="item-sub wenyan">{a.sub}</div></div>
              </label>
            ))}
          </div>
          {stage === "accepted" ? (
            <div className="nowrap-meta" style={{ justifyContent: "center" }}><Badge tone="good" dot><Icon name="check" size={12} />已接受 · 已创建 {keep.filter(Boolean).length + 1} 个学习项</Badge></div>
          ) : (
            <div className="hero-cta">
              <Btn variant="primary" icon="check" onClick={() => { setStage("accepted"); onAccept && onAccept(); }}>接受拆解（hub + {keep.filter(Boolean).length} atomic）</Btn>
              <Btn variant="ghost" icon="close" onClick={() => setStage("idle")}>忽略</Btn>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ItemCard({ it, go, onTransition }) {
  const pct = Math.round(it.mastered / it.cards * 100);
  const next = { pending: ["in_progress", "开始", "review"], in_progress: ["resting", "搁置", "clock"], resting: ["in_progress", "继续", "review"], done: ["archived", "归档", "archive"], dismissed: ["pending", "恢复", "undo"], archived: ["pending", "取出", "undo"] }[it.status];
  return (
    <Card pad hover className="item-card">
      <div className="item-head">
        <span className={"item-ic " + it.color}><Icon name={it.icon} size={22} /></span>
        <div style={{ flex: 1, minWidth: 0 }} onClick={() => go("items/" + it.id)} role="button">
          <div className="item-title" style={{ cursor: "pointer" }}>{it.title}</div>
          <div className="item-sub wenyan">{it.sub}</div>
        </div>
        <Ring percent={pct} />
      </div>
      <div className="item-tags nowrap-meta">
        <span className={"badge tone-" + (it.kind === "hub" ? "coral" : "neutral")}>{it.kind}</span>
        <StatusBadge status={it.status} />
        {it.children.length > 0 && <span className="meta mono">{it.children.length} 子项</span>}
      </div>
      <div className="bar"><span style={{ width: pct + "%" }} /></div>
      <div className="item-stats">
        <div className="item-stat"><span className="s-n serif tnum">{it.cards}</span> <span className="s-l">卡片</span></div>
        <div className="item-stat"><span className="s-n serif tnum">{it.mastered}</span> <span className="s-l">已掌握</span></div>
        <div className="item-foot-acts">
          {next && <Btn size="sm" variant="ghost" icon={next[2]} onClick={() => onTransition(it.id, next[0])}>{next[1]}</Btn>}
          <Btn size="sm" variant="secondary" iconEnd="arrow" onClick={() => go("items/" + it.id)}>打开</Btn>
        </div>
      </div>
    </Card>
  );
}

function ScreenItems({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [tab, setTab] = React.useState("全部");
  const [items, setItems] = React.useState(DATA.items);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const transition = (id, status) => setItems((xs) => xs.map((x) => x.id === id ? { ...x, status } : x));
  // archived never appears in the main list; surfaced only in the collapsible archive section
  const live = items.filter((i) => i.status !== "archived");
  const archived = items.filter((i) => i.status === "archived");
  const filtered = tab === "全部" ? live : live.filter((i) => i.status === tab);
  const tabs = ["全部", ...ITEM_STATUSES.filter((s) => s !== "archived")];

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">ITEMS · learning_item · {live.length} 活跃 · {archived.length} 归档</div>
        <div className="page-head-row">
          <h1 className="page-title serif">学习项</h1>
          <div className="hero-cta"><Btn variant="ghost" icon="history" onClick={() => go("learning-sessions")}>会话历史</Btn></div>
        </div>
        <p className="page-lead">把学习意图交给 AI 拆成 hub + atomic 子项，按状态推进。归档项不在主列表显示。</p>
      </div>

      <IntentDecompose onAccept={() => {}} />

      <SectionLabel>学习项</SectionLabel>
      <div className="status-tabs" role="tablist">
        {tabs.map((t) => {
          const n = t === "全部" ? live.length : live.filter((i) => i.status === t).length;
          const m = STATUS_META[t];
          return (
            <button key={t} role="tab" aria-selected={tab === t} className={"status-tab" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>
              {m && <span className="status-glyph" aria-hidden="true">{m.glyph}</span>}
              {m ? m.label : t}<span className="mono status-tab-n">{n}</span>
            </button>
          );
        })}
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="学习项加载失败。"
        skeleton={<div className="items-grid">{[1,2].map((i) => <Card key={i} pad><SkLines rows={2} /></Card>)}</div>}
        empty={<EmptyState icon="items" title="还没有学习项" text="在上方输入一个学习意图，让 AI 拆解成可执行的子项。" />}>
        {filtered.length === 0 ? (
          <EmptyState icon="items" title={`没有「${STATUS_META[tab] ? STATUS_META[tab].label : tab}」的学习项`} text="切换其它状态，或新建一个学习意图。" />
        ) : (
          <div className="items-grid stagger">{filtered.map((it) => <ItemCard key={it.id} it={it} go={go} onTransition={transition} />)}</div>
        )}
      </Stateful>

      {/* archived — collapsed by default, explicit open, with 取出归档 */}
      {archived.length > 0 && (
        <div className="archive-zone">
          <button className="archive-toggle" aria-expanded={archiveOpen} onClick={() => setArchiveOpen((o) => !o)}>
            <Icon name="archive" size={15} />
            <span>归档项</span>
            <span className="mono archive-n">{archived.length}</span>
            <Icon name="arrow" size={14} className="archive-caret" style={{ transform: archiveOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
          </button>
          {archiveOpen && (
            <div className="archive-list fade-key">
              {archived.map((it) => (
                <div key={it.id} className="archive-row">
                  <span className="item-ic info" style={{ width: 34, height: 34 }}><Icon name={it.icon} size={16} /></span>
                  <div className="archive-main" onClick={() => go("items/" + it.id)} role="button">
                    <div className="archive-title">{it.title}</div>
                    <div className="item-sub wenyan">{it.sub}</div>
                  </div>
                  <span className="meta mono">{it.cards} 卡 · {it.kind}</span>
                  <Btn size="sm" variant="secondary" icon="undo" onClick={() => transition(it.id, "pending")}>取出归档</Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
window.ScreenItems = ScreenItems;
