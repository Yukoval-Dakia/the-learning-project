// Loom · /drafts (草稿审核) — draft-pool review surface.
// Master-detail: left list + right preview. Two layouts (split · compact).
// Batch-select → verify queue · force-enable confirm modal (required reason).
// AI confidence/cost gated behind a Tweak (ui.aiMeta).

/* ---- small bits ---------------------------------------------------- */
function DrPips({ d }) {
  const tone = DR_DIFF[d].tone;
  return (
    <span className="dr-pips" title={"难度 " + d + " · " + DR_DIFF[d].word}>
      {[1, 2, 3, 4, 5].map((i) => <span key={i} className={"dr-pip" + (i <= d ? " on tone-" + tone : "")} />)}
      <span className="dr-pip-w">{DR_DIFF[d].word}</span>
    </span>
  );
}

function DrVChip({ v, dot }) {
  const m = DR_VERIFY[v.state];
  if (dot) return <span className={"dr-vdot tone-" + m.tone} title={m.label} />;
  return <span className={"dr-vchip tone-" + m.tone}><Icon name={m.icon} size={11} />{m.label}</span>;
}

function DrSrc({ source }) {
  const s = DR_SOURCE[source];
  return <span className={"dr-tag dr-src tone-" + s.tone}><Icon name={s.icon} size={11} />{s.label}</span>;
}

function DrKind({ kind }) {
  const k = QKIND[kind] || { label: kind, icon: "quiz" };
  return <span className="dr-tag dr-kind"><Icon name={k.icon} size={11} />{k.label}</span>;
}

/* ---- verify outcome (demo logic) ----------------------------------- */
// unverified + clean → pass; unverified + latent flaw → fail w/ fresh reason;
// already needs_review / failed → fail again with its standing reason.
function verifyOutcome(d) {
  if (!d) return { pass: false, reason: "草稿不存在" };
  if (d.verify.state === "unverified") {
    return d.latent ? { pass: false, reason: d.latent } : { pass: true };
  }
  return { pass: false, reason: d.verify.reason };
}

/* ---- AI origin block ----------------------------------------------- */
function DrOrigin({ d, showMeta }) {
  if (!d.origin) return null;
  const o = d.origin;
  return (
    <div className="dr-origin">
      <div className="dr-origin-head">
        <span className="dr-origin-actor"><Icon name="sparkle" size={13} />{d.source === "web" ? "采集 agent" : "Dreaming agent"} · {o.agent}</span>
        {showMeta && (
          <span className="dr-origin-meta">
            <span title="AI 置信度">conf {Math.round(o.confidence * 100)}%</span>
            <span className="dr-conf-bar"><span className="dr-conf-fill" style={{ width: Math.round(o.confidence * 100) + "%" }} /></span>
            <span title="生成成本">${o.cost.toFixed(4)}</span>
          </span>
        )}
      </div>
      <div className="dr-origin-reason">{o.reason}</div>
    </div>
  );
}

