// Loom · 成效趋势面 — 轨迹可视化引擎.
// 三种可切换形态(owner 选):逐 KC 折线行 / 小倍数网格 / 河流带 streamgraph。
// 全部共享一套几何 + 不确定带(uncertainty band):n=1 慢热下把噪声画出来,
// 低置信 → 带宽盖过线,绝不画成笃定的细箭头。
// ────────────────────────────────────────────────────────────────────────

const EFF_BANDS = ["萌芽", "成长", "稳固", "精熟"]; // p(L) 四分档:仅作相对参照,非精确分

// 不确定带半宽(p 单位)。低置信 / 早点 → 更宽。insufficient(≤2点)带宽极大。
function effBandHalf(conf, i, n) {
  if (n <= 2) return 0.22;
  const base = conf === "firm" ? 0.045 : conf === "mid" ? 0.085 : 0.155;
  const early = 1 + 0.55 * (1 - i / (n - 1)); // 越早越宽
  return Math.min(0.26, base * early);
}

// 轨迹几何:给定 points(0..1)、confidence、画布,产出线 path / 带 path / 点坐标。
function effTrajGeom(points, conf, W, H, padX, padY) {
  const n = points.length;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const x = (i) => (n === 1 ? W / 2 : padX + (i * (W - 2 * padX)) / (n - 1));
  const y = (p) => H - padY - clamp01(p) * (H - 2 * padY);
  const pts = points.map((p, i) => ({ x: x(i), y: y(p), p, i, half: effBandHalf(conf, i, n) }));
  const linePath = pts.map((q, i) => (i ? "L" : "M") + q.x.toFixed(1) + " " + q.y.toFixed(1)).join(" ");
  // band: 上沿正走、下沿回走,闭合
  const top = pts.map((q) => [q.x, y(q.p + q.half)]);
  const bot = pts.map((q) => [q.x, y(q.p - q.half)]);
  let bandPath = "";
  if (n >= 2) {
    bandPath =
      "M" + top.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") +
      " L" + bot.reverse().map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") + " Z";
  }
  return { pts, linePath, bandPath, x, y, n };
}

// 核心轨迹 SVG —— 行视图 / 小倍数共用。
function EffTrajectory({ kc, w = 184, h = 64, padX = 8, padY = 9, showBands = false, compact = false }) {
  const dir = EFF_DIR[kc.direction];
  const conf = kc.confidence;
  const g = effTrajGeom(kc.points, conf, w, h, padX, padY);
  const tender = conf === "low" || kc.direction === "insufficient";
  const gid = "eg_" + kc.id + (compact ? "_c" : "");
  const last = g.pts[g.pts.length - 1];

  return (
    <svg className={"eff-traj is-" + kc.direction + (tender ? " is-tender" : "")} viewBox={`0 0 ${w} ${h}`}
         preserveAspectRatio="none" role="img" aria-label={kc.name + " · " + dir.label}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={dir.base} stopOpacity={tender ? 0.16 : 0.2} />
          <stop offset="100%" stopColor={dir.base} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* band 参考线 */}
      {showBands && [0, 0.5, 1].map((p) => (
        <line key={p} className="eff-traj-grid" x1={padX} y1={g.y(p)} x2={w - padX} y2={g.y(p)} />
      ))}
      {/* 不确定带 */}
      {g.n >= 2 && <path className="eff-traj-band" d={g.bandPath} fill={dir.soft} />}
      {/* 单点态:垂直误差条 */}
      {g.n === 1 && (
        <line className="eff-traj-errbar" x1={last.x} y1={g.y(Math.min(1, last.p + last.half))}
              x2={last.x} y2={g.y(Math.max(0, last.p - last.half))} stroke={dir.base} />
      )}
      <path className="eff-traj-area" d={g.n >= 2 ? g.linePath + ` L${last.x} ${h} L${g.pts[0].x} ${h} Z` : ""} fill={`url(#${gid})`} />
      {g.n >= 2 && <path className="eff-traj-line" d={g.linePath} stroke={dir.base} />}
      {/* 端点 */}
      {g.pts.map((q, i) => (
        <circle key={i} className={"eff-traj-dot" + (i === g.n - 1 ? " last" : "")} cx={q.x} cy={q.y}
                r={i === g.n - 1 ? 3.4 : 2} fill={i === g.n - 1 ? dir.base : "var(--paper-raised)"} stroke={dir.base} />
      ))}
    </svg>
  );
}

