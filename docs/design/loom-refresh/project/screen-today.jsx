// Loom · Today hub (round-2a) — contract §3A.
// Keeps round-1 woven hero + heatmap visuals; replaces KPIs/lanes content,
// adds active-sessions / AI-changes(undo) / proposal / cost sections.

function KpiCard({ kpi, active, go }) {
  const v = useCountUp(kpi.value, { start: active, dur: 1000 });
  return (
    <Card pad hover className="kpi" onClick={() => go(kpi.route)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") go(kpi.route); }}>
      <div className="kpi-label"><Icon name={kpi.icon} size={14} />{kpi.label}</div>
      <div className="kpi-val tnum">{Math.round(v)}</div>
      <div className="kpi-foot kpi-sub">{kpi.sub}</div>
      <Icon name="arrow" size={15} className="kpi-go" />
    </Card>
  );
}

function LoomHero({ go, onRefresh }) {
  const hour = new Date().getHours();
  const greet = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "午安" : hour < 18 ? "下午好" : "晚上好";
  return (
    <Card className="loom-hero" padLg>
      <svg className="hero-weave" viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">
        <path className="wv wv1" d="M0 60 C 150 60, 150 100, 300 100 S 450 60, 600 60" />
        <path className="wv wv2" d="M0 90 C 150 90, 150 130, 300 130 S 450 90, 600 90" />
        <path className="wv wv3" d="M0 120 C 150 120, 150 160, 300 160 S 450 120, 600 120" />
      </svg>
      <div className="hero-inner">
        <div className="eyebrow"><span className="dot-sep">●</span>TODAY · {new Date().toISOString().slice(0, 10)} · phase 1c</div>
        <h1 className="page-title hero-title">{greet}，{DATA.user.name}。</h1>
        <p className="page-lead">昨晚 Dreaming agent 跑过；下面是它想让你看的几件事，再加你自己排的复习队列。</p>
        <div className="hero-cta">
          <Btn variant="primary" icon="review" onClick={() => go("review")}>开始今日复习</Btn>
          <Btn variant="secondary" icon="record" onClick={() => go("record")}>录入</Btn>
          <Btn variant="ghost" icon="copilot" onClick={() => window.__openCopilot && window.__openCopilot()}>打开 Copilot</Btn>
        </div>
      </div>
    </Card>
  );
}

function ThreadCard({ th, go }) {
  return (
    <Card hover pad className="thread-card" onClick={() => go(th.route)}>
      <div className="thread-top">
        <span className={"card-icon accent thread-ic tone-" + th.tone}><Icon name={th.icon} size={18} /></span>
        <Badge tone={th.tone}>{th.badge}</Badge>
        <Icon name="arrow" size={16} className="thread-arrow" />
      </div>
      <div className="thread-label meta">{th.label}</div>
      <div className="thread-title serif">{th.title}</div>
      <div className="thread-sub">{th.sub}</div>
      <div className="thread-cta">{th.cta} <Icon name="arrow" size={14} /></div>
    </Card>
  );
}

function SessionsStrip({ go, state, onRetry }) {
  return (
    <Card pad>
      <div className="card-head">
        <span className="card-icon"><Icon name="clock" size={18} /></span>
        <div className="card-title">进行中的会话</div>
        <span className="meta" style={{ marginLeft: "auto" }}>review_session</span>
      </div>
      <Stateful state={state} onRetry={onRetry} errorText="无法读取会话状态。"
        skeleton={<SkLines rows={2} />}
        empty={<div className="quiet-empty">没有进行中的复习会话。</div>}>
        <div className="strip-list">
          {DATA.sessions.map((s) => (
            <div key={s.id} className="strip">
              <span className={"strip-lead " + (s.status === "in_progress" ? "tone-good" : "tone-hard")}>
                <Icon name={s.status === "in_progress" ? "review" : "undo"} size={16} />
              </span>
              <div className="strip-body">
                <div className="strip-title">{s.subject} · 已复习 {s.reviewed}</div>
                <div className="strip-sub nowrap-meta">
                  <span className="badge tone-neutral" style={{ padding: "2px 6px" }}>{s.status === "in_progress" ? "进行中" : "已中断"}</span>
                  {s.dist} · {s.dur}
                </div>
              </div>
              <div className="strip-end">
                <Btn size="sm" variant={s.status === "in_progress" ? "primary" : "secondary"} iconEnd="arrow"
                  onClick={() => go("review")}>{s.status === "in_progress" ? "继续" : "恢复"}</Btn>
              </div>
            </div>
          ))}
        </div>
      </Stateful>
    </Card>
  );
}

function AiChangesStrip({ state, onRetry }) {
  const [undone, setUndone] = React.useState({});
  return (
    <Card pad>
      <div className="card-head">
        <span className="card-icon accent"><Icon name="undo" size={18} /></span>
        <div className="card-title">AI 改动 · 近 24h</div>
        <span className="badge tone-neutral" style={{ marginLeft: "auto" }}>可回滚</span>
      </div>
      <Stateful state={state} onRetry={onRetry} errorText="无法读取改动记录。"
        skeleton={<SkLines rows={2} />}
        empty={<div className="quiet-empty">过去 24 小时没有 AI 改动。</div>}>
        <div className="strip-list">
          {DATA.aiChanges.map((c) => (
            <div key={c.id} className={"strip" + (undone[c.id] ? " is-undone" : "")}>
              <span className="strip-lead tone-coral"><Icon name="sparkle" size={15} /></span>
              <div className="strip-body">
                <div className="strip-title"><b className="mono">{c.agent}</b> 改了 {c.target}</div>
                <div className="strip-sub nowrap-meta mono">{c.ops} ops · {c.delta} · {c.ver} · {c.when}</div>
              </div>
              <div className="strip-end">
                {undone[c.id]
                  ? <Badge tone="good" dot><Icon name="check" size={12} />已撤销</Badge>
                  : <Btn size="sm" variant="ghost" icon="undo" onClick={() => setUndone((u) => ({ ...u, [c.id]: 1 }))}>撤销</Btn>}
              </div>
            </div>
          ))}
        </div>
      </Stateful>
    </Card>
  );
}

function ProposalStrip({ go, state, onRetry }) {
  const s = DATA.inboxSummary;
  return (
    <Card pad>
      <div className="card-head">
        <span className="card-icon"><Icon name="inbox" size={18} /></span>
        <div className="card-title">提议收件箱</div>
        <Btn size="sm" variant="ghost" iconEnd="arrow" style={{ marginLeft: "auto" }} onClick={() => go("inbox")}>去裁决</Btn>
      </div>
      <Stateful state={state} onRetry={onRetry} errorText="无法读取提议。"
        skeleton={<SkLines rows={1} />}
        empty={<div className="quiet-empty">没有待审提议。</div>}>
        <div className="prop-summary">
          <div className="prop-summary-n serif tnum">{s.total}</div>
          <div className="prop-summary-kinds">
            {s.breakdown.map(([k, n]) => {
              const meta = KIND_META[k] || { label: k, tone: "neutral" };
              return <span key={k} className={"chip tone-chip-" + meta.tone}>{meta.label} <b className="mono">{n}</b></span>;
            })}
          </div>
        </div>
      </Stateful>
    </Card>
  );
}

function CostRibbon({ state, onRetry }) {
  const c = DATA.cost;
  const pct = Math.min(100, c.today / c.budget * 100);
  return (
    <Card pad>
      <div className="card-head">
        <span className="card-icon"><Icon name="bolt" size={18} /></span>
        <div className="card-title">今日 AI 成本</div>
        <span className="meta" style={{ marginLeft: "auto" }}>预算 ${c.budget.toFixed(2)}</span>
      </div>
      <Stateful state={state} onRetry={onRetry} errorText="成本服务暂不可用。"
        skeleton={<SkLines rows={1} />}
        empty={<div className="quiet-empty">今日尚无 AI 花费。</div>}>
        <div className="cost-top">
          <div className="cost-amt serif tnum">${c.today.toFixed(2)}<span className="cost-budget"> / ${c.budget.toFixed(2)}</span></div>
        </div>
        <div className="bar" style={{ marginBottom: "var(--s-3)" }}><span style={{ width: pct + "%" }} /></div>
        <div className="cost-tasks">
          {c.tasks.map(([n, v]) => (
            <span key={n} className="chip"><span className="mono">{n}</span> <b className="mono">${v.toFixed(2)}</b></span>
          ))}
        </div>
        <div className="cost-foot nowrap-meta mono">tokens {(c.tokensIn / 1000).toFixed(1)}k in · {(c.tokensOut / 1000).toFixed(1)}k out · {c.toolCalls} tool calls</div>
      </Stateful>
    </Card>
  );
}

function WeekHeat() {
  const days = ["一", "二", "三", "四", "五", "六", "日"];
  const seed = [3,1,4,2,5,3,4, 2,3,1,4,3,2,5, 4,2,3,5,1,4,3, 1,4,2,3,5,2,4];
  return (
    <div className="week-heat">
      {Array.from({ length: 4 }).map((_, r) => (
        <div className="heat-row" key={r}>
          {days.map((d, c) => <span key={c} className="heat-cell" data-lvl={seed[(r * 7 + c) % seed.length]} style={{ animationDelay: (r * 7 + c) * 12 + "ms" }} />)}
        </div>
      ))}
      <div className="heat-axis">{days.map((d) => <span key={d} className="meta">{d}</span>)}</div>
    </div>
  );
}

function ScreenToday({ go, ui = {} }) {
  const [active, setActive] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const ds = ui.dataState || "ok";
  React.useEffect(() => { const id = requestAnimationFrame(() => setActive(true)); return () => cancelAnimationFrame(id); }, []);
  const refresh = () => { setActive(false); setNonce((n) => n + 1); requestAnimationFrame(() => requestAnimationFrame(() => setActive(true))); };

  return (
    <div className="page view">
      <LoomHero go={go} onRefresh={refresh} />

      <div key={nonce} className="kpi-row stagger" style={{ marginTop: "var(--s-5)" }}>
        {DATA.kpis.map((k) => <KpiCard key={k.key} kpi={k} active={active} go={go} />)}
      </div>

      <SectionLabel count="3 缕">今日之线</SectionLabel>
      <div className="threads-grid stagger">
        {DATA.threads.map((th) => <ThreadCard key={th.id} th={th} go={go} />)}
      </div>

      <SectionLabel>进行中 · 待裁决</SectionLabel>
      <div className="dash-grid">
        <div className="dash-col">
          <SessionsStrip go={go} state={ds} onRetry={refresh} />
          <AiChangesStrip state={ds} onRetry={refresh} />
        </div>
        <div className="dash-col">
          <ProposalStrip go={go} state={ds} onRetry={refresh} />
          <CostRibbon state={ds} onRetry={refresh} />
        </div>
      </div>

      <AgentNotesBoard go={go} state={ds} onRetry={refresh} />

      <SectionLabel>本周编织</SectionLabel>
      <Card pad>
        <div className="card-head">
          <span className="card-icon accent"><Icon name="target" size={18} /></span>
          <div className="card-title">7 天活动热力</div>
          <span className="badge tone-good" style={{ marginLeft: "auto" }}><span className="dot" />+12% 较上周</span>
        </div>
        <WeekHeat />
      </Card>
    </div>
  );
}

window.ScreenToday = ScreenToday;