/* ---- preview body blocks (shared by both layouts) ------------------ */
function DrPreviewBody({ d, showMeta, layout }) {
  return (
    <React.Fragment>
      {layout === "compact" && (
        <div className="dr-pv-block">
          <div className="dr-meta-grid">
            <span className="dr-meta-k">题型</span><span className="dr-meta-v"><DrKind kind={d.kind} /></span>
            <span className="dr-meta-k">来源</span><span className="dr-meta-v"><DrSrc source={d.source} /></span>
            <span className="dr-meta-k">难度</span><span className="dr-meta-v"><DrPips d={d.difficulty} /></span>
            <span className="dr-meta-k">知识点</span><span className="dr-meta-v">
              <span className="dr-ktags">{d.knowledge.map((k) => <span key={k} className="dr-ktag"><Icon name="tag" size={10} />{drkLabel(k)}</span>)}</span>
            </span>
            <span className="dr-meta-k">创建</span><span className="dr-meta-v" style={{ fontFamily: "var(--font-mono)", color: "var(--ink-3)" }}>{d.when}</span>
          </div>
        </div>
      )}

      {d.passage && (
        <div className="dr-pv-block">
          <div className="dr-pv-h"><Icon name="book" size={12} />材料 passage</div>
          <div className="dr-passage"><QMarkdown text={d.passage} /></div>
        </div>
      )}

      <div className="dr-pv-block">
        <div className="dr-pv-h"><Icon name="quiz" size={12} />题面 prompt_md</div>
        <div className="dr-stem-doc"><QMarkdown text={d.stem} /></div>
        {d.kind === "mcq" && d.options && (
          <div className="dr-opts">
            {d.options.map((o) => (
              <div key={o.key} className={"dr-opt" + (d.answer === o.key ? " correct" : "")}>
                <span className="dr-opt-key">{o.key}</span>
                <span className="dr-opt-txt"><QInline text={o.text} /></span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dr-pv-block">
        {d.answer ? (
          <div className="dr-answer">
            <div className="dr-pv-h"><Icon name="check" size={12} />参考答案 answer</div>
            <div className="dr-answer-body"><QMarkdown text={d.answer} /></div>
          </div>
        ) : (
          <div className="dr-answer-missing"><Icon name="alert" size={14} />缺少 answer 字段 — judge 无法校对正误</div>
        )}
      </div>

      {layout === "split" && (
        <div className="dr-pv-block">
          <div className="dr-pv-h"><Icon name="tag" size={12} />知识点 · 难度</div>
          <div className="dr-meta-v" style={{ gap: "var(--s-3)" }}>
            <span className="dr-ktags">{d.knowledge.map((k) => <span key={k} className="dr-ktag"><Icon name="tag" size={10} />{drkLabel(k)}</span>)}</span>
            <DrPips d={d.difficulty} />
          </div>
        </div>
      )}

      <DrOrigin d={d} showMeta={showMeta} />
    </React.Fragment>
  );
}

/* ---- preview pane -------------------------------------------------- */
function DrPreview({ d, layout, showMeta, verifying, onEnable, onForce, onSkip }) {
  if (!d) {
    return (
      <div className="dr-preview">
        <div className="dr-pv-empty"><EmptyState icon="eye" title="选一条草稿审阅" text="左侧逐条点开，确认题面与 verify 诊断后，决定启用、强制启用或跳过。" /></div>
      </div>
    );
  }
  const vstate = verifying[d.id];
  const diagTone = DR_VERIFY[d.verify.state].tone;
  const diagTitle = { unverified: "尚未运行 verify", needs_review: "verify 待复核", failed: "verify 未通过" }[d.verify.state];

  const Actions = (
    <div className="dr-actions">
      {vstate === "pending" ? (
        <span className="dr-pv-verifying"><span className="dr-spin" />verify 运行中 · B5 判题 agent…</span>
      ) : (
        <React.Fragment>
          <Btn variant="primary" icon="check" onClick={() => onEnable(d.id)}>启用</Btn>
          <button className="btn btn-secondary btn-warn" onClick={() => onForce(d)}><Icon name="bolt" size={17} />强制启用</button>
          <span className="dr-act-spacer" />
          <Btn variant="ghost" icon="close" onClick={() => onSkip(d.id)}>跳过</Btn>
        </React.Fragment>
      )}
    </div>
  );

  return (
    <div className="dr-preview">
      <div className="dr-pv-head">
        <div style={{ minWidth: 0 }}>
          <div className="dr-pv-eyebrow">DRAFT · <b>{d.id}</b> · status=draft</div>
          <div className="dr-pv-tags">
            <DrKind kind={d.kind} />
            <DrSrc source={d.source} />
            <DrVChip v={d.verify} />
          </div>
        </div>
      </div>

      <div className={"dr-diag tone-" + diagTone}>
        <span className="dr-diag-ic"><Icon name={DR_VERIFY[d.verify.state].icon} size={16} /></span>
        <div className="dr-diag-body">
          <div className="dr-diag-title">{diagTitle}</div>
          {d.verify.reason
            ? <div className="dr-diag-reason"><span className="lab">驳回理由 · </span>{d.verify.reason}</div>
            : <div className="dr-diag-reason">这条草稿还没过 verify。点「启用」会跑一遍判题（可能耗时），通过即转 active。</div>}
        </div>
      </div>

      <div className="dr-pv-body"><DrPreviewBody d={d} showMeta={showMeta} layout={layout} /></div>

      {Actions}
    </div>
  );
}

/* ---- force-enable confirm modal ------------------------------------ */
const FORCE_REASONS = ["题面我已人工核对，质量无误", "考点紧缺，先上线再补验", "verify 规则误报，非真实缺陷", "来源可信，本批免验"];

function DrForceModal({ d, onClose, onConfirm }) {
  const [reason, setReason] = React.useState("");
  const ref = React.useRef(null);
  useFocusTrap(true, onClose, ref);
  const ok = reason.trim().length >= 4;
  return ReactDOM.createPortal((
    <div className="dr-modal-wrap">
      <div className="scrim open" onClick={onClose} style={{ zIndex: 0 }} />
      <div className="dr-modal" ref={ref} role="dialog" aria-modal="true" aria-label="强制启用确认">
        <div className="dr-modal-head">
          <span className="dr-modal-ic"><Icon name="bolt" size={18} /></span>
          <span className="dr-modal-title">强制启用 · 绕过验证</span>
        </div>
        <div className="dr-modal-body">
          <div className="dr-bypass">
            <span className="dr-bypass-ic"><Icon name="alert" size={18} /></span>
            <span className="dr-bypass-text"><b>这条草稿将跳过 verify 直接转为 active。</b>系统不会再校对题面与答案的正误。此操作记入 event log（<span style={{ fontFamily: "var(--font-mono)" }}>actor=user · action=force_enable</span>），必须填写理由留痕。</span>
          </div>
          <div className="dr-modal-q"><QInline text={d.stem} /></div>
          <label className="dr-field-label" htmlFor="dr-reason">绕过验证的理由 <span className="req">*</span> 必填</label>
          <textarea id="dr-reason" className="dr-reason-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="说明为什么这条草稿可以不经 verify 直接启用…" />
          <div className="dr-reason-chips">
            {FORCE_REASONS.map((r) => <button key={r} type="button" className="dr-reason-chip" onClick={() => setReason(r)}>{r}</button>)}
          </div>
          <div className="dr-reason-hint"><Icon name="alert" size={12} />理由至少 4 个字，会与本次 override 一并存档。</div>
        </div>
        <div className="dr-modal-foot">
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <button className="btn btn-danger" disabled={!ok} onClick={() => onConfirm(d.id, reason.trim())}>
            <Icon name="bolt" size={16} />确认强制启用
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

/* ---- toasts -------------------------------------------------------- */
function DrToasts({ items }) {
  if (!items.length) return null;
  return ReactDOM.createPortal(
    <div className="dr-toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={"dr-toast " + (t.kind || "")}>
          <Icon name={t.kind === "good" ? "checkCircle" : t.kind === "warn" ? "alert" : "bolt"} size={15} />{t.text}
        </div>
      ))}
    </div>, document.body);
}

/* ---- main screen --------------------------------------------------- */
const DR_PAGE_SIZE = 8;
const DR_VERIFY_MS = 1150;

function ScreenDraftReview({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const layout = ui.reviewLayout === "compact" ? "compact" : "split";
  const showMeta = ui.aiMeta !== false;
  const volume = ui.draftVolume || "many";

  const [pool, setPool] = React.useState(() => draftPool(volume).map((d) => ({ ...d, verify: { ...d.verify } })));
  const [query, setQuery] = React.useState("");
  const [source, setSource] = React.useState("all");
  const [kind, setKind] = React.useState("all");
  const [vstatus, setVstatus] = React.useState("all");
  const [page, setPage] = React.useState(0);
  const [activeId, setActiveId] = React.useState(null);
  const [picked, setPicked] = React.useState(() => new Set());   // batch checkbox selection
  const [verifying, setVerifying] = React.useState({});          // id → 'pending' | 'passed'
  const [gone, setGone] = React.useState(() => new Set());       // ids fading out
  const [forceDraft, setForceDraft] = React.useState(null);
  const [toasts, setToasts] = React.useState([]);

  const poolRef = React.useRef(pool); poolRef.current = pool;

  // reset pool when the demo volume tweak changes
  React.useEffect(() => {
    setPool(draftPool(volume).map((d) => ({ ...d, verify: { ...d.verify } })));
    setPicked(new Set()); setGone(new Set()); setVerifying({}); setPage(0); setActiveId(null);
  }, [volume]);

  const plain = (s) => (s || "").replace(/[*`$＿]/g, "");
  const matchQuery = (d) => !query.trim() || (plain(d.stem) + " " + plain(d.passage) + " " + d.id + " " + d.knowledge.map(drkLabel).join(" ")).toLowerCase().includes(query.toLowerCase());
  const visible = pool.filter((d) => !gone.has(d.id));
  const filtered = visible.filter((d) =>
    (source === "all" || d.source === source) &&
    (kind === "all" || d.kind === kind) &&
    (vstatus === "all" || d.verify.state === vstatus) &&
    matchQuery(d)
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / DR_PAGE_SIZE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(curPage * DR_PAGE_SIZE, curPage * DR_PAGE_SIZE + DR_PAGE_SIZE);

  // keep an active selection valid
  React.useEffect(() => {
    if (!filtered.length) { if (activeId !== null) setActiveId(null); return; }
    if (!filtered.some((d) => d.id === activeId)) setActiveId(filtered[0].id);
  }, [filtered.map((d) => d.id).join(","), activeId]);

  const active = pool.find((d) => d.id === activeId) || null;

  const activeFilters = (source !== "all") + (kind !== "all") + (vstatus !== "all") + (query.trim() ? 1 : 0);
  const reset = () => { setSource("all"); setKind("all"); setVstatus("all"); setQuery(""); setPage(0); };

  const pushToast = (kind, text) => {
    const id = "t" + Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2600);
  };

  // verify one draft; calls done() once resolved
  const runVerify = (id, done) => {
    setVerifying((v) => ({ ...v, [id]: "pending" }));
    setTimeout(() => {
      const d = poolRef.current.find((x) => x.id === id);
      const out = verifyOutcome(d);
      if (out.pass) {
        setVerifying((v) => ({ ...v, [id]: "passed" }));
        setTimeout(() => {
          setGone((g) => new Set(g).add(id));
          setVerifying((v) => { const n = { ...v }; delete n[id]; return n; });
          setPicked((p) => { const n = new Set(p); n.delete(id); return n; });
          pushToast("good", "「" + id + "」通过验证 · 已转 active");
          done && done();
        }, 620);
      } else {
        setPool((p) => p.map((x) => x.id === id ? { ...x, verify: { state: "failed", reason: out.reason } } : x));
        setVerifying((v) => { const n = { ...v }; delete n[id]; return n; });
        pushToast("warn", "「" + id + "」验证未过");
        done && done();
      }
    }, DR_VERIFY_MS);
  };

  const enableOne = (id) => runVerify(id);

  const runBatch = () => {
    const ids = filtered.filter((d) => picked.has(d.id)).map((d) => d.id);
    if (!ids.length) return;
    let i = 0;
    const step = () => { if (i >= ids.length) return; const id = ids[i++]; runVerify(id, step); };
    step();
  };

  const skipOne = (id) => {
    setGone((g) => new Set(g).add(id));
    setPicked((p) => { const n = new Set(p); n.delete(id); return n; });
    pushToast(null, "「" + id + "」已跳过 · 移出待审池");
  };

  const confirmForce = (id, reason) => {
    setForceDraft(null);
    setGone((g) => new Set(g).add(id));
    setPicked((p) => { const n = new Set(p); n.delete(id); return n; });
    pushToast("warn", "「" + id + "」已强制启用 · override 已留痕");
  };

  const togglePick = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pickedHere = filtered.filter((d) => picked.has(d.id)).length;
  const allPicked = filtered.length > 0 && pickedHere === filtered.length;
  const toggleAll = () => setPicked((p) => {
    const n = new Set(p);
    if (allPicked) filtered.forEach((d) => n.delete(d.id));
    else filtered.forEach((d) => n.add(d.id));
    return n;
  });

  // KPI counts (over full pool, not filtered)
  const nUnver = visible.filter((d) => d.verify.state === "unverified").length;
  const nReview = visible.filter((d) => d.verify.state === "needs_review").length;
  const nFailed = visible.filter((d) => d.verify.state === "failed").length;
  const totalCost = visible.reduce((a, d) => a + (d.origin ? d.origin.cost : 0), 0);

  const V_TABS = [["all", "全部", visible.length], ["unverified", "未验证", nUnver], ["needs_review", "待复核", nReview], ["failed", "验证未过", nFailed]];

  return (
    <div className="page dr-page view" data-dr-layout={layout}>
      <div className="page-head">
        <div className="eyebrow">REVIEW · draft 池 · events action=propose subject_kind=question status=draft</div>
        <div className="page-head-row">
          <h1 className="page-title serif">草稿审核</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="quiz" onClick={() => go("questions")}>题库</Btn>
            <Btn variant="ghost" icon="record" onClick={() => go("record")}>录入新题</Btn>
          </div>
        </div>
      </div>

      {/* summary ribbon */}
      <div className="dr-ribbon">
        <div className="dr-stat"><span className="dr-stat-n tnum">{visible.length}<span className="u">条待审</span></span><span className="dr-stat-l">draft pool</span></div>
        <div className="dr-stat"><span className="dr-stat-n tnum">{nUnver}</span><span className="dr-stat-l">未验证</span></div>
        <div className="dr-stat warn"><span className="dr-stat-n tnum">{nReview + nFailed}</span><span className="dr-stat-l">待复核 / 未过</span></div>
        <div className="dr-ribbon-spacer" />
        {showMeta && <div className="dr-cost"><Icon name="bolt" size={13} />本池生成成本 ${totalCost.toFixed(3)}</div>}
      </div>

      {/* toolbar */}
      <div className="dr-toolbar">
        <label className="dr-search">
          <Icon name="search" size={15} />
          <input placeholder="搜索题面文本、知识点、草稿号…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          {query && <button className="dr-search-clear" onClick={() => setQuery("")} aria-label="清除"><Icon name="close" size={13} /></button>}
        </label>
        <div className="dr-fgroup"><span className="dr-fgroup-l">来源</span>
          <select className="dr-select" value={source} onChange={(e) => { setSource(e.target.value); setPage(0); }}>
            <option value="all">全部来源</option>
            {Object.entries(DR_SOURCE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div className="dr-fgroup"><span className="dr-fgroup-l">题型</span>
          <select className="dr-select" value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }}>
            <option value="all">全部题型</option>
            {Object.entries(QKIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        {activeFilters > 0 && <button className="dr-reset" onClick={reset}><Icon name="close" size={12} />清除 {activeFilters} 项</button>}
      </div>

      {/* verify-status segmented tabs */}
      <div className="dr-toolbar" style={{ marginBottom: "var(--s-3)" }}>
        <div className="dr-seg" role="tablist">
          {V_TABS.map(([k, l, n]) => (
            <button key={k} role="tab" aria-selected={vstatus === k} className={vstatus === k ? "on" : ""} onClick={() => { setVstatus(k); setPage(0); }}>
              {k !== "all" && <span className={"dr-vdot tone-" + DR_VERIFY[k].tone} />}{l}<span className="seg-n">{n}</span>
            </button>
          ))}
        </div>
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="草稿池加载失败。"
        skeleton={<Card pad><SkLines rows={6} /></Card>}
        empty={<Card padLg><EmptyState icon="checkCircle" title="待审草稿池是空的，太好了" text="没有等待审核的草稿。AI 夜间生成、web 采集或你手动录入的新题会先落到这里，等你逐条放行。" action={<Btn variant="secondary" icon="record" onClick={() => go("record")}>去录入</Btn>} /></Card>}>

        {volume === "none" || visible.length === 0 ? (
          <Card padLg><EmptyState icon="checkCircle" title="待审草稿池是空的，太好了" text="没有等待审核的草稿。AI 夜间生成、web 采集或你手动录入的新题会先落到这里，等你逐条放行。" action={<Btn variant="secondary" icon="record" onClick={() => go("record")}>去录入</Btn>} /></Card>
        ) : (
          <React.Fragment>
            {/* batch bar */}
            <div className={"dr-batchbar" + (pickedHere > 0 ? " is-armed" : "")}>
              <input type="checkbox" className={"dr-check" + (!allPicked && pickedHere > 0 ? " is-indet" : "")} checked={allPicked} onChange={toggleAll} aria-label="全选" />
              {pickedHere > 0 ? (
                <React.Fragment>
                  <span className="dr-batch-label">已选 <b>{pickedHere}</b> 条</span>
                  <Btn size="sm" variant="primary" icon="check" onClick={runBatch}>verify 选中（队列逐条跑）</Btn>
                  <Btn size="sm" variant="ghost" onClick={() => setPicked(new Set())}>取消选择</Btn>
                  <span className="dr-batch-spacer" />
                  <span className="dr-batch-hint">通过的转 active 并移出池，未过的留下显示驳回理由</span>
                </React.Fragment>
              ) : (
                <React.Fragment>
                  <span className="dr-batch-label">勾选多条可批量送 verify</span>
                  <span className="dr-batch-spacer" />
                  <span className="dr-batch-hint">{filtered.length} 条符合当前筛选</span>
                </React.Fragment>
              )}
            </div>

            <div className="dr-body">
              {/* list */}
              <div className="dr-list">
                {pageRows.length === 0 ? (
                  <div style={{ padding: "var(--s-8) var(--s-5)" }}><EmptyState icon="search" title="没有匹配的草稿" text="放宽筛选或清除搜索。" action={<Btn size="sm" variant="secondary" icon="close" onClick={reset}>清除筛选</Btn>} /></div>
                ) : pageRows.map((d) => {
                  const vs = verifying[d.id];
                  return (
                    <button key={d.id} className={"dr-row" + (activeId === d.id ? " is-active" : "") + (gone.has(d.id) ? " is-gone" : "") + (vs === "pending" ? " is-pending" : "") + (vs === "passed" ? " is-passed" : "")}
                      onClick={() => setActiveId(d.id)}>
                      <span className="dr-row-pick" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="dr-check" checked={picked.has(d.id)} onChange={() => togglePick(d.id)} aria-label={"选择 " + d.id} />
                      </span>
                      <span className="dr-row-main">
                        <span className="dr-row-stem"><QInline text={d.stem} /></span>
                        <span className="dr-row-meta">
                          <DrKind kind={d.kind} />
                          <DrSrc source={d.source} />
                          {vs === "pending" ? <span className="dr-rowq pending"><span className="dr-spin" />verify 中…</span>
                            : vs === "passed" ? <span className="dr-rowq passed"><Icon name="check" size={12} />已通过</span>
                            : <DrVChip v={d.verify} />}
                          <span className="dr-time">{d.when}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}

                {/* pager */}
                {pageCount > 1 && (
                  <div className="dr-pager">
                    <span className="dr-pager-info">第 {curPage * DR_PAGE_SIZE + 1}–{Math.min((curPage + 1) * DR_PAGE_SIZE, filtered.length)} / {filtered.length}</span>
                    <div className="dr-pager-ctrl">
                      <button className="dr-pg" disabled={curPage === 0} onClick={() => setPage(curPage - 1)} aria-label="上一页"><Icon name="arrowL" size={13} /></button>
                      {Array.from({ length: pageCount }).map((_, i) => (
                        <button key={i} className={"dr-pg" + (i === curPage ? " on" : "")} onClick={() => setPage(i)}>{i + 1}</button>
                      ))}
                      <button className="dr-pg" disabled={curPage === pageCount - 1} onClick={() => setPage(curPage + 1)} aria-label="下一页"><Icon name="arrow" size={13} /></button>
                    </div>
                  </div>
                )}
              </div>

              {/* preview */}
              <DrPreview d={active} layout={layout} showMeta={showMeta} verifying={verifying}
                onEnable={enableOne} onForce={(d) => setForceDraft(d)} onSkip={skipOne} />
            </div>
          </React.Fragment>
        )}
      </Stateful>

      {forceDraft && <DrForceModal d={forceDraft} onClose={() => setForceDraft(null)} onConfirm={confirmForce} />}
      <DrToasts items={toasts} />
    </div>
  );
}

window.ScreenDraftReview = ScreenDraftReview;
