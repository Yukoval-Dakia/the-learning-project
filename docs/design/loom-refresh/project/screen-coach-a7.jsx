// Loom · A7 成效趋势面 — 纵向 delta.
// 相对自己 · 慢热期只信方向 · 退步如实呈现 · 开放题切自评(一等输入).
// states: ok · sparse(数据不足) · regress(全退步,demo).

const A7_BANDS = ["萌芽", "成长", "稳固", "精熟"];
const DIR_META = {
  up:   { label: "在涨",   icon: "arrowRight" },
  hold: { label: "持平",   icon: "arrowRight" },
  down: { label: "在退",   icon: "arrowRight" },
};

// sparkline of relative band-position across weeks
function TrendSpark({ series, dir }) {
  const n = series.length;
  const W = 168, H = 56, pad = 6;
  const x = (i) => pad + i * ((W - 2 * pad) / (n - 1));
  const y = (b) => H - pad - (b / 3) * (H - 2 * pad);
  const pts = series.map((b, i) => [x(i), y(b)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return (
    <div className={"trend-spark " + dir}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={"相对位置趋势 · " + DIR_META[dir].label}>
        {[0, 1, 2, 3].map((b) => <line key={b} className="axis" x1={pad} y1={y(b)} x2={W - pad} y2={y(b)} opacity={b === 0 ? 0.6 : 0.3} />)}
        <path className="ln" d={d} />
        {pts.map((p, i) => <circle key={i} className={"dot" + (i === n - 1 ? " last" : "")} cx={p[0]} cy={p[1]} r={i === n - 1 ? 4 : 3} />)}
      </svg>
      <div className="trend-spark-cap"><span>6 周前</span><span>现在</span></div>
      <div className="trend-spark-bands">纵轴 · {A7_BANDS.join(" ‹ ")}</div>
    </div>
  );
}

function TrendRow({ a, go }) {
  return (
    <div className="trend-row">
      <div className="trend-main">
        <div className="trend-top">
          <span className="trend-area wenyan">{a.area}</span>
          <span className={"trend-dir " + a.dir}>
            {a.dir === "up" ? "↑ 相对在涨" : a.dir === "down" ? "↓ 相对在退" : "→ 持平"}
          </span>
          {a.lowConf && <span className="trend-lowtag">低置信</span>}
          <span className="trend-conf">置信 {a.conf}</span>
        </div>
        <div className="trend-delta">{a.delta}</div>
        <p className="trend-note">{a.note}</p>
        <div className="trend-foot">
          <button className="ho-linkbtn" onClick={() => go("knowledge/" + a.id)}><Icon name="knowledge" size={13} />看这块的图谱</button>
          <button className="ho-linkbtn" onClick={() => go("events")}><Icon name="history" size={13} />追溯作答</button>
        </div>
      </div>
      <TrendSpark series={a.series} dir={a.dir} />
    </div>
  );
}

// open-ended subject → owner self-assessment trend (first-class, active check-in)
function SelfAssessRow({ a, go }) {
  const [series, setSeries] = React.useState(a.selfSeries);
  const [checked, setChecked] = React.useState(null);
  const labels = ["6周前", "5周", "4周", "3周", "2周", "本周"];
  const mark = (v) => { setChecked(v); setSeries((s) => { const n = [...s]; n[n.length - 1] = v; return n; }); };
  return (
    <div className="trend-row trend-self">
      <div className="trend-main">
        <div className="trend-top">
          <span className="trend-area wenyan">{a.area}</span>
          <span className="trend-self-tag"><Icon name="today" size={12} />自评轨</span>
          <span className="trend-conf">客观信号不可信</span>
        </div>
        <p className="trend-self-reason">{a.reason} {a.selfNote}</p>
        <div className="trend-selfseries">
          {series.map((v, i) => (
            <div key={i} className="trend-selftick">
              <span className={"trend-selfmark " + (v || "none")}>{v || "—"}</span>
              <span className="trend-selftick-x">{labels[i]}</span>
            </div>
          ))}
        </div>
        {checked ? (
          <div className="selfcheck-done"><Icon name="check" size={14} />记下了 —— 你的感受是一等信号，会按时间排进这条自评轨。</div>
        ) : (
          <div className="selfcheck">
            <span className="selfcheck-l">这块这周你感觉怎么样？</span>
            {["进步", "持平", "退步"].map((v) => (
              <button key={v} className={"selfcheck-btn " + v} onClick={() => mark(v)}>{v}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TrendPanel({ go, mode = "normal" }) {
  // 数据不足 (early) — no fake rising line
  if (mode === "sparse") {
    return (
      <div className="trend-sparse">
        <Icon name="clock" size={20} />
        <div>
          <div className="trend-sparse-t">还看不出趋势</div>
          <div className="trend-sparse-s">成效是「相对过去的你」—— 现在的时间序列还太短，做不出可信的 delta。再练一两周，这里会长出每块的涨/保持/退。我不会先画一条假的上升线。</div>
          <div className="trend-sparse-flat">
            <svg viewBox="0 0 120 32"><path className="fl" d="M4 16 H116" /></svg>
            <span className="trend-sparse-flat-l">数据不足 · 暂不出趋势</span>
          </div>
        </div>
      </div>
    );
  }

  const obj = mode === "regress"
    ? COACH_A7.objective.map((a) => ({ ...a, dir: "down", lowConf: true }))
    : COACH_A7.objective;

  return (
    <React.Fragment>
      <SectionLabel count={obj.length}>客观成效 · 硬轨够热</SectionLabel>
      {obj.map((a) => <TrendRow key={a.id} a={a} go={go} />)}

      <SectionLabel count={COACH_A7.openEnded.length}>自评成效 · 开放题</SectionLabel>
      {COACH_A7.openEnded.map((a) => <SelfAssessRow key={a.id} a={a} go={go} />)}
    </React.Fragment>
  );
}

Object.assign(window, { TrendPanel, TrendRow, SelfAssessRow, TrendSpark });
