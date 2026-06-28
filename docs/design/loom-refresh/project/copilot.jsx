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

function Message({ m, animate, go }) {
  return (
    <div className={"msg msg-" + m.role}>
      <div className="msg-avatar">{m.role === "ai" ? <Icon name="sparkle" size={14} /> : DATA.user.initial}</div>
      <div className="msg-body">
        <div className="msg-name">{m.role === "ai" ? "编排者" : DATA.user.name}</div>
        {m.tool && <ToolCard tool={m.tool} animate={animate} />}
        {m.text && <div className="msg-text">{m.text}</div>}
        {m.pr && <PrCard pr={m.pr} />}
        {m.run && <RunCard run={m.run} />}
        {m.fail && <CopFail kind={m.fail} onRetry={() => {}} />}
        {m.role === "ai" && m.text && !m.pr && !m.fail && !m.run && (
          <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)", flexWrap: "wrap" }}>
            <Btn size="sm" variant="good" icon="plus">生成 2 张卡片</Btn>
            <Btn size="sm" variant="ghost" icon="knowledge" onClick={() => go && go("knowledge")}>查看节点</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function CopilotDrawer({ open, onClose, onExpand, copilotState = "normal", go }) {
  // demo-state seeds the thread so reviewers can feel each A3 state via Tweaks
  const seedMsgs = React.useCallback(() => {
    if (copilotState === "blank") return [];
    if (copilotState === "run") return [...DATA.chat, { role: "user", text: "帮我把这周薄弱点重建一套练习。" }, { role: "ai", text: "这事有点长，我搬到后台慢慢跑 —— 你可以关掉这里，回来能看到进度。", run: COPILOT_A3.run }];
    if (copilotState === "partial") return [...DATA.chat, { role: "user", text: "再讲讲「之」取消独立性。" }, { role: "ai", fail: "partial" }];
    if (copilotState === "toolfail") return [...DATA.chat, { role: "user", text: "给我出 2 张主谓取独的卡。" }, { role: "ai", fail: "toolfail" }];
    if (copilotState === "empty-reply") return [...DATA.chat, { role: "user", text: "我开放题的水平到底怎么样？" }, { role: "ai", fail: "empty-reply" }];
    if (copilotState === "pr") return [...DATA.chat, { role: "user", text: "把「之」这块给我补强一轮。" }, { role: "ai", text: "好 —— 顺着昨夜 dreaming 的复盘，我动了几处。下面是这一句话引出的全部改动，你逐条留或撤都行：", pr: COPILOT_A3.pr }];
    return DATA.chat;
  }, [copilotState]);

  const [msgs, setMsgs] = React.useState(seedMsgs);
  const [typing, setTyping] = React.useState(false);
  const [val, setVal] = React.useState("");
  const [nudge, setNudge] = React.useState(copilotState === "proactive");
  const bodyRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const restoreRef = React.useRef(null);

  React.useEffect(() => { setMsgs(seedMsgs()); setNudge(copilotState === "proactive"); }, [copilotState]);

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
    setVal(""); setTyping(true); setNudge(false);
    setTimeout(() => {
      setTyping(false);
      // per-utterance checkpoint: orchestrator returns a reviewable PR
      setMsgs((m) => [...m, {
        role: "ai",
        text: "好 —— 顺着昨夜 dreaming 的复盘，我动了几处。下面是这一句话引出的全部改动，你逐条留或撤都行：",
        pr: COPILOT_A3.pr,
      }]);
    }, 1400);
  };

  return (
    <>
      <div className={"scrim" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"drawer" + (open ? " open" : "")} aria-hidden={!open} aria-label="Copilot" role="dialog" aria-modal={open} ref={panelRef}>
        <div className="drawer-head">
          <span className="card-icon accent"><Icon name="copilot" size={18} /></span>
          <div className="drawer-title serif">编排者</div>
          <Badge tone="good" dot pulse>在线</Badge>
          <div style={{ marginLeft: "auto", display: "flex", gap: "var(--s-2)" }}>
            {onExpand && <IconBtn icon="maximize" size={16} title="全屏 Copilot" aria-label="全屏" onClick={onExpand} />}
            <IconBtn icon="teach" size={16} title="教学模式" aria-label="教学模式" />
            <IconBtn icon="close" size={16} onClick={onClose} aria-label="关闭" />
          </div>
        </div>

        <div className="drawer-body" ref={bodyRef}>
          {msgs.length === 0 && (
            <div className="cop-blank" style={{ padding: "var(--s-10) var(--s-4)" }}>
              <span className="cop-blank-mark"><Icon name="copilot" size={34} /></span>
              <div className="cop-blank-t serif" style={{ fontSize: "var(--fs-h4)" }}>我是你的编排者</div>
              <div className="cop-blank-s">前台和昨夜后台的我是同一个 —— 我能引用它为你备的东西。问我今天该学什么、为什么这么排，或让我改动；每一句话我都给你一份可留可撤的改动。</div>
            </div>
          )}
          {msgs.map((m, i) => <Message key={i} m={m} animate={i === 1} go={go} />)}
          {nudge && (
            <ProactiveNudge data={COPILOT_A3.proactive.afterIngest}
              onAct={() => { setNudge(false); send("好，出 3 道针对性的题。"); }}
              onDismiss={() => setNudge(false)} />
          )}
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
