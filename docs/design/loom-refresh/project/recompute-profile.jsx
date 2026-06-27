// Loom · #41 Reproducible Diagnostic Profile — verify layer.
// 在本设备、即时、离线地从原始证据账本重导诊断画像的每个数字,
// 并核对它与服务端是否逐位相等。只读,绝不改数据。
//
// 诚实边界(别让文案过度承诺):这里验证的是每 KC 的「显示算术」——
// p̂ 掌握点 / lo·hi 区间 / SE —— 从该 KC 的 succ/fail/难度锚用与服务端
// 同一份数学重导。它【不】重跑整条管线:不独立重算难度锚的 DB 聚合,
// 不重跑 AI 判分。诚实的不确定性(宽带 / 低置信 / 未测)仍是一等公民;
// 在宽带低置信 KC 上 verified ✓ 意味「这个诚实的宽带本身可重导」,
// 不是「现在它可信了」。

/* ── 重导数学 · 与服务端逐位一致 ───────────────────────────────
   Beta–binomial,难度锚作先验。先验强度 κ=2,带半宽 z=1.5。
     先验  Beta(κ·b, κ·(1−b))           b = 难度锚 → 先验均值
     后验  Beta(κ·b + s, κ·(1−b) + f)    s 答对 · f 答错
     p̂ = θ̂ = 后验均值     SE = √后验方差     precision = 1/方差
     lo/hi = clamp(p̂ ∓ z·SE, 0, 1)
   纯函数 · 无网络 · 无随机 —— 同一账本永远得同一组数。 */
const RC_KAPPA = 2, RC_Z = 1.5;
function rcClamp01(x) { return Math.max(0, Math.min(1, x)); }
function rcRound2(x) { return Math.round(x * 100) / 100; }

function recomputeKC(L) {
  if (!L || (L.s + L.f) === 0) return { untested: true, evidence_count: 0 };
  const s = L.s, f = L.f, n = s + f;
  const a0 = RC_KAPPA * L.b, b0 = RC_KAPPA * (1 - L.b);
  const a = a0 + s, b = b0 + f;
  const mean = a / (a + b);
  const varr = (a * b) / ((a + b) * (a + b) * (a + b + 1));
  const se = Math.sqrt(varr);
  return {
    untested: false,
    evidence_count: n,
    s: s, f: f, b: L.b,
    theta_hat: rcRound2(mean),
    p_l: rcRound2(mean),
    mastery_lo: rcRound2(rcClamp01(mean - RC_Z * se)),
    mastery_hi: rcRound2(rcClamp01(mean + RC_Z * se)),
    se: rcRound2(se),
    theta_precision: rcRound2(1 / varr),
    low_confidence: n < 3 || se > 0.20,
  };
}

// 逐字段比对 server(显示值) vs device(重导值)。返回每个不符的字段。
const RC_CMP_FIELDS = [
  ["p_l", "p̂ 掌握点"],
  ["mastery_lo", "区间下界"],
  ["mastery_hi", "区间上界"],
  ["se", "SE"],
];
function cmpKC(server, device) {
  const diffs = [];
  RC_CMP_FIELDS.forEach(([f, label]) => {
    if (server[f] !== device[f]) diffs.push({ field: f, label, server: server[f], device: device[f] });
  });
  return { match: diffs.length === 0, diffs };
}

const rcFmt = (v) => (v == null ? "—" : v.toFixed(2));

/* ── 验证状态机 · A 未验证 → B 重算中 → C 已验证 ✓ | D 不符 ✗ ──
   离线 + 近即时:B 设计成「觉得是瞬时」的一闪,而非转圈等待。
   auto = 让「已验证 ✓」成静息态(打开即跑) · 显式 tap 也可。 */
