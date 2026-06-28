// Loom · 晨间交班叙事缕 (refresh) — standalone shell.
// 段1 忠实扁平 /today 上下文(hero · KpiRow · 今日之线) + 段2 交班缕 band(来自 handoff-band.jsx)。
// 形态由 Tweaks 驱动；band 组件单一真源在 handoff-band.jsx，与 Loom.html /today 共用。

/* ════════════════════ 段1 context slice (复用既有视觉, 不重造) ════════════════════ */
function TopBar() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", padding: "var(--s-3) 0 var(--s-5)", borderBottom: "1px solid var(--line)", marginBottom: "var(--s-6)" }}>
      <span style={{ color: "var(--coral)" }}><BrandMark size={28} /></span>
      <span style={{ font: "600 var(--fs-h5)/1 var(--font-serif)", color: "var(--ink)", letterSpacing: "var(--ls-tight)" }}>Loom</span>
      <span style={{ marginLeft: "var(--s-3)", padding: "4px 11px", borderRadius: "var(--r-pill)", background: "var(--coral-soft)", color: "var(--coral-ink)", font: "500 var(--fs-meta)/1 var(--font-sans)" }}>今日 · today</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "var(--s-2)" }}>
        <span className="meta" style={{ fontFamily: "var(--font-mono)" }}>{DATA.user.plan}</span>
        <span style={{ width: 30, height: 30, borderRadius: "50%", background: "var(--paper-sunk)", border: "1px solid var(--line)", display: "grid", placeItems: "center", font: "600 13px/1 var(--font-serif)", color: "var(--ink-2)" }}>{DATA.user.initial}</span>
      </span>
    </div>
  );
}

function LoomHero2() {
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
        <p className="page-lead">这是你的工作台：复习队列、AI 的提议与改动，都汇在这里。</p>
      </div>
    </Card>
  );
}

function KpiCard2({ kpi, go }) {
  const v = useCountUp(kpi.value, { dur: 1000 });
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

function ThreadCard2({ th, go }) {
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

/* ════════════════════ App ════════════════════ */
const HX_DEFAULTS = /*EDITMODE-BEGIN*/{
  "placement": "并列",
  "cardStyle": "缕带",
  "masteryStyle": "档条",
  "density": "里程碑",
  "state": "ok",
  "jobFailHonest": true
}/*EDITMODE-END*/;

function HandoffApp() {
  const [t, setTweak] = useTweaks(HX_DEFAULTS);
  const [toast, toastNode] = useToast();
  const go = (route) => toast(route);
  const merged = t.placement === "并入" && t.state === "ok";

  return (
    <div className="page view" data-refine="on" data-screen-label="今日 · /today">
      <TopBar />
      <LoomHero2 />

      <div className="seg-light">
        <div className="seg-eyebrow"><span className="seg-no">先</span><span className="seg-txt">今天要动的 · 即时可动作</span><span className="seg-rule" /></div>
        <div className="kpi-row">
          {DATA.kpis.map((k) => <KpiCard2 key={k.key} kpi={k} go={go} />)}
        </div>
      </div>

      <SectionLabel count={merged ? "你排的 + 昨夜的" : "你自己排的"}>今日之线</SectionLabel>
      <div className="threads-grid">
        {DATA.threads.map((th) => <ThreadCard2 key={th.id} th={th} go={go} />)}
      </div>

      {merged ? (
        <React.Fragment>
          <div className="hx-merge-note"><span className="hx-moon" style={{ display: "inline-grid", placeItems: "center", borderRadius: "var(--r-pill)", background: "var(--coral-soft)", color: "var(--coral-ink)" }}><Icon name="moon" size={12} /></span>夜链 · 昨夜替你做的 {HANDOFF2.items.length} 缕 —— 并入今日之线</div>
          <div className="threads-grid">
            {HANDOFF2.items.map((it) => <MergeCard key={it.id} it={it} go={go} />)}
          </div>
          <MinorFold items={HANDOFF2.minor} go={go} />
        </React.Fragment>
      ) : (
        <HandoffBand cardStyle={t.cardStyle} masteryStyle={t.masteryStyle} density={t.density}
          state={t.state} jobFailHonest={t.jobFailHonest} go={go} />
      )}

      <div className="hx-rest">
        <Icon name="layers" size={16} />
        <div className="hx-rest-txt"><b>进行中 · 待裁决 · AI 观察 · 本周热力</b> —— 既有区块续在下方，原样保留（本稿不重排）。</div>
      </div>

      {toastNode}

      <TweaksPanel title="Tweaks">
        <TweakSection label="落点 · 留白①" />
        <TweakRadio label="交班缕落点" value={t.placement} options={["并列", "并入"]} onChange={(v) => setTweak("placement", v)} />
        <TweakSection label="叙事形态" />
        <TweakRadio label="缕卡形态" value={t.cardStyle} options={["缕带", "交班帖"]} onChange={(v) => setTweak("cardStyle", v)} />
        <TweakRadio label="叙事浓度" value={t.density} options={["轻", "里程碑", "叙事"]} onChange={(v) => setTweak("density", v)} />
        <TweakSection label="掌握呈现 · 硬契约" />
        <TweakRadio label="mastery 隐喻" value={t.masteryStyle} options={["档条", "方向", "织线"]} onChange={(v) => setTweak("masteryStyle", v)} />
        <TweakSection label="状态 · 各有面貌" />
        <TweakSelect label="当前状态" value={t.state} onChange={(v) => setTweak("state", v)}
          options={[
            { value: "ok", label: "稳态 · 有交班" },
            { value: "firstNight", label: "空夜 · 首日(预告)" },
            { value: "quietNight", label: "空夜 · 安静夜(极简)" },
            { value: "loading", label: "加载中 · 正在准备" },
            { value: "degrade", label: "部分降级 + job 失败" },
          ]} />
        <TweakSection label="诚实度 · 留白③" />
        <TweakToggle label="job 失败如实交代" value={t.jobFailHonest} onChange={(v) => setTweak("jobFailHonest", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<HandoffApp />);
