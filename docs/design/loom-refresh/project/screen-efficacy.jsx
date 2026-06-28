// Loom · 成效趋势面 (A7) — 页面装配.
// 镜像校准成熟度面的克制结构(概览 meter → 分布/轨迹 → ledger),做姊妹对:
// 校准面答「准不准」(横截面),本面答「涨没涨」(纵向 delta)。
// states: ok · loading · error(如实取不到,不回落平线)· empty(零作答)· single(单点)
//         · lowconf(全还嫩,默认态)· regress(退步如实)。

// ── 数据态变换 ───────────────────────────────────────────────
function effApplyState(state) {
  const D = window.EFFICACY;
  if (state === "lowconf") {
    return { ...D, series: D.series.map((k) => ({ ...k, confidence: k.direction === "insufficient" ? "low" : "low" })) };
  }
  if (state === "single") {
    return { ...D, series: D.series.map((k) => ({ ...k, points: [k.points[0]], direction: "insufficient", confidence: "low", span_evidence: 1 })) };
  }
  if (state === "regress") {
    return {
      ...D,
      series: D.series.map((k) => {
        if (k.direction === "insufficient") return k;
        const p0 = k.points[0];
        const pts = k.points.map((p) => Math.max(0.04, Math.min(0.96, p0 - (p - p0) - 0.04)));
        return { ...k, points: pts, direction: "falling", confidence: k.confidence === "firm" ? "mid" : "low" };
      }),
    };
  }
  return D;
}

// ── 横截面 ≠ 纵向 对照(handoff #2)─────────────────────────
function EffContrast({ go }) {
  return (
    <div className="eff-contrast">
      <span className="eff-contrast-ic"><Icon name="layers" size={17} /></span>
      <div className="eff-contrast-body">
        <div className="eff-contrast-t">横截面 ≠ 纵向 —— 同一个 <span className="mono">p(L)≈0.60</span>,方向可以完全相反</div>
        <p className="eff-contrast-s">
          校准面会把<b className="wenyan">古今异义</b>标成 <span className="eff-inlinebadge tone-good">firm</span> · <span className="mono">p≈0.60</span>,看着挺稳。
          但只有这条纵向轨告诉你:它是<b>从 0.82 滑下来的</b> —— 这 0.60 是退步,不是稳态。一个点读不出方向,一条线才行。
        </p>
        <button className="eff-linkbtn" onClick={() => go && go("calibration")}><Icon name="target" size={13} />对照校准成熟度面 →</button>
      </div>
    </div>
  );
}

