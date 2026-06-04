// Loom · Copilot / Teaching drawer.
function ToolCard({ tool, animate }) {
  const [stage, setStage] = React.useState(animate ? "run" : "done");
  React.useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setStage("done"), 1400);
    return () => clearTimeout(t);
  }, [animate]);
  return (
    <div className="tool-card">
      <div className="tool-head">
        <Icon name="search" size={14} />
        <span>{tool.name}</span>
        <span className="tool-status" style={stage === "run" ? { color: "var(--ink-4)" } : null}>
          {stage === "run"
            ? <><Icon name="refresh" size={13} className="spin" />运行中</>
            : <><Icon name="check" size={13} />完成</>}
        </span>
      </div>
      {stage === "done" && (
        <div className="tool-body fade-key">
          {tool.rows.map((r, i) => (
            <div key={i} className="tool-row"><span className="k">{r[0]}</span><span className="v">{r[1]}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ m, animate }) {
  return (
    <div className={"msg msg-" + m.role}>
      <div className="msg-avatar">{m.role === "ai" ? <Icon name="sparkle" size={14} /> : DATA.user.initial}</div>
      <div className="msg-body">
        <div className="msg-name">{m.role === "ai" ? "Loom Copilot" : DATA.user.name}</div>
        {m.tool && <ToolCard tool={m.tool} animate={animate} />}
        {m.text && <div className="msg-text">{m.text}</div>}
        {m.role === "ai" && m.text && (
          <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)", flexWrap: "wrap" }}>
            <Btn size="sm" variant="good" icon="plus">生成 2 张卡片</Btn>
            <Btn size="sm" variant="ghost" icon="knowledge">查看节点</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function CopilotDrawer({ open, onClose }) {
  const [msgs, setMsgs] = React.useState(DATA.chat);
  const [typing, setTyping] = React.useState(false);
  const [val, setVal] = React.useState("");
  const bodyRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const restoreRef = React.useRef(null);

  React.useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, typing]);

  // focus management — trap inside drawer, restore opener, Esc closes
  React.useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const sel = 'a[href],button:not([disabled]),textarea,input,[tabindex]:not([tabindex="-1"])';
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
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restoreRef.current && restoreRef.current.focus) restoreRef.current.focus();
    };
  }, [open, onClose]);

  const send = (text) => {
    const t = (text || val).trim();
    if (!t) return;
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setVal(""); setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [...m, {
        role: "ai",
        tool: { name: "search_knowledge", status: "done", rows: [["query", t.slice(0, 12)], ["matched", "k_xuci · 3 nodes"], ["confidence", "0.86"]] },
        text: "已为你检索相关知识节点并整理要点。需要我把它排进今天的复习队列吗？",
      }]);
    }, 1600);
  };

  return (
    <>
      <div className={"scrim" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"drawer" + (open ? " open" : "")} aria-hidden={!open} aria-label="Copilot" role="dialog" aria-modal={open} ref={panelRef}>
        <div className="drawer-head">
          <span className="card-icon accent"><Icon name="copilot" size={18} /></span>
          <div className="drawer-title serif">Copilot</div>
          <Badge tone="good" dot pulse>在线</Badge>
          <div style={{ marginLeft: "auto", display: "flex", gap: "var(--s-2)" }}>
            <IconBtn icon="teach" size={16} title="教学模式" aria-label="教学模式" />
            <IconBtn icon="close" size={16} onClick={onClose} aria-label="关闭" />
          </div>
        </div>

        <div className="drawer-body" ref={bodyRef}>
          {msgs.map((m, i) => <Message key={i} m={m} animate={i === 1} />)}
          {typing && (
            <div className="msg msg-ai fade-key">
              <div className="msg-avatar"><Icon name="sparkle" size={14} /></div>
              <div className="msg-body">
                <div className="msg-name">Loom Copilot</div>
                <div className="tool-card"><div className="tool-head"><Icon name="refresh" size={14} className="spin" />思考中…</div></div>
              </div>
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <div style={{ display: "flex", gap: "var(--s-2)", marginBottom: "var(--s-3)", flexWrap: "wrap" }}>
            <button className="chip" onClick={() => send("今天该复习哪些？")}>今天该复习哪些？</button>
            <button className="chip" onClick={() => send("解释「之」的用法")}>解释「之」的用法</button>
          </div>
          <div className="composer">
            <textarea rows={1} value={val} placeholder="问 Loom 任何事，或 @ 一个知识节点…"
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <Btn variant="primary" size="sm" onClick={() => send()} style={{ width: 34, padding: 0 }}><Icon name="send" size={16} /></Btn>
          </div>
        </div>
      </aside>
    </>
  );
}
window.CopilotDrawer = CopilotDrawer;
