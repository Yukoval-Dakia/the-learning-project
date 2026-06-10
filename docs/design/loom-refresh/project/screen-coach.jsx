// Loom · /coach analytics (I) — read-only. 3-tier rating dist.
function CoachKpi({ label, value, unit, prefix, active }) {
  const v = useCountUp(value, { start: active, dur: 900 });
  const shown = Number.isInteger(value) ? Math.round(v) : v.toFixed(2);
  return <div className="coach-kpi"><div className="coach-kpi-n serif tnum">{prefix}{shown}<span className="coach-kpi-u">{unit}</span></div><div className="coach-kpi-l meta">{label}</div></div>;
}

function ScreenCoach({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [win, setWin] = React.useState("7");
  const [active, setActive] = React.useState(false);
  React.useEffect(() => { setActive(false); const id = requestAnimationFrame(() => setActive(true)); return () => cancelAnimationFrame(id); }, [win]);
  const c = DATA.coach[win];
  const distTotal = c.dist.again + c.dist.hard + c.dist.good;
  const maxFail = Math.max(...c.topFail.map((f) => f[1]));
  const causeTotal = c.causes.reduce((s, x) => s + x[1], 0);
  const maxDay = c.perDay ? Math.max(...c.perDay.map((d) => d[0] + d[1] + d[2])) : 0;

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">COACH · 只读分析 · 近 {win} 天</div>
        <div className="page-head-row">
          <h1 className="page-title serif">Coach 周报</h1>
          <div className="seg">{["7", "30", "90"].map((w) => <button key={w} className={win === w ? "on" : ""} onClick={() => setWin(w)}>{w} 天</button>)}</div>
        </div>
        <p className="page-lead">复盘最近的复习与错题：评分构成、逐日节奏、薄弱知识点与归因分布。只读，不改数据。</p>
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="分析数据加载失败。"
        skeleton={<Card pad><SkLines rows={4} /></Card>}
        empty={<EmptyState icon="target" title="窗口内无数据" text="该时间窗内还没有复习记录。" />}>
        <div key={win} className="coach-kpis stagger">
          <CoachKpi label="reviews" value={c.reviews} active={active} />
          <CoachKpi label="正确率" value={c.accuracy} unit="%" active={active} />
          <CoachKpi label="新增错题" value={c.newMistakes} active={active} />
          <CoachKpi label="AI 成本" value={c.cost} prefix="$" active={active} />
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
          <>
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
                      <span className="stack-x meta">{["一","二","三","四","五","六","日"][i]}</span>
                      <span className="stack-total mono">{total}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </>
        )}

        <SectionLabel>失败排行 · 按知识点</SectionLabel>
        <Card pad>
          {c.topFail.map(([name, n, tag]) => (
            <button key={tag} className="fail-row" onClick={() => go("knowledge/" + tag)}>
              <span className="wenyan fail-name">{name}</span>
              <div className="fail-track"><span className="tone-again" style={{ width: n / maxFail * 100 + "%" }} /></div>
              <span className="mono fail-n">{n} 次</span>
              <Icon name="arrow" size={14} className="thread-arrow" />
            </button>
          ))}
        </Card>
      </Stateful>
    </div>
  );
}
window.ScreenCoach = ScreenCoach;
