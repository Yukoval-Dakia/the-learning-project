// Loom · /events/[id] (E) — event-sourced causal chain.
const ACTOR_ICON = { user: "today", agent: "sparkle", cron: "moon", system: "bolt" };

function ScreenEvents({ go, param, ui = {} }) {
  const ds = ui.dataState || "ok";
  const e = DATA.events[param] || DATA.events.evt_3120;
  const [rawOpen, setRawOpen] = React.useState(false);
  const [corrections, setCorrections] = React.useState(e.corrections);
  const [adding, setAdding] = React.useState(false);
  const [note, setNote] = React.useState("");
  const addCorrection = () => { if (!note.trim()) return; setCorrections((c) => [...c, { id: "evt_new", label: note, when: "刚刚", actor: "user" }]); setNote(""); setAdding(false); };

  return (
    <div className="page view page-narrow">
      <button className="back-link" onClick={() => go("mistakes")}><Icon name="arrowL" size={14} />错题</button>
      <div className="page-head">
        <div className="eyebrow">EVENT · {e.focal.id} · adr-0006</div>
        <h1 className="page-title serif">事件链</h1>
        <p className="page-lead">每个事件是不可变记录，带 actor、caused_by 链与成本。下面是该焦点事件的来龙去脉。</p>
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="事件加载失败。" skeleton={<Card pad><SkLines rows={3} /></Card>}
        empty={<EmptyState icon="link" title="无此事件" text="该事件不存在或已被压缩。" />}>

        {/* caused_by */}
        <div className="ev-lane">
          <div className="ev-lane-label meta">caused_by · 由什么导致</div>
          <button className="ev-node ev-cause" onClick={() => go("learning-sessions/" + e.causedBy.id)}>
            <span className="ev-actor"><Icon name={ACTOR_ICON[e.causedBy.actor]} size={14} /></span>
            <span>{e.causedBy.label}</span><Icon name="arrow" size={13} className="thread-arrow" />
          </button>
          <div className="ev-connector" />
        </div>

        {/* focal */}
        <div className="ev-focal">
          <div className="ev-focal-head">
            <span className="badge tone-again"><span className="dot" />focal</span>
            <span className="ev-actor"><Icon name={ACTOR_ICON[e.focal.actor]} size={14} />{e.focal.actor}</span>
            <span className="meta mono" style={{ marginLeft: "auto" }}>{e.focal.when}</span>
          </div>
          <div className="ev-focal-title serif">{e.focal.action}:{e.focal.outcome} · <span className="wenyan">{e.focal.subject}</span></div>
          <button className={"raw-toggle" + (rawOpen ? " open" : "")} onClick={() => setRawOpen((o) => !o)}>
            <Icon name="slash" size={13} />{rawOpen ? "收起" : "展开"} raw payload
          </button>
          {rawOpen && <pre className="raw-payload fade-key">{JSON.stringify(e.raw, null, 2)}</pre>}
        </div>

        {/* downstream */}
        <div className="ev-lane">
          <div className="ev-connector" />
          <div className="ev-lane-label meta">导致了 · downstream</div>
          {e.downstream.map((d) => (
            <button key={d.id} className="ev-node" onClick={() => d.id.startsWith("m") ? go("mistakes") : null}>
              <span className={"ev-dot tone-" + d.tone} style={{ background: `var(--${d.tone})` }} />
              <span>{d.label}</span><span className="ev-actor-mini mono">{d.actor}</span>
            </button>
          ))}
        </div>

        {/* corrections */}
        <SectionLabel count={corrections.length}>corrections · 纠正</SectionLabel>
        <Card pad>
          {corrections.map((c) => (
            <div key={c.id} className="corr-row">
              <span className="ev-dot tone-good" style={{ background: "var(--good)" }} />
              <span>{c.label}</span><span className="meta" style={{ marginLeft: "auto" }}>{c.when} · {c.actor}</span>
            </div>
          ))}
          {adding ? (
            <div className="corr-add fade-key">
              <input className="field-input" autoFocus placeholder="描述纠正动作…" value={note} onChange={(ev) => setNote(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && addCorrection()} />
              <Btn size="sm" variant="primary" icon="check" onClick={addCorrection}>添加</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setAdding(false)}>取消</Btn>
            </div>
          ) : (
            <button className="corr-add-btn" onClick={() => setAdding(true)}><Icon name="plus" size={14} />添加纠正</button>
          )}
        </Card>
      </Stateful>
    </div>
  );
}
window.ScreenEvents = ScreenEvents;