function useRecompute({ auto, mode, runMs = 540 }) {
  const [state, setState] = React.useState(auto ? "running" : "idle");
  const [ranAt, setRanAt] = React.useState(null);
  const timer = React.useRef(null);
  const run = React.useCallback(() => {
    clearTimeout(timer.current);
    setState("running");
    timer.current = setTimeout(() => {
      setState(mode === "drift" ? "drift" : "match");
      setRanAt(Date.now());
    }, runMs);
  }, [mode, runMs]);
  React.useEffect(() => {
    if (auto) run();
    else { setState("idle"); setRanAt(null); }
    return () => clearTimeout(timer.current);
  }, [auto, mode, run]);
  return { state, run, ranAt };
}

/* ── 离线芯片 · 强调「纯设备端」 ─────────────────────────────── */
function RcOffline() {
  return (
    <span className="rc-offline" title="纯设备端重导 · 无需联网">
      <Icon name="bolt" size={11} />离线 · 本地
    </span>
  );
}

/* ── per-KC 小指示 · ✓ 逐位相等 / ✗ 不符 / 无可比 ──────────── */
function RcKcChip({ state, cmp }) {
  if (state === "idle" || state === "running") return null;
  if (cmp && cmp.na) return <span className="rc-chip rc-na" title="未测 —— 没有数字可重导">无数字可验</span>;
  if (cmp && cmp.match === false) {
    return <span className="rc-chip rc-x"><Icon name="alert" size={11} />重导不符</span>;
  }
  return <span className="rc-chip rc-ok"><Icon name="check" size={11} />已重导</span>;
}

/* ── 诚实边界脚注 ─────────────────────────────────────────── */
function RcBoundaryNote() {
  return (
    <div className="rc-boundary">
      <Icon name="lock" size={13} />
      <span>
        重算<b>只读</b>,不改任何数据。它在本设备从你的 succ / fail / 难度锚,
        用与服务端<b>同一份</b>数学重导每个显示数字(p̂ 点 · 区间 · SE)并逐位核对。
        它<b>不</b>重跑整条管线 —— 不重算难度锚的库内聚合、不重跑 AI 判分。
        宽区间 / 低置信 / 未测是诚实的特性:verified ✓ 表示「这个宽带本身可重导」,不表示「现在它更准了」。
      </span>
    </div>
  );
}

