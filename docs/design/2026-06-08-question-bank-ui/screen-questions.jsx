// Loom · /questions (题库) — all questions. Search · filter · sort,
// composite expand, variant lineage, association micro-indicators.

function QDiffPips({ d }) {
  const tone = QDIFF[d].tone;
  return (
    <span className="qb-diff" title={"难度 " + d + " · " + QDIFF[d].word}>
      <span className="qb-diff-pips">
        {[1, 2, 3, 4, 5].map((i) => <span key={i} className={"qb-pip" + (i <= d ? " on tone-" + tone : "")} />)}
      </span>
      <span className="qb-diff-l">{QDIFF[d].word}</span>
    </span>
  );
}

function QKindBadge({ kind }) {
  const k = QKIND[kind];
  return <span className="qb-kind"><Icon name={k.icon} size={13} />{k.label}</span>;
}

function QSourceTag({ source }) {
  const s = QSOURCE[source];
  return <span className={"qb-source tone-" + s.tone}><Icon name={s.icon} size={13} />{s.label}</span>;
}

function QIndicators({ q }) {
  const a = qAssoc(q);
  return (
    <div className="qb-tags">
      {q.knowledge.map((k) => (
        <span key={k} className="qb-ktag"><Icon name="tag" size={11} />{qkLabel(k)}</span>
      ))}
      <span style={{ flex: 1 }} />
      {a.attempts > 0 && <span className="qb-ind attempts" title="历史作答次数"><Icon name="history" size={12} />{a.attempts}</span>}
      {a.review > 0 && <span className="qb-ind review" title="在 FSRS 复习队列"><Icon name="review" size={12} />复习</span>}
      {a.mistakes > 0 && <span className="qb-ind mistakes" title="关联错题记录"><Icon name="mistakes" size={12} />{a.mistakes}</span>}
      {a.papers > 0 && <span className="qb-ind paper" title="被试卷引用"><Icon name="doc" size={12} />{a.papers} 卷</span>}
    </div>
  );
}

function QRow({ q, go, expanded, onToggle, isChild }) {
  const isComposite = q.composite;
  const glyphCls = q.lineage === "variant" ? " is-variant" : q.lineage === "part" ? " is-part" : "";
  const glyph = q.lineage === "variant" ? "◇" : q.lineage === "part" ? "▫" : "◆";
  return (
    <div className={"qb-row" + (isChild ? " is-child" : "")} role="button" tabIndex={0}
      onClick={() => go("questions/" + q.id)}
      onKeyDown={(e) => { if (e.key === "Enter") go("questions/" + q.id); }}>
      <div className="qb-rail">
        {isComposite ? (
          <button className={"qb-expand" + (expanded ? " open" : "")} title={expanded ? "收起小题" : "展开小题"}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <Icon name="arrow" size={13} />
          </button>
        ) : isChild ? (
          <span className="qb-subidx">{q.subIndex}</span>
        ) : (
          <span className={"qb-glyph" + glyphCls} title={q.lineage === "variant" ? "AI 变体" : "母题"}>{glyph}</span>
        )}
      </div>

      <div className="qb-main">
        <div className="qb-stem">
          {isComposite && <span className="qb-ktag" style={{ marginRight: 6, verticalAlign: 1 }}><Icon name="layers" size={11} />大题 · {q.children.length} 小题</span>}
          <QInline text={q.stem} />
        </div>
        <QIndicators q={q} />
      </div>

      <div className="qb-aside">
        <QKindBadge kind={q.kind} />
        <QDiffPips d={q.difficulty} />
        <QSourceTag source={q.source} />
        <span className="qb-time">{q.status === "draft" && <span className="qb-draftdot" style={{ marginRight: 4 }} />}{q.created}</span>
      </div>
    </div>
  );
}

const QB_SOURCES = [["all", "全部来源"], ...Object.entries(QSOURCE).map(([k, v]) => [k, v.label])];
const QB_KINDS = [["all", "全部题型"], ...Object.entries(QKIND).map(([k, v]) => [k, v.label])];

