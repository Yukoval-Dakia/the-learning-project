// Loom · TeachingDrawer (round-2b) — 1-on-1 AI teaching for a learning item.
// Mirrors CopilotDrawer structure + shared useFocusTrap; has an idle state.

function TeachTool({ tool }) {
  const [stage, setStage] = React.useState("run");
  React.useEffect(() => { const t = setTimeout(() => setStage("done"), 1100); return () => clearTimeout(t); }, []);
  return (
    <div className="tool-card">
      <div className="tool-head"><Icon name="teach" size={14} /><span>{tool.name}</span>
        <span className="tool-status">{stage === "run" ? <><Icon name="refresh" size={13} className="spin" />运行中</> : <><Icon name="check" size={13} />完成</>}</span>
      </div>
      {stage === "done" && <div className="tool-body fade-key">{tool.rows.map((r, i) => <div key={i} className="tool-row"><span className="k">{r[0]}</span><span className="v">{r[1]}</span></div>)}</div>}
    </div>
  );
}

function TeachingDrawer({ open, onClose, item }) {
  const panelRef = React.useRef(null);
  const bodyRef = React.useRef(null);
  useFocusTrap(open, onClose, panelRef);
  const [msgs, setMsgs] = React.useState([]); // idle when empty
  const [typing, setTyping] = React.useState(false);
  const [val, setVal] = React.useState("");

  React.useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, typing]);

  const seeds = ["从「之」的主谓取独讲起", "给我出 3 道辨析题", "我总把「之」当代词，为什么错？"];
  const send = (text) => {
    const t = (text || val).trim(); if (!t) return;
    setMsgs((m) => [...m, { role: "user", text: t }]); setVal(""); setTyping(true);
    setTimeout(() => {
      setTyping(false);
      setMsgs((m) => [...m, { role: "ai",
        tool: { name: "pull_item_context", rows: [["item", item ? item.id : "li_zhi"], ["weak_point", "主谓取独"], ["evidence", "9"]] },
        text: "好。「之」在主谓之间时不作任何成分，只是取消句子独立性——记号是：主语和谓语之间能拆成「…的…」就不是它。先看一例：「师道之不传也久矣」。要不要我据此出一道辨析题？" }]);
    }, 1500);
  };

  return (
    <>
      <div className={"scrim" + (open ? " open" : "")} onClick={onClose} />
      <aside ref={panelRef} className={"drawer" + (open ? " open" : "")} role="dialog" aria-modal={open} aria-label="教学" aria-hidden={!open}>
        <div className="drawer-head">
          <span className="card-icon accent"><Icon name="teach" size={18} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-title serif">对话教学</div>
            <div className="meta">{item ? item.title : "学习项"} · 1-on-1</div>
          </div>
          <Badge tone="good" dot pulse>在线</Badge>
          <IconBtn icon="close" size={16} onClick={onClose} aria-label="关闭" />
        </div>

        <div className="drawer-body" ref={bodyRef}>
          {msgs.length === 0 && !typing ? (
            <div className="teach-idle">
              <span className="teach-idle-ic"><Icon name="teach" size={30} /></span>
              <div className="teach-idle-title serif">开始针对「{item ? item.title : "本学习项"}」的对话教学</div>
              <p className="teach-idle-sub">AI 会读取该学习项的薄弱点与 evidence，按你的节奏一步步讲、随讲随测。挑一个开头：</p>
              <div className="teach-seeds">
                {seeds.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}
              </div>
            </div>
          ) : (
            <>
              {msgs.map((m, i) => (
                <div key={i} className={"msg msg-" + m.role}>
                  <div className="msg-avatar">{m.role === "ai" ? <Icon name="teach" size={14} /> : DATA.user.initial}</div>
                  <div className="msg-body">
                    <div className="msg-name">{m.role === "ai" ? "教学 AI" : DATA.user.name}</div>
                    {m.tool && <TeachTool tool={m.tool} />}
                    {m.text && <div className="msg-text">{m.text}</div>}
                    {m.role === "ai" && <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)", flexWrap: "wrap" }}>
                      <Btn size="sm" variant="good" icon="quiz">出辨析题</Btn>
                      <Btn size="sm" variant="ghost" icon="check">我懂了</Btn>
                    </div>}
                  </div>
                </div>
              ))}
              {typing && <div className="msg msg-ai fade-key"><div className="msg-avatar"><Icon name="teach" size={14} /></div><div className="msg-body"><div className="msg-name">教学 AI</div><div className="tool-card"><div className="tool-head"><Icon name="refresh" size={14} className="spin" />思考中…</div></div></div></div>}
            </>
          )}
        </div>

        <div className="drawer-foot">
          <div className="composer">
            <textarea rows={1} value={val} placeholder="回答或提问…" onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <Btn variant="primary" size="sm" onClick={() => send()} style={{ width: 34, padding: 0 }}><Icon name="send" size={16} /></Btn>
          </div>
        </div>
      </aside>
    </>
  );
}
window.TeachingDrawer = TeachingDrawer;