/* ── C 状态 · 逐位详情(账本 → 重导值)─────────────────────── */
function RcLedgerTable({ rows }) {
  return (
    <div className="rc-ledger">
      <div className="rc-ledger-head">
        <span>知识点</span>
        <span className="rc-num">账本 succ/fail · 锚</span>
        <span className="rc-num">p̂ 点</span>
        <span className="rc-num">可能区间</span>
        <span className="rc-num">SE</span>
        <span className="rc-eq">核对</span>
      </div>
      {rows.filter((r) => !r.rc.untested).map((r) => (
        <div key={r.k.id} className="rc-ledger-row">
          <span className="rc-ledger-name">{r.k.name}</span>
          <span className="rc-num mono">{r.rc.s}/{r.rc.f} · {rcFmt(r.rc.b)}</span>
          <span className="rc-num mono">{rcFmt(r.rc.p_l)}</span>
          <span className="rc-num mono">{rcFmt(r.rc.mastery_lo)}–{rcFmt(r.rc.mastery_hi)}</span>
          <span className="rc-num mono">{rcFmt(r.rc.se)}</span>
          <span className="rc-eq">
            {r.cmp.match
              ? <span className="rc-eq-ok"><Icon name="check" size={12} />逐位</span>
              : <span className="rc-eq-x"><Icon name="alert" size={12} />不符</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── D 状态 · 不符详情 · 可读、诚实、不无谓惊慌 ───────────── */
function RcDriftDetail({ row, otherCount }) {
  if (!row) return null;
  return (
    <div className="rc-drift">
      <div className="rc-drift-head">
        <span className="rc-drift-kc">{row.k.name}</span>
        <span className="rc-drift-tag">此处记录不同步</span>
      </div>
      <div className="rc-drift-table">
        <div className="rc-drift-col rc-drift-labels">
          <span className="rc-drift-h" />
          <span>服务端显示</span>
          <span>本设备重导</span>
        </div>
        {row.cmp.diffs.map((d) => (
          <div key={d.field} className="rc-drift-col">
            <span className="rc-drift-h">{d.label}</span>
            <span className="mono rc-drift-server">{rcFmt(d.server)}</span>
            <span className="mono rc-drift-device">{rcFmt(d.device)}</span>
          </div>
        ))}
      </div>
      <p className="rc-drift-note">
        只是<b>这一项的显示口径与本地重导没对上</b> —— 你的作答证据没有问题,其它 {otherCount} 个数字都逐位相等。
        重算只读,不会改动任何记录;联网后系统会让这一项重新对账。
      </p>
    </div>
  );
}

/* ── calibration-maturity 卡 · profile 级重算徽章 ──────────────
   这屏是观察面(「这份测量有多可信」),所以 verified ✓ 设成静息态:
   打开即在本设备重导成熟度概览(firm 计数 · 中位 θ̂ SE)并核对。 */
function RcMaturityBadge({ a, mode = "match" }) {
  const vr = useRecompute({ auto: true, mode });
  const median = (arr) => {
    const s = [...arr].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const dFirm = a.kcs.filter((k) => !k.cold_start && k.evidence > 0).length;
  const dMedian = rcRound2(median(a.kcs.map((k) => k.se)));
  const sFirm = mode === "drift" ? a.firm_count + 1 : a.firm_count;
  const sMedian = a.median_theta_se;
  const firmMatch = dFirm === sFirm, medMatch = dMedian === sMedian;
  const total = a.kcs.length;

  return (
    <div className={"rc-cal rc-state-" + vr.state}>
      <span className="rc-cal-icon">
        {vr.state === "match" ? <Icon name="checkCircle" size={18} />
          : vr.state === "drift" ? <Icon name="alert" size={18} />
          : <Icon name="refresh" size={18} />}
      </span>
      <div className="rc-cal-text">
        {vr.state === "running" && (
          <div className="rc-cal-title">正在本设备重导成熟度概览…</div>
        )}
        {vr.state === "match" && <>
          <div className="rc-cal-title">成熟度概览已在本设备重导 <span className="rc-tick">✓</span></div>
          <div className="rc-cal-sub">
            <span className="mono">{total}</span> 个知识点的等级与 θ̂ SE 排序 · 与服务端<b>逐位相等</b>
            <span className="rc-cal-figs">
              <span className="rc-cal-fig"><b className="mono">firm {dFirm}</b><Icon name="check" size={11} /></span>
              <span className="rc-cal-fig"><b className="mono">中位 SE {dMedian.toFixed(2)}</b><Icon name="check" size={11} /></span>
            </span>
            · <RcOffline />
          </div>
        </>}
        {vr.state === "drift" && <>
          <div className="rc-cal-title">概览有 <b className="mono">1</b> 处不同步</div>
          <div className="rc-cal-sub">
            firm 计数:服务端显示 <b className="mono rc-drift-server">{sFirm}</b> · 本地重导 <b className="mono rc-drift-device">{dFirm}</b>
            {medMatch && <> · 中位 SE <b className="mono">{dMedian.toFixed(2)}</b> 仍逐位相等</>}
            。只是显示口径未对齐 —— 等级与相对排序本身没问题,重算只读。 · <RcOffline />
          </div>
        </>}
      </div>
      <button className="rc-rerun" onClick={vr.run} title="再算一次"><Icon name="refresh" size={14} /></button>
    </div>
  );
}

Object.assign(window, {
  recomputeKC, cmpKC, useRecompute, rcFmt,
  RcOffline, RcKcChip, RcBoundaryNote, RcLedgerTable, RcDriftDetail,
  RcMaturityBadge,
});
