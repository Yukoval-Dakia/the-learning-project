// Loom · /copilot — 全屏 Copilot 工作台：左侧多会话管理 + 会话视图 + composer.

function CopSessionItem({ s, active, onOpen, onPin, onRename, onDelete }) {
  const [menu, setMenu] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState(s.title);
  const mref = React.useRef(null);
  React.useEffect(() => {
    if (!menu) return;
    const h = (e) => { if (mref.current && !mref.current.contains(e.target)) setMenu(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, [menu]);
  const commit = () => { const t = val.trim(); if (t) onRename(t); setEditing(false); };
  const model = COP_MODELS.find((m) => m.id === s.model) || COP_MODELS[0];

  return (
    <div className={"cop-sess" + (active ? " on" : "")} onClick={() => !editing && onOpen()}>
      <div className="cop-sess-top">
        {s.pinned && <Icon name="bolt" size={12} className="cop-pin-ic" />}
        {editing ? (
          <input className="cop-sess-rename" autoFocus value={val} onChange={(e) => setVal(e.target.value)}
            onClick={(e) => e.stopPropagation()} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }} />
        ) : (
          <span className="cop-sess-title">{s.title}</span>
        )}
        <button className="cop-sess-kebab" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }} aria-label="会话操作"><Icon name="dots" size={15} /></button>
        {menu && (
          <div className="cop-menu" ref={mref} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { onPin(); setMenu(false); }}><Icon name="bolt" size={14} />{s.pinned ? "取消置顶" : "置顶"}</button>
            <button onClick={() => { setEditing(true); setMenu(false); }}><Icon name="pencil" size={14} />重命名</button>
            <button className="danger" onClick={() => { onDelete(); setMenu(false); }}><Icon name="trash" size={14} />删除会话</button>
          </div>
        )}
      </div>
      <div className="cop-sess-prev">{s.preview}</div>
      <div className="cop-sess-meta">
        <span className={"cop-modeltag tone-" + model.tone}>{model.name}</span>
        <span className="cop-sess-cost mono">${s.cost.toFixed(s.cost < 0.01 ? 3 : 2)}</span>
        <span className="cop-sess-time">{s.time}</span>
      </div>
    </div>
  );
}

function CopMsg({ m }) {
  if (m.role === "user") {
    return (
      <div className="cop-msg user">
        <div className="cop-bubble">{m.text}</div>
        <div className="cop-ava user">{DATA.user.initial}</div>
      </div>
    );
  }
  return (
    <div className="cop-msg ai">
      <div className="cop-ava ai"><Icon name="sparkle" size={15} /></div>
      <div className="cop-msg-body">
        <div className="cop-msg-name">Loom Copilot</div>
        {m.tool && <div className="cop-tool-wrap"><CopilotToolCard spec={m.tool} /></div>}
        {m.text && <div className="cop-text">{m.text}</div>}
      </div>
    </div>
  );
}

const COP_SUGGEST = ["今天该复习哪些？", "解释「之」的主谓取独", "把这套卷子录进题库", "生成 2 张判断句变体"];

