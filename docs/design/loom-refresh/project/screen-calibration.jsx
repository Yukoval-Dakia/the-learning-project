// Loom · /admin/calibration (校准成熟度) — observability, read-only.
// GET /api/observability/calibration-maturity · adr-0035 (慢热期只信相对排序)
// 语义约束:冷启 / 低置信知识点绝不显示成精确分数。成熟度 = 可信/不可信 + 相对排序(θ̂ SE),不是掌握度%。

// tier 派生:blind(冷启盲区, evidence=0, 从没练过) / warming(渐稳, 有证据未 firm) / firm(可信)
function calTier(k) {
  if (k.evidence === 0) return "blind";
  return k.cold_start ? "warming" : "firm";
}
const CAL_TIER = {
  firm:    { label: "可信", tone: "good",    ink: "var(--good-ink)",  line: "var(--good-line)",  soft: "var(--good-soft)" },
  warming: { label: "渐稳", tone: "hard",    ink: "var(--hard-ink)",  line: "var(--hard-line)",  soft: "var(--hard-soft)" },
  blind:   { label: "冷启", tone: "neutral", ink: "var(--ink-4)",     line: "var(--line)",       soft: "var(--paper-sunk)" },
};

function CalibrationView({ a, go, ui = {} }) {
  const [sort, setSort] = React.useState({ key: "se", dir: 1 }); // 默认按 θ̂ SE 升序 → 最可信在上

  const rows = a.kcs.map((k) => ({ ...k, tier: calTier(k) }));
  const counts = {
    firm:    rows.filter((r) => r.tier === "firm").length,
    warming: rows.filter((r) => r.tier === "warming").length,
    blind:   rows.filter((r) => r.tier === "blind").length,
  };
  const blind = rows.filter((r) => r.tier === "blind");
  const tierRank = { firm: 0, warming: 1, blind: 2 };

  const sorted = [...rows].sort((x, y) => {
    let d = 0;
    if (sort.key === "name") d = x.name.localeCompare(y.name, "zh");
    else if (sort.key === "evidence") d = x.evidence - y.evidence;
    else if (sort.key === "se") d = x.se - y.se;
    else if (sort.key === "tier") d = tierRank[x.tier] - tierRank[y.tier] || x.se - y.se;
    return d * sort.dir;
  });
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "evidence" ? -1 : 1 }));
  const caret = (key) => (sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "");

  const pct = Math.round(a.pct_firm * 100);
  // θ̂ SE 分布带:se 1.0(冷启,左)→ se 低(可信,右)。x = 越右越可信。
  const SE_LO = 0.18;
  const seX = (se) => Math.max(2, Math.min(98, ((1.0 - se) / (1.0 - SE_LO)) * 100));
  const buckets = {};
  const dots = rows.map((k) => {
    const key = k.se.toFixed(2);
    const lane = (buckets[key] = (buckets[key] || 0) + 1) - 1;
    return { ...k, x: seX(k.se), lane };
  });
  const medianX = seX(a.median_theta_se);

  return (
    <div className="cal">
      <div className="admin-h">
        <h2 className="serif">校准成熟度</h2>
        <span className="meta mono">calibration-maturity · adr-0035 · n=1</span>
        <span className="cal-sampled meta mono">采样于 今天 03:14 · 随作答更新</span>
      </div>
      <p className="cal-lede">
        n=1 下每个知识点都从<b>冷启</b>开始 —— θ̂ 估计还不可信。随你持续作答,它们逐个 <b>firm up(变可信)</b>。
        这屏让你<b>看着数据变准</b>:慢热期只看「可信 / 不可信 + 相对排序」,不看精确分数。
      </p>

      {/* ── #41 profile 级重算徽章 · 在本设备核对概览算术 ── */}
      <RcMaturityBadge a={a} mode={ui.obVerify === "drift" ? "drift" : "match"} />

      {/* ── A · firm-up 概览 ───────────────────────────────── */}
      <div className="cal-overview">
        <Card pad className="cal-meter">
          <div className="cal-meter-fig">
            <span className="cal-meter-num serif">{pct}<span className="cal-meter-pct">%</span></span>
            <span className="cal-meter-cap meta">知识图 firm 占比</span>
          </div>
          <div className="cal-meter-side">
            <div className="cal-meter-line"><b className="mono">{a.firm_count}</b> / {a.total_kcs} 知识点已可信</div>
            <div className="cal-meter-line meta">中位 θ̂ SE <b className="mono">{a.median_theta_se.toFixed(2)}</b> · 越小越可信</div>
            <div className="cal-firmbar">
              <span className="cal-firmbar-seg t-firm"  style={{ width: counts.firm / a.total_kcs * 100 + "%" }} title={"可信 " + counts.firm} />
              <span className="cal-firmbar-seg t-warm"  style={{ width: counts.warming / a.total_kcs * 100 + "%" }} title={"渐稳 " + counts.warming} />
              <span className="cal-firmbar-seg t-blind" style={{ width: counts.blind / a.total_kcs * 100 + "%" }} title={"冷启盲区 " + counts.blind} />
            </div>
            <div className="cal-legend">
              <span><i className="t-firm" />可信 <b className="mono">{counts.firm}</b></span>
              <span><i className="t-warm" />渐稳 <b className="mono">{counts.warming}</b></span>
              <span><i className="t-blind" />盲区 <b className="mono">{counts.blind}</b></span>
            </div>
          </div>
        </Card>

        <div className="cal-stats">
          {[
            ["total_kcs", a.total_kcs, "知识点"],
            ["firm", a.firm_count, "可信 firm"],
            ["cold", a.cold_start_count, "冷启 cold-start"],
            ["blind", counts.blind, "盲区 · 从没练过"],
          ].map(([k, v, lbl]) => (
            <div key={k} className={"cal-stat is-" + k}>
              <span className="cal-stat-num mono">{v}</span>
              <span className="cal-stat-lbl meta">{lbl}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── B · 冷启盲区(actionable)──────────────────────── */}
      {blind.length > 0 && (
        <Card pad className="cal-blind">
          <div className="cal-blind-head">
            <span className="cal-blind-icon"><Icon name="eye" size={16} /></span>
            <div>
              <div className="cal-blind-title">冷启盲区 · <b className="mono">{blind.length}</b> 个知识点从没练过</div>
              <div className="cal-blind-sub meta">evidence = 0 → θ̂ 一直停在冷启先验(se ≈ 1.00)。练它一次就能开始 firm up。</div>
            </div>
          </div>
          <div className="cal-blind-list">
            {blind.map((k) => (
              <div key={k.id} className="cal-blind-chip">
                <span className="cal-blind-name">{k.name}</span>
                {k.track && <span className="cal-blind-track meta">{k.track}</span>}
                <span className="cal-blind-unknown mono">— 未知</span>
                <Btn size="sm" variant="ghost" iconEnd="arrowRight" onClick={() => go("knowledge/" + k.id)}>去练</Btn>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── C · θ̂ SE 分布 · 相对排序 ──────────────────────── */}
      <Card pad className="cal-strip-card">
        <div className="cal-card-h">
          <div className="card-title">θ̂ 标准误分布 · 相对排序</div>
          <span className="meta">每个点一个圆;越靠右标准误越小、越可信。慢热期只信这条相对次序(adr-0035),不读精确分数。</span>
        </div>
        <div className="cal-strip">
          <div className="cal-strip-track">
            <span className="cal-strip-median" style={{ left: medianX + "%" }}>
              <span className="cal-strip-median-lbl mono">中位 {a.median_theta_se.toFixed(2)}</span>
            </span>
            {dots.map((d) => (
              <span key={d.id}
                className={"cal-dot is-" + d.tier}
                style={{ left: d.x + "%", bottom: 14 + d.lane * 19 + "px" }}
                title={d.name + " · se " + d.se.toFixed(2) + (d.evidence === 0 ? " · 冷启" : "")}>
                <span className="cal-dot-lbl">{d.name}</span>
              </span>
            ))}
          </div>
          <div className="cal-strip-axis">
            <span className="mono">se ≈ 1.00</span>
            <span className="cal-strip-axis-mid meta">不可信 ← 相对排序 → 可信</span>
            <span className="mono">se 低</span>
          </div>
        </div>
      </Card>

      {/* ── D · 逐知识点成熟度 ledger ─────────────────────── */}
      <div className="cal-table-h">
        <div className="card-title">逐知识点成熟度</div>
        <span className="meta mono">{rows.length} kcs · 点表头排序</span>
      </div>
      <table className="adm-table cal-table">
        <thead>
          <tr>
            <th className="cal-th" onClick={() => onSort("name")}>知识点{caret("name")}</th>
            <th>track</th>
            <th className="num cal-th" onClick={() => onSort("evidence")}>证据{caret("evidence")}</th>
            <th className="cal-th" onClick={() => onSort("se")}>θ̂ SE · 可信度{caret("se")}</th>
            <th className="cal-th" onClick={() => onSort("tier")}>成熟度{caret("tier")}</th>
            <th>题目置信度</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((k) => {
            const m = CAL_TIER[k.tier];
            return (
              <tr key={k.id} className={"cal-row is-" + k.tier}>
                <td><span className="cal-name">{k.name}</span> <code className="cal-id">{k.id}</code></td>
                <td>{k.track ? <span className="cal-track">{k.track}</span> : <span className="meta">—</span>}</td>
                <td className="num mono">
                  {k.evidence === 0
                    ? <span className="cal-ev0">0 <span className="meta">从未作答</span></span>
                    : k.evidence}
                </td>
                <td>
                  <div className="cal-se">
                    <span className="cal-se-num mono">{k.evidence === 0 ? "≈1.00" : k.se.toFixed(2)}</span>
                    <span className="cal-se-bar">
                      <span className={"cal-se-fill is-" + k.tier} style={{ width: (1 - (k.se - SE_LO) / (1 - SE_LO)) * 100 + "%" }} />
                    </span>
                  </div>
                </td>
                <td>
                  <span className={"badge tone-" + m.tone}>{m.label}</span>
                  {k.tier === "blind" && <span className="cal-blind-tag meta">盲区</span>}
                </td>
                <td>
                  {k.tier === "firm" && k.confidence != null
                    ? <span className="cal-conf mono">{Math.round(k.confidence * 100)}%</span>
                    : <span className="cal-conf-na meta" title="证据不足,不给精确分数">— 数据不足</span>}
                </td>
                <td className="num">
                  {k.tier !== "firm" && (
                    <Btn size="sm" variant="ghost" iconEnd="arrowRight" onClick={() => go("knowledge/" + k.id)}>去练</Btn>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="cal-foot meta">
        口径:成熟度只表「可信 / 不可信 + 相对次序」。<b>题目置信度</b>仅在知识点 firm 后给出;证据不足时显示「— 数据不足」,绝不补一个看起来精确的分数。
      </p>
    </div>
  );
}
window.CalibrationView = CalibrationView;