function ScreenQuestions({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [status, setStatus] = React.useState("all");
  const [source, setSource] = React.useState("all");
  const [kind, setKind] = React.useState("all");
  const [diffs, setDiffs] = React.useState([]);      // selected difficulty pips
  const [labels, setLabels] = React.useState([]);    // selected knowledge ids
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState("time");    // time | diff
  const [dir, setDir] = React.useState("desc");
  const [open, setOpen] = React.useState(() => new Set());

  const top = qTopLevel();
  const allLabels = [...new Set(DATA.questions.flatMap((q) => q.knowledge))];
  const toggleLabel = (k) => setLabels((xs) => xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]);
  const toggleDiff = (d) => setDiffs((xs) => xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]);
  const toggleOpen = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const reset = () => { setStatus("all"); setSource("all"); setKind("all"); setDiffs([]); setLabels([]); setQuery(""); };

  const plain = (s) => (s || "").replace(/[*`$＿]/g, "");
  const matchQuery = (q) => {
    if (!query.trim()) return true;
    const hay = [plain(q.stem), plain(q.passage), q.id, ...q.knowledge.map(qkLabel)].join(" ").toLowerCase();
    // composite also matches if any child matches
    const kids = qChildren(q).some((c) => plain(c.stem).includes(query) || c.id.includes(query));
    return hay.includes(query.toLowerCase()) || kids;
  };
  const filtered = top.filter((q) =>
    (status === "all" || q.status === status) &&
    (source === "all" || q.source === source) &&
    (kind === "all" || q.kind === kind || (q.composite && qChildren(q).some((c) => c.kind === kind))) &&
    (diffs.length === 0 || diffs.includes(q.difficulty)) &&
    (labels.length === 0 || q.knowledge.some((k) => labels.includes(k)) || qChildren(q).some((c) => c.knowledge.some((k) => labels.includes(k)))) &&
    matchQuery(q)
  ).sort((a, b) => {
    const v = sort === "diff" ? a.difficulty - b.difficulty : a.created.localeCompare(b.created);
    return dir === "asc" ? v : -v;
  });

  const activeFilters = (status !== "all") + (source !== "all") + (kind !== "all") + (diffs.length ? 1 : 0) + (labels.length ? 1 : 0) + (query.trim() ? 1 : 0);
  const totalQ = DATA.questions.length;
  const draftN = top.filter((q) => q.status === "draft").length;
  const reviewN = top.filter((q) => qAssoc(q).review > 0).length;

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">QUESTIONS · question 全集 · 含变体 / 大题-小题 / 各录入来源</div>
        <div className="page-head-row">
          <h1 className="page-title serif">题库</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="sparkle">AI 生成变体</Btn>
            <Btn variant="primary" icon="plus" onClick={() => go("record")}>新建题目</Btn>
          </div>
        </div>
      </div>

      {/* summary ribbon */}
      <div className="qb-ribbon">
        <div className="qb-stat"><span className="qb-stat-n tnum">{top.length}<span className="u">题（顶层）</span></span><span className="qb-stat-l">含 {totalQ - top.length} 道小题</span></div>
        <div className="qb-stat"><span className="qb-stat-n tnum">{top.length - draftN}</span><span className="qb-stat-l">正式</span></div>
        <div className="qb-stat accent"><span className="qb-stat-n tnum">{draftN}</span><span className="qb-stat-l">草稿待审</span></div>
        <div className="qb-stat"><span className="qb-stat-n tnum">{reviewN}</span><span className="qb-stat-l">在复习队列</span></div>
      </div>

      {/* toolbar: search + sort */}
      <div className="qb-toolbar">
        <label className="qb-search">
          <Icon name="search" size={16} />
          <input placeholder="搜索题面文本、知识点、题号…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="qb-search-clear" onClick={() => setQuery("")} aria-label="清除"><Icon name="close" size={14} /></button>}
        </label>
        <div className="qb-sort">
          <span className="qb-sort-l">排序</span>
          <div className="qb-seg">
            <button className={sort === "time" ? "on" : ""} onClick={() => setSort("time")}><Icon name="clock" size={13} />时间</button>
            <button className={sort === "diff" ? "on" : ""} onClick={() => setSort("diff")}><Icon name="bolt" size={13} />难度</button>
          </div>
          <button className="qb-seg" onClick={() => setDir((d) => d === "asc" ? "desc" : "asc")} title="切换升降序" style={{ cursor: "pointer" }}>
            <span className="qb-dir" style={{ padding: "5px 9px" }}>{dir === "asc" ? "↑ 升" : "↓ 降"}</span>
          </button>
        </div>
      </div>

      {/* status tabs */}
      <div className="qb-tabs" role="tablist">
        {[["all", "全部"], ["active", "正式"], ["draft", "草稿"]].map(([s, l]) => {
          const n = s === "all" ? top.length : top.filter((q) => q.status === s).length;
          return <button key={s} role="tab" aria-selected={status === s} className={"qb-tab" + (status === s ? " on" : "")} onClick={() => setStatus(s)}>{l}<span className="qb-tab-n">{n}</span></button>;
        })}
      </div>

      {/* filter bar */}
      <div className="qb-filterbar">
        <div className="qf2"><span className="qf2-l">来源</span>
          <select value={source} onChange={(e) => setSource(e.target.value)}>{QB_SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="qf2"><span className="qf2-l">题型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>{QB_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="qf2"><span className="qf2-l">难度</span>
          <span className="qf2-diff">{[1, 2, 3, 4, 5].map((d) => <button key={d} className={"qf2-pip" + (diffs.includes(d) ? " on" : "")} onClick={() => toggleDiff(d)}>{d}</button>)}</span></div>
        {activeFilters > 0 && <button className="qf2-reset" onClick={reset}><Icon name="close" size={13} />清除 {activeFilters} 项筛选</button>}
      </div>

      {/* knowledge label filter */}
      <div className="qb-klabel">
        <span className="qb-klabel-l">知识点</span>
        {allLabels.map((k) => (
          <button key={k} className={"kchip" + (labels.includes(k) ? " on" : "")} onClick={() => toggleLabel(k)}>
            {labels.includes(k) && <Icon name="check" size={11} />}{qkLabel(k)}
          </button>
        ))}
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="题库加载失败。"
        skeleton={<Card pad><SkLines rows={6} /></Card>}
        empty={<Card padLg><EmptyState icon="quiz" title="题库还是空的" text="拍一道题、上传一张试卷，或让 AI 从你的错题生成变体，题目会自动入库。"
          action={<div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}><Btn variant="primary" icon="camera" onClick={() => go("record")}>拍照录入</Btn><Btn variant="secondary" icon="record" onClick={() => go("record")}>上传试卷</Btn></div>} /></Card>}>
        {filtered.length === 0 ? (
          <Card padLg><EmptyState icon="search" title="没有匹配的题目" text="放宽筛选条件或清除搜索。" action={<Btn size="sm" variant="secondary" icon="close" onClick={reset}>清除全部</Btn>} /></Card>
        ) : (
          <Card className="qb-list">
            {filtered.map((q) => (
              <React.Fragment key={q.id}>
                <QRow q={q} go={go} expanded={open.has(q.id)} onToggle={() => toggleOpen(q.id)} />
                {q.composite && open.has(q.id) && qChildren(q).map((c) => (
                  <QRow key={c.id} q={c} go={go} isChild />
                ))}
              </React.Fragment>
            ))}
          </Card>
        )}
        <div className="qb-count">
          <span className="meta">显示 {filtered.length} / {top.length} 道顶层题目</span>
          {activeFilters > 0 && <button className="qf2-reset" style={{ margin: 0 }} onClick={reset}><Icon name="refresh" size={13} />重置</button>}
        </div>
      </Stateful>
    </div>
  );
}
window.ScreenQuestions = ScreenQuestions;
