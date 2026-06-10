// Loom · /learning-sessions list + /learning-sessions/[id] detail (J).
function MiniDist({ dist }) {
  if (!dist) return <span className="meta">—</span>;
  const total = dist.again + dist.hard + dist.good || 1;
  return (
    <div className="mini-dist" title={`不会 ${dist.again} · 模糊 ${dist.hard} · 会了 ${dist.good}`}>
      <span className="tone-again" style={{ width: dist.again / total * 100 + "%" }} />
      <span className="tone-hard" style={{ width: dist.hard / total * 100 + "%" }} />
      <span className="tone-good" style={{ width: dist.good / total * 100 + "%" }} />
    </div>
  );
}

function ScreenSessions({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  return (
    <div className="page view">
      <button className="back-link" onClick={() => go("today")}><Icon name="arrowL" size={14} />今日</button>
      <div className="page-head">
        <div className="eyebrow">SESSIONS · LearningSession · {DATA.sessionsList.length} 条</div>
        <h1 className="page-title serif">学习会话</h1>
        <p className="page-lead">过往复习与录入会话。复习会话可重开或恢复；录入会话带 ingestion 生命周期状态。</p>
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="会话历史加载失败。"
        skeleton={<Card pad><SkLines rows={4} /></Card>}
        empty={<EmptyState icon="history" title="还没有会话" text="开始一次复习后，会话会记录在这里。" />}>
        <Card>
          <div className="sess-head-row meta">
            <span>会话</span><span>状态</span><span>已复习</span><span>评分</span><span>时长</span><span></span>
          </div>
          {DATA.sessionsList.map((s) => (
            <div key={s.id} className="sess-row">
              <div className="sess-id">
                <span className={"sess-type-ic tone-" + (s.type === "review" ? "coral" : "info")}><Icon name={s.type === "review" ? "review" : "record"} size={15} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="mono sess-id-t">{s.id}</div>
                  <div className="meta nowrap-meta">{s.started}{s.knowledge.map((k) => <span key={k} className="chip chip-k mono" style={{ padding: "0 5px" }}>{k}</span>)}</div>
                  {s.note && <div className="meta">{s.note}</div>}
                </div>
              </div>
              <div><StatusBadge status={s.status} /></div>
              <div className="mono sess-reviewed">{s.reviewed || "—"}</div>
              <div><MiniDist dist={s.dist} /></div>
              <div className="mono">{s.dur}</div>
              <div className="sess-acts">
                <Btn size="sm" variant="secondary" onClick={() => go("learning-sessions/" + s.id)}>详情</Btn>
                {s.type === "review" && s.status === "done" && <Btn size="sm" variant="ghost" icon="refresh" onClick={() => go("review")}>重开</Btn>}
                {(s.status === "in_progress" || s.status === "partial") && <Btn size="sm" variant="ghost" icon="undo" onClick={() => go("review")}>恢复</Btn>}
              </div>
            </div>
          ))}
        </Card>
      </Stateful>
    </div>
  );
}

function ScreenSessionDetail({ go, param, ui = {} }) {
  const meta = DATA.sessionsList.find((s) => s.id === param);
  const d = DATA.sessionDetail[param] || DATA.sessionDetail.rs_37;
  const dist = d.dist; const total = dist.again + dist.hard + dist.good;
  return (
    <div className="page view page-narrow">
      <button className="back-link" onClick={() => go("learning-sessions")}><Icon name="arrowL" size={14} />学习会话</button>
      <div className="page-head">
        <div className="eyebrow">SESSION · {param}</div>
        <div className="page-head-row">
          <h1 className="page-title serif">会话详情</h1>
          <StatusBadge status={(meta && meta.status) || d.summary.status} />
        </div>
      </div>

      <div className="sess-summary">
        {[["类型", d.summary.type], ["时长", d.summary.dur], ["复习数", d.summary.count], ["成本", d.summary.cost], ["模型", d.summary.model]].map(([l, v]) => (
          <div key={l} className="sess-sum-cell"><div className="sess-sum-n serif">{v}</div><div className="meta">{l}</div></div>
        ))}
      </div>

      <Card pad style={{ marginTop: "var(--s-5)" }}>
        <div className="card-head"><span className="card-icon"><Icon name="review" size={18} /></span><div className="card-title">评分分布</div><span className="meta" style={{ marginLeft: "auto" }}>{total} 次</span></div>
        <div className="dist-bar">
          <span className="dist-seg tone-again" style={{ width: dist.again / total * 100 + "%" }} />
          <span className="dist-seg tone-hard" style={{ width: dist.hard / total * 100 + "%" }} />
          <span className="dist-seg tone-good" style={{ width: dist.good / total * 100 + "%" }} />
        </div>
        <div className="dist-legend">
          <span><span className="dist-key tone-again" />不会 <b className="mono">{dist.again}</b></span>
          <span><span className="dist-key tone-hard" />模糊 <b className="mono">{dist.hard}</b></span>
          <span><span className="dist-key tone-good" />会了 <b className="mono">{dist.good}</b></span>
        </div>
      </Card>

      <Card pad sunk style={{ marginTop: "var(--s-4)", borderColor: "var(--coral-line)" }}>
        <div className="card-head"><span className="card-icon accent"><Icon name="sparkle" size={18} /></span><div className="card-title">AI 会话总结</div></div>
        <p className="prose-cn" style={{ marginTop: "var(--s-2)" }}>{d.aiSummary}</p>
      </Card>

      <SectionLabel>逐事件流</SectionLabel>
      <Card pad>
        <div className="event-chain">
          {d.events.map((e, i) => (
            <button key={e.id} className="event-row event-link" onClick={() => go("events/" + e.id)}>
              <span className="event-rail"><span className="event-dot" style={{ background: `var(--${e.tone})` }} />{i < d.events.length - 1 && <span className="event-line" />}</span>
              <div className="event-body">
                <div className="event-head nowrap-meta"><span className="mono event-label">{e.label}</span><span className="meta">{e.t}</span></div>
                <div className="meta mono">→ events:{e.id}</div>
              </div>
              <Icon name="arrow" size={14} className="thread-arrow" />
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
window.ScreenSessions = ScreenSessions;
window.ScreenSessionDetail = ScreenSessionDetail;
