// Loom · Coach 复盘中枢 — owner 拍定 2026-06-28.
// 不再是单一「Coach 周报」;是「我做得怎样」的复盘中枢,含三个正交视图,分段切换、同屏不合并:
//   ① 活动量   — FSRS 复习活动报表(现有,不动)。答「练了多少、对了几道」。/api/review/weekly。
//   ② 校准诊断 — 横截面 θ̂/p(L) 点估计 + 置信(从 admin 迁入)。答「现在会不会、多可信」。
//   ③ 成效趋势 — 纵向 delta:相对自己的轨迹 + 方向 + 置信(A7,新)。答「相比上次涨了吗」。
// 「周报」降级为活动量视图里的时间窗。校准诊断(横截面「多准」) ⟂ 成效趋势(纵向「涨没涨」)。

const COACH_VIEWS = [
  { id: "activity",    label: "活动量",   icon: "review",  ortho: false },
  { id: "calibration", label: "校准诊断", icon: "target",  ortho: true },
  { id: "efficacy",    label: "成效趋势", icon: "history", ortho: true },
];
const VIEW_QUERY = {
  activity:    "活动量 · GET /api/review/weekly · 7/30/90d",
  calibration: "校准诊断 · GET /api/observability/calibration-maturity · adr-0035",
  efficacy:    "成效趋势 · events experimental:mastery_progress · 纵向读模型 PR #664",
};
const VIEW_LEDE = {
  activity:    <span>活动量答「我练了多少、对了几道」—— FSRS 复习的<b>活动报表</b>。「周报」就是这里的时间窗,不再是整个 Coach 的名字。</span>,
  calibration: <span>校准诊断答「我现在这块<b>会不会、多可信</b>」—— 横截面 θ̂/p(L) 点估计 + 置信。和右边的成效趋势<b>正交</b>:这一面看「准不准」。</span>,
  efficacy:    <span>成效趋势答「相比上次,<b>我涨了吗</b>」—— 纵向 delta、相对你自己的轨迹。和左边的校准诊断<b>正交</b>:这一面看「涨没涨」。</span>,
};

/* ── 活动量视图(沿用现有 Coach 周报内容,reviews/正确率/分布/归因/逐日/失败排行)── */
function CoachKpi({ label, value, unit, prefix }) {
  const v = useCountUp(value, { dur: 850 });
  const shown = Number.isInteger(value) ? Math.round(v) : v.toFixed(2);
  return (
    <div className="coach-kpi">
      <div className="coach-kpi-n serif tnum">{prefix}{shown}<span className="coach-kpi-u">{unit}</span></div>
      <div className="coach-kpi-l meta">{label}</div>
    </div>
  );
}

