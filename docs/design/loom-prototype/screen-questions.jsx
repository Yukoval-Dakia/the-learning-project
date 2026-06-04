// Loom · /questions (题库) — P5. Multi-axis filter + dense rich rows.
function QFilterSelect({ label, value, onChange, options }) {
  return (
    <label className="qf-select">
      <span className="qf-select-l">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}
      </select>
    </label>
  );
}

function QuestionRow({ q, go }) {
  const lin = Q_LINEAGE[q.lineage];
  const gr = Q_GROUNDING[q.grounding], cp = Q_COPY[q.copy], tier = Q_TIER[q.sourceTier];
  const diffPct = Math.round(q.difficulty * 100);
  const diffTone = q.difficulty >= 0.66 ? "again" : q.difficulty >= 0.45 ? "hard" : "good";
  return (
    <div className="q-row" role="row" onClick={() => go("knowledge/" + q.knowledge[0])}>
      <div className="q-lineage" title={lin.label}>
        <span className="q-lineage-glyph">{lin.glyph}</span>
        <span className="q-lineage-l">{lin.label}</span>
        {q.lineage === "root" && q.variants > 0 && <span className="q-variants mono">+{q.variants}</span>}
        {q.root && <span className="q-root mono">← {q.root}</span>}
      </div>

      <div className="q-main">
        <div className="q-stem wenyan">{q.stem}</div>
        <div className="q-chips">
          {q.knowledge.map((k) => <span key={k} className="chip chip-k mono">{k}</span>)}
        </div>
      </div>

      <div className="q-kind"><span className="badge tone-neutral">{Q_KIND[q.kind]}</span></div>

      <div className="q-source">
        <span className={"badge tone-" + tier.tone}>{tier.label}</span>
        <span className="meta">{Q_SOURCE[q.source]}</span>
      </div>

      <div className="q-flags">
        <span className={"q-flag tone-" + gr.tone} title={"grounding: " + q.grounding}><Icon name={gr.icon} size={12} />{gr.label}</span>
        <span className={"q-flag tone-" + cp.tone} title={"copy safety: " + q.copy}><Icon name={cp.icon} size={12} />{cp.label}</span>
      </div>

      <div className="q-diff">
        <div className="q-diff-track"><span className={"tone-" + diffTone} style={{ width: diffPct + "%" }} /></div>
        <span className="meta mono">{diffPct}</span>
      </div>

      <div className="q-status"><span className={"badge tone-" + Q_STATUS[q.status].tone}>{Q_STATUS[q.status].label}</span></div>
    </div>
  );
}

function ScreenQuestions({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [status, setStatus] = React.useState("active");
  const [source, setSource] = React.useState("all");
  const [kind, setKind] = React.useState("all");
  const [diffMin, setDiffMin] = React.useState(0);
  const [diffMax, setDiffMax] = React.useState(100);
  const [labels, setLabels] = React.useState([]);   // selected knowledge chips
  const allLabels = [...new Set(DATA.questions.flatMap((q) => q.knowledge))];

  const toggleLabel = (k) => setLabels((xs) => xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]);
  const reset = () => { setStatus("all"); setSource("all"); setKind("all"); setDiffMin(0); setDiffMax(100); setLabels([]); };

  const filtered = DATA.questions.filter((q) =>
    (status === "all" || q.status === status) &&
    (source === "all" || q.source === source) &&
    (kind === "all" || q.kind === kind) &&
    (Math.round(q.difficulty * 100) >= diffMin && Math.round(q.difficulty * 100) <= diffMax) &&
    (labels.length === 0 || q.knowledge.some((k) => labels.includes(k)))
  );
  const activeFilters = (status !== "all") + (source !== "all") + (kind !== "all") + (diffMin > 0 || diffMax < 100 ? 1 : 0) + (labels.length ? 1 : 0);

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">QUESTIONS · question WHERE status,source,kind,difficulty,knowledge</div>
        <div className="page-head-row">
          <h1 className="page-title serif">题库</h1>
          <div className="hero-cta">
            <Btn variant="ghost" icon="sparkle">AI 生成变体</Btn>
            <Btn variant="primary" icon="plus">新建题目</Btn>
          </div>
        </div>
      </div>

      {/* status tabs */}
      <div className="status-tabs" role="tablist">
        {[["active", "启用"], ["draft", "草稿"], ["all", "全部"]].map(([s, l]) => {
          const n = s === "all" ? DATA.questions.length : DATA.questions.filter((q) => q.status === s).length;
          return <button key={s} role="tab" aria-selected={status === s} className={"status-tab" + (status === s ? " on" : "")} onClick={() => setStatus(s)}>{l}<span className="mono status-tab-n">{n}</span></button>;
        })}
      </div>

      {/* filter bar */}
      <div className="q-filterbar">
        <QFilterSelect label="来源" value={source} onChange={setSource} options={[["all", "全部来源"], ...Object.entries(Q_SOURCE)]} />
        <QFilterSelect label="题型" value={kind} onChange={setKind} options={[["all", "全部题型"], ...Object.entries(Q_KIND)]} />
        <div className="qf-range">
          <span className="qf-select-l">难度</span>
          <input className="field-input qf-num" type="number" min="0" max="100" value={diffMin} onChange={(e) => setDiffMin(+e.target.value)} />
          <span className="meta">–</span>
          <input className="field-input qf-num" type="number" min="0" max="100" value={diffMax} onChange={(e) => setDiffMax(+e.target.value)} />
        </div>
        {activeFilters > 0 && <button className="qf-reset" onClick={reset}><Icon name="close" size={13} />清除 {activeFilters} 项</button>}
      </div>

      {/* knowledge label filter chips */}
      <div className="q-labelfilter">
        <span className="meta">知识点</span>
        {allLabels.map((k) => (
          <button key={k} className={"filter-chip mono" + (labels.includes(k) ? " on" : "")} onClick={() => toggleLabel(k)}>
            {labels.includes(k) && <Icon name="check" size={11} />}{k}
          </button>
        ))}
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="题库加载失败。"
        skeleton={<Card pad><SkLines rows={6} /></Card>}
        empty={<EmptyState icon="quiz" title="题库为空" text="从试卷录入或让 AI 生成题目。" />}>
        {filtered.length === 0 ? (
          <EmptyState icon="quiz" title="没有匹配的题目" text="放宽筛选条件，或清除全部筛选。" action={<Btn size="sm" variant="secondary" icon="close" onClick={reset}>清除筛选</Btn>} />
        ) : (
          <Card className="q-table">
            <div className="q-row q-head" role="row">
              <div>母题 / 变体</div><div>题面 · 知识点</div><div>题型</div><div>来源 · tier</div><div>溯源 · 安全</div><div>难度</div><div>状态</div>
            </div>
            <div className="stagger">
              {filtered.map((q) => <QuestionRow key={q.id} q={q} go={go} />)}
            </div>
          </Card>
        )}
        <div className="q-count meta">{filtered.length} / {DATA.questions.length} 题</div>
      </Stateful>
    </div>
  );
}
window.ScreenQuestions = ScreenQuestions;
