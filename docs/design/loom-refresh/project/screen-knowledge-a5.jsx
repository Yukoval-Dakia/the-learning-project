// Loom · A5 知识探索面 — 共享 helper + 节点详情诊断件.
// 复用 window.MasteryBand(A1). 一切掌握/难度走离散档 + 置信区间 + 来源二态.

const A5_BANDS = ["萌芽", "成长", "稳固", "精熟"];
function masteryToBandIdx(m) { return m < 40 ? 0 : m < 60 ? 1 : m < 80 ? 2 : 3; }

// node(含 mastery/evidence) → MasteryBand props. evidence 少 → 软轨先验 + 低置信 + 宽区间.
function masteryBand(node, label) {
  const band = masteryToBandIdx(node.mastery || 0);
  const ev = node.evidence || 0;
  const soft = ev <= 4;
  const lowConf = ev <= 6;
  const spread = ev <= 8 ? 1 : 0;
  return {
    node: label || node.title, band,
    lo: Math.max(0, band - spread),
    hi: Math.min(3, band + (soft ? 1 : spread)),
    source: soft ? "soft" : "hard", lowConf,
  };
}

// compact band reading — replaces bare % on tree/graph rows
function BandChip({ node, label }) {
  const p = masteryBand(node, label);
  return (
    <span className={"band-chip src-" + p.source + (p.lowConf ? " is-low" : "")}
      title={`${A5_BANDS[p.band]} · 区间 ${A5_BANDS[p.lo]}–${A5_BANDS[p.hi]} · ${p.source === "soft" ? "软轨先验" : "硬轨校准"}${p.lowConf ? " · 低置信" : ""}`}>
      <span className="bc-dot" />{A5_BANDS[p.band]}
      {p.lowConf && <span className="bc-low">低置信</span>}
    </span>
  );
}