// ── A · 成效概览 meter(镜像 cal-meter)──────────────────────
function EffOverview({ data }) {
  const agg = React.useMemo(() => {
    const byDir = { rising: 0, holding: 0, falling: 0, insufficient: 0 };
    let firm = 0, tender = 0;
    data.series.forEach((k) => { byDir[k.direction]++; (k.confidence === "firm" ? firm++ : tender++); });
    return { byDir, firm, tender, total: data.series.length, blind: data.blind.length };
  }, [data]);
  const rising = useCountUp(agg.byDir.rising, { dur: 800 });
  const seg = [
    ["rising", agg.byDir.rising], ["holding", agg.byDir.holding],
    ["falling", agg.byDir.falling], ["insufficient", agg.byDir.insufficient],
  ];
  const tot = agg.total || 1;
  return (
    <div className="eff-overview">
      <Card pad className="eff-meter">
        <div className="eff-meter-fig">
          <span className="eff-meter-num serif">{Math.round(rising)}<span className="eff-meter-slash">/{agg.total}</span></span>
          <span className="eff-meter-cap meta">条轨迹相对在涨</span>
        </div>
        <div className="eff-meter-side">
          <div className="eff-meter-line">相对<b>你自己</b>,近 6 周 —— 不和任何标准比,只和过去的你比。</div>
          <div className="eff-meter-line meta">其中<b className="mono"> {agg.firm} </b>条够硬,<b className="mono"> {agg.tender} </b>条还嫩。<b>多数趋势低置信</b> —— 信方向,别把幅度当精确进度。</div>
          <div className="eff-dirbar">
            {seg.map(([d, n]) => n > 0 && (
              <span key={d} className={"eff-dirbar-seg is-" + d} style={{ width: (n / tot) * 100 + "%" }} title={EFF_DIR[d].label + " " + n} />
            ))}
          </div>
          <div className="eff-legend">
            {seg.map(([d, n]) => (
              <span key={d}><i className={"is-" + d} />{EFF_DIR[d].label} <b className="mono">{n}</b></span>
            ))}
          </div>
        </div>
      </Card>
      <div className="eff-stats">
        {[
          ["rising", agg.byDir.rising, "在涨", "相对自己上行"],
          ["falling", agg.byDir.falling, "在退", "如实呈现,不美化"],
          ["insf", agg.byDir.insufficient, "数据不足", "≤2 次 · 不断方向"],
          ["blind", agg.blind, "没练过", "0 作答 · 无轨迹"],
        ].map(([k, v, lbl, sub]) => (
          <div key={k} className={"eff-stat is-" + k}>
            <span className="eff-stat-num mono">{v}</span>
            <span className="eff-stat-lbl">{lbl}</span>
            <span className="eff-stat-sub meta">{sub}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── C · 跨 KC 迁移:相邻联动高亮(owner 留白2 · 本版「联动高亮」)──
function EffClusterGraph({ cluster }) {
  const W = 232, H = 132;
  const lift = cluster.kind === "lift";
  const src = cluster.nodes.find((n) => n.role === "source");
  const others = cluster.nodes.filter((n) => n.role !== "source");
  const pos = {};
  pos[src.id] = { x: 46, y: H / 2 };
  others.forEach((n, i) => { pos[n.id] = { x: 178, y: 34 + i * (others.length > 1 ? (H - 68) / (others.length - 1) : 0) }; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={"eff-cgraph" + (lift ? " is-lift" : " is-none")} role="img" aria-label={cluster.label}>
      {cluster.edges.map(([a, b], i) => {
        const pa = pos[a], pb = pos[b];
        return <path key={i} className="eff-cgraph-edge" d={`M${pa.x} ${pa.y} C ${(pa.x + pb.x) / 2} ${pa.y}, ${(pa.x + pb.x) / 2} ${pb.y}, ${pb.x} ${pb.y}`} />;
      })}
      {cluster.nodes.map((n) => {
        const p = pos[n.id];
        const dir = EFF_DIR[n.dir];
        return (
          <g key={n.id} className={"eff-cnode is-" + n.dir + (n.role === "source" ? " is-src" : "") + (n.role === "lifted" ? " is-lifted" : "")} transform={`translate(${p.x} ${p.y})`}>
            <circle className="eff-cnode-halo" r={n.role === "source" ? 22 : 18} />
            <circle className="eff-cnode-dot" r={n.role === "source" ? 15 : 12} fill={dir.base} />
            <text className="eff-cnode-lbl wenyan" y="1" textAnchor="middle">{n.name}</text>
            {n.dir !== "insufficient" && n.dir !== "holding" && (
              <text className="eff-cnode-arrow" x={n.role === "source" ? 19 : 16} y="-12" textAnchor="middle">{dir.glyph}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function EffTransfer({ data, go, mode }) {
  if (mode === "off") return null;
  if (mode === "reserve") {
    return (
      <section>
        <SectionLabel>跨 KC 迁移 · <span className="mono" style={{ fontSize: "var(--fs-meta)" }}>owner 留白2</span></SectionLabel>
        <div className="eff-reserve">
          <Icon name="graph" size={18} />
          <div>
            <div className="eff-reserve-t">这里将呈现「在 A 练的迁移到相邻 B 了吗」</div>
            <div className="eff-reserve-s">相邻 prerequisite 边上的 KC 同期抬升 = 真迁移;孤立单点抬升 = 可能只记住了这道题。形态(联动高亮 / 迁移列表 / 子图热力)待 owner 拍 —— 本期在数据契约里预留。</div>
          </div>
        </div>
      </section>
    );
  }
  const t = data.transfer;
  return (
    <section>
      <SectionLabel>跨 KC 迁移 · 相邻一起动</SectionLabel>
      <p className="eff-sec-lede">成效不止单点涨。<b>相邻知识点一起抬 = 真理解在迁移</b>;只有孤立一点动 = 可能只是记住了某道题。下面把相邻 prerequisite 边上同期共振的 KC 高亮出来。</p>
      <div className="eff-tclusters">
        {t.clusters.map((c) => (
          <Card pad key={c.id} className={"eff-tcluster is-" + c.kind}>
            <EffClusterGraph cluster={c} />
            <div className="eff-tcluster-body">
              <div className="eff-tcluster-h">
                <span className="eff-tcluster-name">{c.label}</span>
                <span className={"eff-tcluster-tag is-" + c.kind}>{c.kind === "lift" ? "同期抬升" : "未见迁移"}</span>
              </div>
              <p className="eff-tcluster-note">{c.note}</p>
              {c.caveat && <p className="eff-tcluster-caveat"><Icon name="alert" size={12} /> {c.caveat}</p>}
            </div>
          </Card>
        ))}
      </div>
      <div className="eff-isolated">
        <span className="eff-isolated-glyph tone-down">↓</span>
        <span><b className="wenyan">{t.isolated.name}</b> · {t.isolated.note}</span>
      </div>
    </section>
  );
}

// ── D · 逐知识点 ledger(镜像 cal-table)───────────────────────
function EffLedger({ data, go }) {
  const [sort, setSort] = React.useState({ key: "direction", dir: 1 });
  const dirRank = { rising: 0, holding: 1, falling: 2, insufficient: 3 };
  const confRank = { firm: 0, mid: 1, low: 2 };
  const subjName = (k) => {
    const s = window.EFFICACY.subjects.find((x) => x.id === k.effective_domain);
    return s ? s.name : (k.effective_domain == null ? "未归类" : k.effective_domain);
  };
  const rows = [...data.series].sort((a, b) => {
    let d = 0;
    if (sort.key === "name") d = a.name.localeCompare(b.name, "zh");
    else if (sort.key === "subject") d = subjName(a).localeCompare(subjName(b), "zh") || dirRank[a.direction] - dirRank[b.direction];
    else if (sort.key === "confidence") d = (confRank[a.confidence] ?? 9) - (confRank[b.confidence] ?? 9) || b.span_evidence - a.span_evidence;
    else if (sort.key === "evidence") d = a.span_evidence - b.span_evidence;
    else d = dirRank[a.direction] - dirRank[b.direction] || b.span_evidence - a.span_evidence;
    return d * sort.dir;
  });
  const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "evidence" ? -1 : 1 }));
  const caret = (key) => (sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : "");
  return (
    <section>
      <div className="eff-table-h">
        <div className="card-title">逐知识点 · 跨科目完整索引</div>
        <span className="meta mono">{rows.length} kcs · 点表头排序</span>
      </div>
      <p className="eff-sec-lede">卷起首屏按<b>科目</b>分组浏览;这张表是跨所有科目的<b>可排序完整索引</b> —— 点表头按 方向 / 置信 / 证据 / 科目 排,用来全局查找与排名,和卷起互补、不重复。</p>
      <div className="eff-ledger">
        <div className="eff-ledger-head">
          <span className="eff-th" onClick={() => onSort("name")}>知识点{caret("name")}</span>
          <span className="eff-th" onClick={() => onSort("subject")}>科目{caret("subject")}</span>
          <span>轨迹</span>
          <span className="eff-th" onClick={() => onSort("direction")}>方向{caret("direction")}</span>
          <span className="eff-th" onClick={() => onSort("confidence")}>置信{caret("confidence")}</span>
          <span className="eff-th num" onClick={() => onSort("evidence")}>证据{caret("evidence")}</span>
          <span></span>
        </div>
        {rows.map((kc) => {
          const dir = EFF_DIR[kc.direction];
          const tender = kc.confidence === "low" || kc.direction === "insufficient";
          return (
            <div key={kc.id} className={"eff-lrow is-" + kc.direction + (tender ? " is-tender" : "")}>
              <span className="eff-lrow-kc">
                <span className="eff-lrow-name wenyan">{kc.name}</span>
                {kc.track && <span className="eff-lrow-track">{kc.track}</span>}
              </span>
              <span className="eff-lrow-subj">{kc.effective_domain == null
                ? <span className="eff-lrow-uncat">未归类</span>
                : subjName(kc)}</span>
              <span className="eff-lrow-traj"><EffTrajectory kc={kc} w={120} h={32} padY={6} compact /></span>
              <span className="eff-lrow-dir"><span className={"eff-dirchip tone-" + dir.tone}>{dir.glyph} {dir.label}</span></span>
              <span className="eff-lrow-conf"><EffConfTag kc={kc} mini /></span>
              <span className="eff-lrow-ev mono">{kc.span_evidence}</span>
              <span className="eff-lrow-act"><button className="eff-linkbtn" onClick={() => go && go("knowledge/" + kc.id)}><Icon name="arrowRight" size={14} /></button></span>
            </div>
          );
        })}
      </div>
      <p className="eff-foot meta">口径:方向用定性档(涨/保持/退/数据不足),<b>绝不裸报 delta 数字</b>。低置信只信相对方向,不渲染干净精确值(ADR-0035)。退步如实呈现,不柔化成平线。</p>
    </section>
  );
}

// ── E · 自评成效(开放题 · owner 留白4 · 精修 A7 自评行)──────
function EffSelfRow({ a }) {
  const [series, setSeries] = React.useState(a.selfSeries);
  const [checked, setChecked] = React.useState(null);
  const labels = ["6周前", "5周", "4周", "3周", "2周", "本周"];
  const mark = (v) => { setChecked(v); setSeries((s) => { const n = [...s]; n[n.length - 1] = v; return n; }); };
  return (
    <Card pad className="eff-self">
      <div className="eff-self-top">
        <span className="eff-self-name wenyan">{a.name}</span>
        <span className="eff-self-tag"><Icon name="today" size={12} />自评轨</span>
        <span className="eff-self-why meta">客观三量退化 · objective 信号无效</span>
      </div>
      <p className="eff-self-reason">{a.reason} {a.selfNote}</p>
      <div className="eff-selfseries">
        {series.map((v, i) => (
          <div key={i} className="eff-selftick">
            <span className={"eff-selfmark " + (v || "none")}>{v || "—"}</span>
            <span className="eff-selftick-x mono">{labels[i]}</span>
          </div>
        ))}
      </div>
      {checked ? (
        <div className="eff-self-done"><Icon name="check" size={14} />记下了 —— 你的感受是一等信号,按时间排进这条自评轨。</div>
      ) : (
        <div className="eff-selfcheck">
          <span className="eff-selfcheck-l">这块这周你感觉相对上次怎么样?</span>
          {["进步", "持平", "退步"].map((v) => (
            <button key={v} className={"eff-selfcheck-btn " + v} onClick={() => mark(v)}>{v}</button>
          ))}
        </div>
      )}
    </Card>
  );
}

function EffSelfAssess({ data, mode }) {
  if (mode === "off") return null;
  return (
    <section>
      <SectionLabel count={data.openEnded.length}>自评成效 · 开放题</SectionLabel>
      <p className="eff-sec-lede">论述 / 翻译这类开放题,IRT 三量(θ̂ / 难度 / 区分度)退化,客观「掌握度趋势」算不出。这里给一条<b>以你的主观感受为主</b>的平行轨 —— 自评是一等输入,不是次等兜底。</p>
      {data.openEnded.map((a) => <EffSelfRow key={a.id} a={a} />)}
    </section>
  );
}

// ── 盲区组(镜像 cal-blind)────────────────────────────────────
function EffBlind({ data, go }) {
  if (!data.blind.length) return null;
  return (
    <div className="eff-blind">
      <div className="eff-blind-head">
        <span className="eff-blind-ic"><Icon name="eye" size={16} /></span>
        <div>
          <div className="eff-blind-t">还没练过 · <b className="mono">{data.blind.length}</b> 个知识点没有成效轨迹</div>
          <div className="eff-blind-s meta">evidence = 0 → 连一个 p(L) 读数都没有,谈不上趋势。练它一次,这里就开始长出第一段轨迹。</div>
        </div>
      </div>
      <div className="eff-blind-list">
        {data.blind.map((k) => (
          <div key={k.id} className="eff-blind-chip">
            <span className="eff-blind-name wenyan">{k.name}</span>
            {k.track && <span className="eff-blind-track meta">{k.track}</span>}
            <button className="eff-linkbtn sm" onClick={() => go && go("knowledge/" + k.id)}>去练 <Icon name="arrowRight" size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 全空态 / 故障态 ─────────────────────────────────────────
function EffEmpty({ go }) {
  return (
    <div className="eff-empty">
      <span className="eff-empty-ic"><Icon name="target" size={26} /></span>
      <div className="eff-empty-t serif">还没有成效数据</div>
      <p className="eff-empty-s">成效是「相对过去的你」。现在 <code>event</code> 表里还没有一条 <span className="mono">mastery_progress</span> —— 没有起点,就画不出趋势。去练几道,这里会长出每块的涨 / 保持 / 退。<b>我不会先画一条假的上升线,也不画一条 0 值平线</b>(那会骗你说「掌握一直是 0」)。</p>
      <button className="eff-cta" onClick={() => go && go("practice")}><Icon name="layers" size={15} />去练几道</button>
    </div>
  );
}

function EffError({ onRetry }) {
  return (
    <div className="eff-error" role="alert">
      <span className="eff-error-ic"><Icon name="alert" size={22} /></span>
      <div className="eff-error-body">
        <div className="eff-error-t">成效数据暂时取不到</div>
        <p className="eff-error-s">纵向读模型是新建的聚合查询,这次没拉到。<b>不替你回落成「全部 0」或「全部平线」</b> —— 那是把「读不到」伪装成「没涨」。等一下重试。</p>
      </div>
      <button className="eff-cta secondary" onClick={onRetry}><Icon name="refresh" size={15} />重试</button>
    </div>
  );
}

// ── 面板主体(无 page-head;可被 Coach 复盘中枢 直接挂载)──────
function EfficacyBody({ go = () => {}, ui = {}, embedded = false }) {
  const state = ui.effState || "ok";
  const [vizMode, setVizMode] = React.useState(ui.vizMode || "rows");
  const [win, setWin] = React.useState(ui.effWindow || "attempt");
  React.useEffect(() => { if (ui.vizMode) setVizMode(ui.vizMode); }, [ui.vizMode]);
  React.useEffect(() => { if (ui.effWindow) setWin(ui.effWindow); }, [ui.effWindow]);

  const data = React.useMemo(() => effApplyState(state), [state]);
  const showSource = ui.showSource !== false;
  const winLbl = { attempt: "按 attempt 序", calendar: "按日历日", week: "按周桶" }[win] || "按 attempt 序";
  const [subjId, setSubjId] = React.useState(null); // null = 科目卷起首屏;否则下钻某科
  React.useEffect(() => { setSubjId(null); }, [state]);
  const subjKCs = subjId ? data.series.filter((k) => (subjId === "__uncat" ? k.effective_domain == null : k.effective_domain === subjId)) : [];
  const subjMeta = subjId === "__uncat" ? { name: "未归类" } : (subjId ? (window.EFFICACY.subjects.find((s) => s.id === subjId) || { name: subjId }) : null);

  const lede = embedded ? null : (
    <p className="page-lead eff-lede">成效答「相对上次,我涨了吗」—— 和过去的你比,不和任何标准比。慢热期只信相对方向,绝对数字别太当真;退步也如实说,不替你美化。</p>
  );

  if (state === "loading") return <React.Fragment>{lede}<Card pad><SkLines rows={5} /></Card></React.Fragment>;
  if (state === "error") return <React.Fragment>{lede}<EffError onRetry={() => {}} /></React.Fragment>;
  if (state === "empty") return <React.Fragment>{lede}<EffEmpty go={go} /></React.Fragment>;

  return (
    <React.Fragment>
      {lede}
      <EffContrast go={go} />
      <EffOverview data={data} />

      <section className="eff-vizsec">
        <div className="eff-vizhead">
          <div className="eff-vizhead-l">
            {subjId ? (
              <React.Fragment>
                <button className="eff-back" onClick={() => setSubjId(null)}><Icon name="arrowL" size={14} />科目卷起</button>
                <div className="card-title">{subjMeta.name} · 逐 KC 轨迹 <span className="eff-vizhead-sub meta">{subjKCs.length} KC · 下钻态</span></div>
              </React.Fragment>
            ) : (
              <React.Fragment>
                <div className="card-title">方向 + 轨迹 · 按科目卷起</div>
                <span className="meta">规模做法:首屏按<b>科目</b>卷起、只高亮「本期动了的」KC;逐 KC 轨迹点科目展开。整科卷起把单条 n=1 噪声平均掉,常比任一 KC 更可信。</span>
              </React.Fragment>
            )}
          </div>
          <div className="eff-vizctrl">
            <div className="seg eff-seg" role="tablist" aria-label="时间窗">
              {[["attempt", "attempt 序"], ["calendar", "日历日"], ["week", "周桶"]].map(([v, l]) => (
                <button key={v} className={win === v ? "on" : ""} onClick={() => setWin(v)}>{l}</button>
              ))}
            </div>
            {subjId && (
              <div className="seg eff-seg" role="tablist" aria-label="可视化形态">
                {[["rows", "折线行"], ["grid", "小倍数"], ["stream", "河流带"]].map(([v, l]) => (
                  <button key={v} className={vizMode === v ? "on" : ""} onClick={() => setVizMode(v)}>{l}</button>
                ))}
              </div>
            )}
          </div>
        </div>
        {win !== "attempt" && (
          <div className="eff-winnote meta"><Icon name="alert" size={12} /> n=1 低频作答下,{winLbl}会出现大量空桶 —— 默认 <b>attempt 序</b> 更稳。这里仅重标时间轴,轨迹不变(owner 留白1)。</div>
        )}
        {!subjId && <EffSubjectRollup series={data.series} onDrill={setSubjId} />}
        {subjId && (subjKCs.length
          ? (
            <React.Fragment>
              {vizMode === "rows" && <EffSparkRows series={subjKCs} go={go} showSource={showSource} />}
              {vizMode === "grid" && <EffSmallMultiples series={subjKCs} go={go} showSource={showSource} />}
              {vizMode === "stream" && <EffStreamFlow series={subjKCs} go={go} />}
            </React.Fragment>
          )
          : <div className="eff-reserve"><Icon name="layers" size={18} /><div><div className="eff-reserve-t">这科还没有可下钻的子 KC</div><div className="eff-reserve-s">题还堆在科目根上、子 KC 没抽出 —— 现在只有一条「科目整体」轨迹(见卷起首屏)。</div></div></div>
        )}
      </section>

      <EffTransfer data={data} go={go} mode={ui.transferMode || "highlight"} />
      <EffLedger data={data} go={go} showSource={showSource} />
      <EffSelfAssess data={data} mode={ui.selfMode || "rows"} />
      <EffBlind data={data} go={go} />
    </React.Fragment>
  );
}

// ── 独立页(成效趋势面.html 用)── page-head + 面板主体 ────────
function ScreenEfficacy({ go = () => {}, ui = {} }) {
  const winLbl = { attempt: "按 attempt 序", calendar: "按日历日", week: "按周桶" }[ui.effWindow || "attempt"] || "按 attempt 序";
  return (
    <div className="page view eff">
      <div className="page-head">
        <div className="eyebrow">COACH · 成效趋势 · 纵向 delta · <span className="mono">events experimental:mastery_progress · {winLbl}</span></div>
        <div className="page-head-row">
          <h1 className="page-title serif">成效趋势</h1>
          <a className="eff-sibling" onClick={() => go("calibration")}><Icon name="target" size={14} />姊妹面 · 校准成熟度</a>
        </div>
      </div>
      <EfficacyBody go={go} ui={ui} />
    </div>
  );
}

window.ScreenEfficacy = ScreenEfficacy;
window.EfficacyBody = EfficacyBody;