function CoachActivity({ go }) {
  const [win, setWin] = React.useState("7");
  const c = DATA.coach[win];
  const distTotal = c.dist.again + c.dist.hard + c.dist.good;
  const maxFail = Math.max(...c.topFail.map((f) => f[1]));
  const causeTotal = c.causes.reduce((s, x) => s + x[1], 0);
  const maxDay = c.perDay ? Math.max(...c.perDay.map((d) => d[0] + d[1] + d[2])) : 0;

  return (
    <React.Fragment>
      <div className="coachhub-subhead">
        <div className="seg" role="tablist" aria-label="时间窗 · 周报">
          {["7", "30", "90"].map((w) => <button key={w} className={win === w ? "on" : ""} onClick={() => setWin(w)}>{w} 天</button>)}
        </div>
        <span className="meta">「周报」= 近 {win} 天的活动量,不是整个 Coach。</span>
      </div>

      <div key={win} className="coach-kpis">
        <CoachKpi label="reviews" value={c.reviews} />
        <CoachKpi label="正确率" value={c.accuracy} unit="%" />
        <CoachKpi label="新增错题" value={c.newMistakes} />
        <CoachKpi label="AI 成本" value={c.cost} prefix="$" />
      </div>

      <div className="coach-grid">
        <Card pad>
          <div className="card-head"><span className="card-icon"><Icon name="review" size={18} /></span><div className="card-title">评分分布</div><span className="meta" style={{ marginLeft: "auto" }}>{distTotal} 次</span></div>
          <div className="dist-bar">
            <span className="dist-seg tone-again" style={{ width: c.dist.again / distTotal * 100 + "%" }} />
            <span className="dist-seg tone-hard" style={{ width: c.dist.hard / distTotal * 100 + "%" }} />
            <span className="dist-seg tone-good" style={{ width: c.dist.good / distTotal * 100 + "%" }} />
          </div>
          <div className="dist-legend">
            <span><span className="dist-key tone-again" />不会 <b className="mono">{c.dist.again}</b></span>
            <span><span className="dist-key tone-hard" />模糊 <b className="mono">{c.dist.hard}</b></span>
            <span><span className="dist-key tone-good" />会了 <b className="mono">{c.dist.good}</b></span>
          </div>
        </Card>

        <Card pad>
          <div className="card-head"><span className="card-icon"><Icon name="bolt" size={18} /></span><div className="card-title">归因分布</div><span className="meta" style={{ marginLeft: "auto" }}>只读</span></div>
          <div className="cause-list">
            {c.causes.map(([name, n]) => (
              <div key={name} className="cause-row">
                <span className="cause-name">{name}</span>
                <div className="cause-track"><span style={{ width: n / causeTotal * 100 + "%" }} /></div>
                <span className="mono cause-n">{Math.round(n / causeTotal * 100)}%</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {c.perDay && (
        <React.Fragment>
          <SectionLabel>逐日复习量</SectionLabel>
          <Card pad>
            <div className="stack-chart">
              {c.perDay.map((d, i) => {
                const total = d[0] + d[1] + d[2];
                return (
                  <div key={i} className="stack-col">
                    <div className="stack-bars" style={{ height: 140 }}>
                      <span className="stack-seg tone-good" style={{ height: d[2] / maxDay * 140 + "px" }} title={"会了 " + d[2]} />
                      <span className="stack-seg tone-hard" style={{ height: d[1] / maxDay * 140 + "px" }} title={"模糊 " + d[1]} />
                      <span className="stack-seg tone-again" style={{ height: d[0] / maxDay * 140 + "px" }} title={"不会 " + d[0]} />
                    </div>
                    <span className="stack-x meta">{["一", "二", "三", "四", "五", "六", "日"][i]}</span>
                    <span className="stack-total mono">{total}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        </React.Fragment>
      )}

      <SectionLabel>失败排行 · 按知识点</SectionLabel>
      <Card pad>
        {c.topFail.map(([name, n, tag]) => (
          <button key={tag} className="fail-row" onClick={() => go("knowledge/" + tag)}>
            <span className="wenyan fail-name">{name}</span>
            <div className="fail-track"><span className="tone-again" style={{ width: n / maxFail * 100 + "%", display: "block", height: "100%", background: "var(--again)" }} /></div>
            <span className="mono fail-n">{n} 次</span>
            <Icon name="arrow" size={14} className="thread-arrow" />
          </button>
        ))}
      </Card>
    </React.Fragment>
  );
}

/* ── 复盘中枢外壳 ── 三视图分段切换 ── */
function CoachHub({ go = () => {}, ui = {} }) {
  const [view, setView] = React.useState(ui.coachView || "efficacy");
  React.useEffect(() => { if (ui.coachView) setView(ui.coachView); }, [ui.coachView]);
  // hub 内的 go:把姊妹面跳转改写成切 tab(校准诊断 ⟂ 成效趋势,同屏切换不离场)。
  const hubGo = (r) => {
    if (r === "calibration") setView("calibration");
    else if (r === "efficacy" || r === "coach") setView("efficacy");
    else go(r);
  };

  return (
    <div className="page view eff coachhub">
      <div className="page-head coachhub-head">
        <div className="eyebrow">COACH · 复盘中枢 · <span className="mono">{VIEW_QUERY[view]}</span></div>
        <div className="page-head-row">
          <h1 className="page-title serif">Coach 复盘中枢</h1>
          <div className="coachhub-tabs" role="tablist" aria-label="三个正交视图">
            {COACH_VIEWS.map((v) => (
              <button key={v.id} role="tab" aria-selected={view === v.id}
                      className={"coachhub-tab" + (view === v.id ? " on" : "")} onClick={() => setView(v.id)}>
                <Icon name={v.icon} size={15} />{v.label}
              </button>
            ))}
          </div>
        </div>
        <p className="page-lead">{VIEW_LEDE[view]}</p>
      </div>

      {view === "activity" && <CoachActivity go={hubGo} />}
      {view === "calibration" && <CalibrationView a={DATA.admin.calibration} go={hubGo} ui={ui} />}
      {view === "efficacy" && <EfficacyBody go={hubGo} ui={ui} embedded />}
    </div>
  );
}

window.CoachHub = CoachHub;
window.CoachActivity = CoachActivity;