// ── frontier rail — 「下一步能学什么」一等可供性 ──
function FrontierRail({ go }) {
  return (
    <div className="frontier">
      <div className="frontier-head">
        <span className="frontier-ic"><Icon name="target" size={19} /></span>
        <div>
          <h3 className="frontier-title">下一步，你学得动这些</h3>
          <div className="frontier-sub">learnable_frontier · 前置都满足了 · 这是<b>建议</b>不是必经路，随时忽略</div>
        </div>
      </div>
      <div className="frontier-list">
        {KA5.frontier.map((f) => {
          const n = DATA.knowledge.find((k) => k.id === f.kid);
          if (!n) return null;
          return (
            <button key={f.kid} className="frontier-card" onClick={() => go("knowledge/" + f.kid)}>
              <div className="frontier-card-top">
                <span className="frontier-card-name wenyan">{n.title}</span>
                {f.propose ? <span className="frontier-tag-propose">建议 · 低置信</span> : <span className="frontier-tag-next">下一步</span>}
              </div>
              <div className="frontier-reason">{f.reason}</div>
              <div className="frontier-note"><BandChip node={n} /></div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── node-detail · B1 three-dim fold (composite + drill R/p(L)/difficulty) ──
function NodeComposite({ node, extra }) {
  const [open, setOpen] = React.useState(false);
  const comp = masteryBand(node, "综合掌握");
  const dimAs = (d) => ({ ...d, node: d.label });
  return (
    <div className="kd-composite">
      <div className="kd-composite-main">
        <div className="kd-composite-head">
          <span className="kd-composite-band">{A5_BANDS[comp.band]}</span>
          <span className="kd-composite-cap">三维折叠为单标量 · R 记忆 · p(L) 掌握 · difficulty 难度</span>
        </div>
        <MasteryBand m={comp} />
        {extra && extra.coldNote && (
          <div className="kd-cold-note"><Icon name="alert" size={14} />{extra.coldNote}</div>
        )}
        {extra && extra.dims && (
          <React.Fragment>
            <button className={"kd-dim-toggle" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
              <Icon name="chevronRight" size={14} />{open ? "收起三维" : "展开三维 · R 记忆 / p(L) 掌握 / difficulty 难度"}
            </button>
            {open && (
              <div className="kd-dims">
                {["R", "pL", "diff"].map((k) => {
                  const d = extra.dims[k]; if (!d) return null;
                  return (
                    <div key={k} className="kd-dim">
                      <MasteryBand m={dimAs(d)} />
                      {d.note && <div className="kd-dim-note">{d.note}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </React.Fragment>
        )}
      </div>
    </div>
  );
}

// ── transfer credit (RT2) ──
function TransferList({ extra }) {
  const t = (extra && extra.transfer) || [];
  if (!t.length) return <div className="quiet-empty">暂无可识别的迁移来源。</div>;
  return t.map((x, i) => {
    const from = DATA.knowledge.find((n) => n.id === x.from);
    return (
      <div key={i} className="kd-transfer-row">
        <Icon name="merge" size={18} className="kd-transfer-arrow" />
        <div className="kd-transfer-body">
          <div className="kd-transfer-from wenyan">{from ? from.title : x.from}</div>
          <div className="kd-transfer-note">{x.note}{x.lowConf ? " · 迁移为推断，低置信" : ""}</div>
        </div>
        <span className="kd-transfer-amt">+{x.amount}</span>
      </div>
    );
  });
}

// ── misconceptions pointing here (RT1) — 可否决 + 追溯 ──
function MisconceptionCard({ mc, go }) {
  const [trace, setTrace] = React.useState(false);
  const [verdict, setVerdict] = React.useState(null);
  if (verdict) {
    return (
      <div className="kd-misc-card fading">
        <div className="kd-misc-top">
          <span className="kd-misc-ic"><Icon name="check" size={15} /></span>
          <span className="kd-misc-label">已纠偏：「{mc.label}」</span>
        </div>
        <p className="kd-misc-belief">谢谢，编排者会把这条误区降权 —— 下次不再据此排题。</p>
      </div>
    );
  }
  return (
    <div className={"kd-misc-card " + mc.status}>
      <div className="kd-misc-top">
        <span className="kd-misc-ic"><Icon name="alert" size={15} /></span>
        <span className="kd-misc-label">{mc.label}</span>
        <span className={"kd-misc-status " + mc.status}>{mc.status === "active" ? "复发中" : "消退中"}</span>
      </div>
      <p className="kd-misc-belief">{mc.belief}</p>
      <div className="kd-misc-meta">
        <span className={"band-chip src-" + mc.source} style={{ padding: "2px 8px" }}>
          <span className="bc-dot" style={{ background: mc.source === "hard" ? "var(--good)" : "transparent", border: mc.source === "soft" ? "1.5px dashed var(--ink-4)" : "none" }} />
          {mc.source === "hard" ? "硬轨校准" : "软轨先验"}
        </span>
        <span>置信 {mc.conf}</span><span>·</span><span>复现 {mc.seen} 次</span>
      </div>
      {trace && (
        <div className="kd-misc-trace">
          依据 event：{mc.evidence.map((e) => <code key={e} className="evt">{e}</code>)}<br />{mc.note}
        </div>
      )}
      <div className="kd-misc-acts">
        <Btn size="sm" variant="secondary" icon="review" onClick={() => go("practice")}>针对性练习</Btn>
        <button className="ho-linkbtn" onClick={() => setTrace((v) => !v)}><Icon name="history" size={14} />追溯</button>
        <button className="ho-linkbtn" title="若 AI 判错了这个误区，纠正它" onClick={() => setVerdict("wrong")}><Icon name="close" size={14} />判错了</button>
      </div>
    </div>
  );
}
function MisconceptionList({ node, go }) {
  const items = KA5.misconceptions.filter((m) => m.targets.includes(node.id));
  if (!items.length) return <div className="quiet-empty">没有指向此点的误区 —— 你在这点上没有顽固的错误信念。</div>;
  return items.map((mc) => <MisconceptionCard key={mc.id} mc={mc} go={go} />);
}

// ── diagnostic drill-down (CDM attribute profile + IRT discrimination) ──
function DiagnosticDrill({ extra }) {
  const [open, setOpen] = React.useState(false);
  const cdm = (extra && extra.cdm) || [];
  const irt = extra && extra.irt;
  const empty = !cdm.length && !irt;
  return (
    <div className={"kd-diag" + (open ? " open" : "")}>
      <button className="kd-diag-bar" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="kd-diag-ic"><Icon name="graph" size={17} /></span>
        <span>
          <span className="kd-diag-t">诊断下钻 · CDM 属性画像 / IRT 区分度</span>
          <span className="kd-diag-s">{empty ? "证据不足，慢热期暂不出诊断" : "拆开综合掌握，看你具体强在哪、弱在哪"}</span>
        </span>
        <Icon name="chevronDown" size={18} className="kd-diag-chev" />
      </button>
      {open && (
        <div className="kd-diag-body">
          {empty ? (
            <div className="kd-diag-empty"><Icon name="eye" size={16} />证据不足 / 低置信 —— 软轨指标(a / c / CDM / KT)还没热起来，这里不显示假精度。练几道就会逐步出现。</div>
          ) : (
            <React.Fragment>
              {cdm.length > 0 && (
                <React.Fragment>
                  <div className="kd-diag-sub">CDM 属性画像</div>
                  {cdm.map((c, i) => (
                    <div key={i} className={"kd-cdm-row" + (c.source === "soft" ? " soft" : "")}>
                      <span className="kd-cdm-attr">{c.attr}</span>
                      <span className="kd-cdm-track">
                        {[0, 1, 2, 3].map((s) => <span key={s} className="kd-cdm-seg" />)}
                        <span className="kd-cdm-fill" style={{ width: ((c.band + 0.5) / 4 * 100) + "%" }} />
                      </span>
                      <span className={"kd-cdm-src band-chip src-" + c.source} style={{ padding: "2px 8px" }}>
                        <span className="bc-dot" style={{ background: c.source === "hard" ? "var(--good)" : "transparent", border: c.source === "soft" ? "1.5px dashed var(--ink-4)" : "none" }} />
                        {A5_BANDS[c.band]}{c.lowConf && <span className="bc-low">低置信</span>}
                      </span>
                    </div>
                  ))}
                </React.Fragment>
              )}
              {irt && (
                <React.Fragment>
                  <div className="kd-diag-sub">IRT 题目参数</div>
                  <div className="kd-irt">
                    <div className="kd-irt-stat"><div className="kd-irt-lbl">{irt.aLabel}</div><div className="kd-irt-cap">discrimination a · 越高越能区分会与不会</div></div>
                    <div className="kd-irt-stat"><div className="kd-irt-lbl">{irt.bLabel}</div><div className="kd-irt-cap">difficulty b · 相对你当前 θ̂</div></div>
                  </div>
                  {irt.note && <div className="kd-dim-note" style={{ marginTop: "var(--s-2)" }}>{irt.note}</div>}
                </React.Fragment>
              )}
            </React.Fragment>
          )}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { A5_BANDS, masteryBand, BandChip, FrontierRail, NodeComposite, TransferList, MisconceptionList, MisconceptionCard, DiagnosticDrill });