function ScreenCopilot({ go }) {
  const [sessions, setSessions] = React.useState(() => copSessions().map((s) => ({ ...s, messages: [...s.messages] })));
  const [activeId, setActiveId] = React.useState(sessions[0].id);
  const [query, setQuery] = React.useState("");
  const [val, setVal] = React.useState("");
  const [model, setModel] = React.useState("sonnet");
  const [typing, setTyping] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [topH, setTopH] = React.useState(59);
  const threadRef = React.useRef(null);

  React.useEffect(() => { const tb = document.querySelector(".topbar"); if (tb) setTopH(Math.round(tb.getBoundingClientRect().height)); }, []);
  const active = sessions.find((s) => s.id === activeId) || sessions[0];
  React.useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [activeId, active.messages.length, typing]);

  const patch = (id, fn) => setSessions((xs) => xs.map((s) => s.id === id ? fn(s) : s));
  const newSession = () => {
    const id = "s_new_" + Date.now();
    setSessions((xs) => [{ id, title: "新对话", group: "today", time: "刚刚", model, cost: 0, msgN: 0, pinned: false, preview: "开始一段新的对话…", messages: [] }, ...xs]);
    setActiveId(id);
  };
  const send = (text) => {
    const t = (text || val).trim(); if (!t) return;
    patch(activeId, (s) => ({ ...s, messages: [...s.messages, { role: "user", text: t }], msgN: s.msgN + 1, preview: t, time: "刚刚" }));
    setVal(""); setTyping(true);
    setTimeout(() => {
      setTyping(false);
      patch(activeId, (s) => ({ ...s, cost: +(s.cost + (model === "sonnet" ? 0.18 : 0.005)).toFixed(3), msgN: s.msgN + 1, messages: [...s.messages, {
        role: "ai", text: "已检索相关知识节点并整理要点。要不要把它排进今天的复习队列？",
        tool: {
          fn: "search_knowledge", icon: "search", status: "done", replayable: true,
          args: { query: t.slice(0, 14), scope: "tree+mesh", k: 5 },
          meta: { model: model === "sonnet" ? "Sonnet" : "Haiku", cost: model === "sonnet" ? 0.18 : 0.005, latency: "420ms", conf: 0.87, caused: "e_45" + (s.msgN + 10) },
          result: (<div><p className="result-lead">命中 <b>2</b> 个知识节点</p><div className="r-list"><CopNodeRow icon="knowledge" label="相关节点" meta="k_xuci · tree" score="0.9" /></div></div>),
        },
      }] }));
    }, 1400);
  };

  // filter + group + pin-sort
  const shown = sessions.filter((s) => !query.trim() || (s.title + s.preview).toLowerCase().includes(query.toLowerCase()));
  const totalCost = sessions.reduce((a, s) => a + s.cost, 0);
  const modelMeta = COP_MODELS.find((m) => m.id === active.model) || COP_MODELS[0];

  return (
    <div className={"cop" + (panelOpen ? " panel-open" : "")} style={{ height: "calc(100vh - " + topH + "px)" }}>
      {panelOpen && <div className="cop-scrim" onClick={() => setPanelOpen(false)} />}
      {/* ── sessions panel ── */}
      <aside className="cop-sessions">
        <div className="cop-sessions-head">
          <div className="cop-sessions-title"><Icon name="copilot" size={16} />会话<span className="cop-sess-count mono">{sessions.length}</span></div>
          <Btn size="sm" variant="primary" icon="plus" onClick={newSession}>新对话</Btn>
        </div>
        <label className="cop-search">
          <Icon name="search" size={15} />
          <input placeholder="搜索会话…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="qb-search-clear" onClick={() => setQuery("")} aria-label="清除"><Icon name="close" size={13} /></button>}
        </label>
        <div className="cop-sess-list">
          {COP_GROUPS.map(([g, label]) => {
            const items = shown.filter((s) => s.group === g).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
            if (!items.length) return null;
            return (
              <div className="cop-group" key={g}>
                <div className="cop-group-l">{label}<span className="mono">{items.length}</span></div>
                {items.map((s) => (
                  <CopSessionItem key={s.id} s={s} active={s.id === activeId}
                    onOpen={() => { setActiveId(s.id); setPanelOpen(false); }}
                    onPin={() => patch(s.id, (x) => ({ ...x, pinned: !x.pinned }))}
                    onRename={(t) => patch(s.id, (x) => ({ ...x, title: t }))}
                    onDelete={() => setSessions((xs) => { const next = xs.filter((x) => x.id !== s.id); if (s.id === activeId && next[0]) setActiveId(next[0].id); return next; })} />
                ))}
              </div>
            );
          })}
          {shown.length === 0 && <div className="cop-noresult meta">没有匹配的会话</div>}
        </div>
        <div className="cop-cost-ribbon">
          <span className="meta">本月 Copilot 花费</span>
          <span className="cop-cost-big mono">${totalCost.toFixed(2)}</span>
        </div>
      </aside>

      {/* ── conversation ── */}
      <section className="cop-main">
        <header className="cop-conv-head">
          <div className="cop-conv-titlewrap">
            <button className="cop-panel-toggle" onClick={() => setPanelOpen((o) => !o)} aria-label="会话列表"><Icon name="list" size={18} /></button>
            <div className="cop-conv-titlestack">
              <input className="cop-conv-title" value={active.title} onChange={(e) => patch(active.id, (s) => ({ ...s, title: e.target.value }))} aria-label="会话标题" />
              <div className="cop-conv-sub mono">session={active.id} · {active.msgN} 条 · <span className={"cop-modeltag tone-" + modelMeta.tone}>{modelMeta.name}</span> · 累计 ${active.cost.toFixed(active.cost < 0.01 ? 3 : 2)}</div>
            </div>
          </div>
          <div className="cop-conv-acts">
            <Badge tone="good" dot pulse>在线</Badge>
            <IconBtn icon="teach" size={16} title="教学模式" />
            <IconBtn icon="minimize2" size={16} title="收起为抽屉" onClick={() => { go("today"); setTimeout(() => window.__openCopilot && window.__openCopilot(), 60); }} />
          </div>
        </header>

        <div className="cop-thread" ref={threadRef}>
          <div className="cop-thread-inner">
            {active.messages.length === 0 ? (
              <div className="cop-blank">
                <div className="cop-blank-mark"><BrandMark size={40} /></div>
                <div className="cop-blank-t serif">问 Loom 任何事</div>
                <div className="cop-blank-s">它会调用工具、把过程与成本摊给你，并在写入前等你拍板。</div>
              </div>
            ) : active.messages.map((m, i) => <CopMsg key={i} m={m} />)}
            {typing && (
              <div className="cop-msg ai">
                <div className="cop-ava ai"><Icon name="sparkle" size={15} /></div>
                <div className="cop-msg-body"><div className="cop-msg-name">Loom Copilot</div>
                  <div className="cop-tool-wrap"><div className="tcard"><div className="tc-head"><span className="tc-ico"><Icon name="refresh" size={15} className="spin" /></span><span className="tc-name">思考中…</span></div></div></div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="cop-composer-wrap">
          <div className="cop-suggest">
            {COP_SUGGEST.map((q) => <button key={q} className="cop-chip" onClick={() => send(q)}>{q}</button>)}
          </div>
          <div className="cop-composer">
            <textarea rows={1} value={val} placeholder="问 Loom 任何事，或 @ 一个知识节点 / 题目…"
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <div className="cop-composer-foot">
              <div className="cop-modelsel">
                {COP_MODELS.map((mo) => (
                  <button key={mo.id} className={(model === mo.id ? "on" : "")} onClick={() => setModel(mo.id)} title={mo.hint}>{mo.name}</button>
                ))}
              </div>
              <span className="cop-composer-hint meta">{COP_MODELS.find((m) => m.id === model).hint}</span>
              <Btn variant="primary" size="sm" icon="send" onClick={() => send()}>发送</Btn>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
window.ScreenCopilot = ScreenCopilot;