// ── 形态 1:逐 KC 折线行 ─────────────────────────────────────
function EffSparkRows({ series, go, showSource }) {
  return (
    <div className="eff-rows">
      {series.map((kc) => {
        const dir = EFF_DIR[kc.direction];
        const tender = kc.confidence === "low" || kc.direction === "insufficient";
        return (
          <div key={kc.id} className={"eff-row is-" + kc.direction + (tender ? " is-tender" : "")}>
            <div className="eff-row-main">
              <div className="eff-row-top">
                <span className="eff-row-name wenyan">{kc.name}</span>
                {kc.track && <span className="eff-row-track">{kc.track}</span>}
                <span className={"eff-dirchip tone-" + dir.tone}>{dir.glyph} 相对{dir.label}</span>
                <EffConfTag kc={kc} />
              </div>
              <div className="eff-row-delta">{kc.delta}</div>
              <p className="eff-row-note">{kc.note}</p>
              {showSource && kc.direction !== "insufficient" && <EffSourceBar source={kc.source} />}
              <div className="eff-row-foot">
                <button className="eff-linkbtn" onClick={() => go && go("knowledge/" + kc.id)}><Icon name="knowledge" size={13} />看图谱</button>
                <button className="eff-linkbtn" onClick={() => go && go("events")}><Icon name="history" size={13} />追溯 {kc.span_evidence} 次作答</button>
              </div>
            </div>
            <div className="eff-row-viz">
              <EffTrajectory kc={kc} w={188} h={66} showBands />
              <div className="eff-row-axis">
                <span className="mono">{kc.points.length === 1 ? "首次" : "起"}</span>
                <span className="eff-row-axis-bands">{EFF_BANDS.join(" ‹ ")}</span>
                <span className="mono">现在</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 形态 2:小倍数网格 ───────────────────────────────────────
function EffSmallMultiples({ series, go, showSource }) {
  return (
    <div className="eff-grid">
      {series.map((kc) => {
        const dir = EFF_DIR[kc.direction];
        const tender = kc.confidence === "low" || kc.direction === "insufficient";
        return (
          <button key={kc.id} className={"eff-cell is-" + kc.direction + (tender ? " is-tender" : "")}
                  onClick={() => go && go("knowledge/" + kc.id)}>
            <div className="eff-cell-h">
              <span className="eff-cell-name wenyan">{kc.name}</span>
              <span className={"eff-cell-glyph tone-" + dir.tone}>{dir.glyph}</span>
            </div>
            <EffTrajectory kc={kc} w={150} h={46} padY={7} compact />
            <div className="eff-cell-f">
              <span className={"eff-cell-dir tone-" + dir.tone}>{dir.label}</span>
              <EffConfTag kc={kc} mini />
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── 形态 3:河流带 streamgraph(相对位置随时间漂移)───────────
function effResample(points, steps) {
  const n = points.length;
  if (n === 1) return Array.from({ length: steps }, () => points[0]);
  const out = [];
  for (let s = 0; s < steps; s++) {
    const t = (s / (steps - 1)) * (n - 1);
    const i = Math.floor(t), f = t - i;
    out.push(i + 1 < n ? points[i] * (1 - f) + points[i + 1] * f : points[n - 1]);
  }
  return out;
}

function EffStreamFlow({ series, go }) {
  const W = 1000, H = 360, padX = 64, padT = 18, padB = 34, STEPS = 7;
  const x = (s) => padX + (s * (W - padX - 20)) / (STEPS - 1);
  const y = (p) => padT + (1 - p) * (H - padT - padB);
  // 当前 p(末点)降序 → 上方更稳
  const ranked = [...series].sort((a, b) => b.points[b.points.length - 1] - a.points[a.points.length - 1]);
  return (
    <div className="eff-stream">
      <svg viewBox={`0 0 ${W} ${H}`} className="eff-stream-svg" role="img" aria-label="相对位置随时间的带状漂移">
        {/* band 参考线 */}
        {[0, 1, 2, 3].map((b) => {
          const p = b / 3;
          return (
            <g key={b}>
              <line className="eff-stream-grid" x1={padX} y1={y(p)} x2={W - 20} y2={y(p)} />
              <text className="eff-stream-bandlbl" x={padX - 10} y={y(p) + 4} textAnchor="end">{EFF_BANDS[b]}</text>
            </g>
          );
        })}
        {ranked.map((kc) => {
          const dir = EFF_DIR[kc.direction];
          const tender = kc.confidence === "low" || kc.direction === "insufficient";
          const rs = effResample(kc.points, STEPS);
          const th = (kc.confidence === "firm" ? 9 : kc.confidence === "mid" ? 6.5 : 4) ; // 厚度=置信
          const top = rs.map((p, s) => [x(s), y(Math.min(1, p + th / (H - padT - padB)))]);
          const bot = rs.map((p, s) => [x(s), y(Math.max(0, p - th / (H - padT - padB)))]);
          const ribbon =
            "M" + top.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") +
            " L" + [...bot].reverse().map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") + " Z";
          const mid = rs.map((p, s) => (s ? "L" : "M") + x(s).toFixed(1) + " " + y(p).toFixed(1)).join(" ");
          const lastP = rs[rs.length - 1];
          return (
            <g key={kc.id} className={"eff-ribbon is-" + kc.direction + (tender ? " is-tender" : "")}
               onClick={() => go && go("knowledge/" + kc.id)}>
              <path className="eff-ribbon-fill" d={ribbon} fill={dir.base} />
              <path className="eff-ribbon-mid" d={mid} stroke={dir.base} />
              <circle cx={x(STEPS - 1)} cy={y(lastP)} r="4" fill={dir.base} stroke="var(--paper-raised)" />
              <text className="eff-ribbon-lbl wenyan" x={x(STEPS - 1) + 9} y={y(lastP) + 4}>{kc.name}</text>
            </g>
          );
        })}
        {/* x 轴:attempt 序(近 6 周) */}
        <line className="eff-stream-axis" x1={padX} y1={H - padB + 8} x2={W - 20} y2={H - padB + 8} />
        <text className="eff-stream-x" x={padX} y={H - 8} textAnchor="start">6 周前</text>
        <text className="eff-stream-x" x={W - 20} y={H - 8} textAnchor="end">现在 · 按 attempt 序</text>
      </svg>
      <p className="eff-stream-cap meta">每条带 = 一个 KC 的相对位置随时间漂移;<b>带越厚 = 证据越足</b>,细而淡的带是还嫩、别当真走向的。向上爬 = 相对自己在涨。</p>
    </div>
  );
}

// ── 置信标记(⑥:低置信显著降级)───────────────────────────
function EffConfTag({ kc, mini }) {
  if (kc.direction === "insufficient") {
    return <span className={"eff-conf is-insf" + (mini ? " mini" : "")}>{mini ? "不足" : "数据不足 · 别断方向"}</span>;
  }
  if (kc.confidence === "low") {
    return <span className={"eff-conf is-low" + (mini ? " mini" : "")} title="噪声极大,只信相对方向">{mini ? "还嫩" : "低置信 · 别当真"}</span>;
  }
  if (kc.confidence === "mid") {
    return <span className={"eff-conf is-mid" + (mini ? " mini" : "")}>{mini ? "够看" : "方向可信 · 幅度别当真"}</span>;
  }
  return <span className={"eff-conf is-firm" + (mini ? " mini" : "")}>{mini ? "够硬" : "够硬 · " + kc.span_evidence + " 次"}</span>;
}

// 来源二态:firm-up(真练出来)vs prior-echo(先验回声)。owner 留白3。
function EffSourceBar({ source }) {
  const firm = Math.round(source.firm * 100);
  return (
    <div className="eff-source" title="这条变化里,多少是你真练出来的、多少是模型先验的回声">
      <span className="eff-source-l meta">来源</span>
      <span className="eff-source-bar">
        <span className="eff-source-firm" style={{ width: firm + "%" }} />
        <span className="eff-source-echo" style={{ width: 100 - firm + "%" }} />
      </span>
      <span className="eff-source-key meta"><i className="k-firm" />真练 · <i className="k-echo" />先验回声</span>
    </div>
  );
}

Object.assign(window, {
  EFF_BANDS, EffTrajectory, EffSparkRows, EffSmallMultiples, EffStreamFlow,
  EffConfTag, EffSourceBar, effTrajGeom,
});
