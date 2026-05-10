// Loom app — screen views.
// Each screen is a function component that reads/writes the in-memory store
// passed in as `db`. No real network — this is a click-thru prototype.

const fmtDate = (ts) => new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }).slice(0, 16);

// ─── Home ───────────────────────────────────────────────────
const HomeScreen = ({ db, nav }) => {
  const dueCount = db.mistakes.filter(m => m.fsrs_state && m.fsrs_state.due * 1000 < Date.now()).length;
  const pendingAttr = db.mistakes.filter(m => !m.cause).length;
  return (
    <main className="page narrow">
      <PageHeader title="Loom" eyebrow="编织 · 三股线" />
      <p className="lede">
        把错题、知识点、复习织成一张闭环。{" "}
        <a href="#" onClick={(e) => { e.preventDefault(); nav("review"); }}>开始今日复习 →</a>
      </p>
      <div className="dashboard">
        <Card>
          <div className="meta">今日待复习</div>
          <div className="big-num">{dueCount}</div>
          <Button variant="primary" onClick={() => nav("review")}>复习 →</Button>
        </Card>
        <Card>
          <div className="meta">归因中</div>
          <div className="big-num">{pendingAttr}</div>
          <Button variant="ghost" onClick={() => nav("mistakes")}>查看</Button>
        </Card>
        <Card>
          <div className="meta">学习项</div>
          <div className="big-num">{db.items.filter(i => i.status !== "done").length}</div>
          <Button variant="ghost" onClick={() => nav("items")}>管理</Button>
        </Card>
      </div>
    </main>
  );
};

// ─── Record ─────────────────────────────────────────────────
const RecordScreen = ({ db, setDb, nav }) => {
  const [prompt, setPrompt] = React.useState('"之"在「古之学者」中的用法?');
  const [reference, setReference] = React.useState("用在主谓之间，取消句子独立性。");
  const [wrong, setWrong] = React.useState("代词，指代「学者」。");
  const [kindIds, setKindIds] = React.useState(["k_xuci_zhi"]);
  const [cause, setCause] = React.useState("");
  const [err, setErr] = React.useState(null);

  const submit = (e) => {
    e.preventDefault();
    setErr(null);
    if (!prompt.trim() || !wrong.trim() || kindIds.length === 0) {
      setErr("题面、错答、知识点不能为空");
      return;
    }
    const id = `m_${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    setDb(d => ({
      ...d,
      mistakes: [{
        id, question_id: `q_${Date.now()}`,
        prompt_md: prompt, reference_md: reference, wrong_answer_md: wrong,
        knowledge_ids: kindIds,
        cause: cause ? { primary_category: cause, user_edited: true } : null,
        fsrs_state: { due: now, state: "new" },
        created_at: now,
      }, ...d.mistakes],
    }));
    nav("mistakes");
  };

  return (
    <main className="page narrow">
      <PageHeader title="录入错题" eyebrow="/record">
        <Button variant="ghost" onClick={() => nav("ingest")}>录整张卷子 →</Button>
      </PageHeader>
      <p className="lede">录完后 AttributionTask 会自动归因。失败不阻塞。</p>

      <form onSubmit={submit} className="form-stack">
        <label className="field">
          <span className="lbl">题面 *</span>
          <textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} />
        </label>
        <label className="field">
          <span className="lbl">参考答案（可空）</span>
          <textarea rows={2} value={reference} onChange={e => setReference(e.target.value)} />
        </label>
        <label className="field">
          <span className="lbl">错答 *</span>
          <textarea rows={2} value={wrong} onChange={e => setWrong(e.target.value)} />
        </label>

        <fieldset className="field-group">
          <legend>知识点 *（多选）</legend>
          <div className="chip-row">
            {db.knowledge.map(k => {
              const on = kindIds.includes(k.id);
              return (
                <button key={k.id} type="button"
                  className={`chip ${on ? "is-on" : ""}`}
                  onClick={() => setKindIds(on ? kindIds.filter(x => x !== k.id) : [...kindIds, k.id])}>
                  {k.name}
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="field">
          <span className="lbl">错因（留空 → AI 兜底）</span>
          <select value={cause} onChange={e => setCause(e.target.value)}>
            <option value="">— 留空，AI 兜底（Sub 3）—</option>
            {["concept", "knowledge_gap", "calculation", "reading", "memory",
              "expression", "method", "carelessness", "time_pressure", "other"].map(c =>
              <option key={c}>{c}</option>
            )}
          </select>
        </label>

        {err && <p className="err">{err}</p>}
        <div className="actions">
          <Button variant="primary" type="submit">提交</Button>
          <Button variant="secondary" type="button" onClick={() => nav("home")}>取消</Button>
        </div>
      </form>
    </main>
  );
};

// ─── Mistakes list ──────────────────────────────────────────
const MistakesScreen = ({ db, nav }) => {
  const rows = db.mistakes;
  const pendingCount = rows.filter(r => !r.cause).length;
  return (
    <main className="page narrow">
      <PageHeader title="错题列表" eyebrow="/mistakes">
        <Button variant="ghost" onClick={() => nav("knowledge-proposals")}>AI 知识点提议 →</Button>
      </PageHeader>
      <p className="lede">
        最近 {rows.length} 条 ·{" "}
        {pendingCount > 0
          ? <span style={{ color: "var(--hard-ink)" }}>归因中 {pendingCount} / 已归因 {rows.length - pendingCount}</span>
          : <span>全部归因完毕</span>
        }
        {" · "}<a href="#" onClick={(e) => { e.preventDefault(); nav("record"); }}>+ 录新错题</a>
      </p>
      <Button variant="primary" onClick={() => nav("review")}>开始复习 →</Button>

      <ul className="card-list">
        {rows.map(row => (
          <li key={row.id}>
            <Card>
              <div className="card-head">
                <span className="meta-mono">{fmtDate(row.created_at)}</span>
                <CauseBadge cause={row.cause} createdAt={row.created_at} />
              </div>
              <p className="prompt">{row.prompt_md}</p>
              <p className="line"><span className="meta">错答:</span> {row.wrong_answer_md}</p>
              <p className="meta">知识点: {row.knowledge_ids.map(id => db.knowledge.find(k => k.id === id)?.name || id).join(", ")}</p>
            </Card>
          </li>
        ))}
        {rows.length === 0 && <p className="empty">还没有错题。<a href="#" onClick={(e) => { e.preventDefault(); nav("record"); }}>先录一条</a>。</p>}
      </ul>
    </main>
  );
};

// ─── Review ─────────────────────────────────────────────────
const ReviewScreen = ({ db, setDb, nav }) => {
  const due = db.mistakes.filter(m => m.fsrs_state && m.fsrs_state.due * 1000 < Date.now());
  const [idx, setIdx] = React.useState(0);
  const [response, setResponse] = React.useState("");
  const current = due[idx];

  React.useEffect(() => { setResponse(""); }, [idx]);

  const submit = (rating) => {
    if (!current) return;
    setDb(d => ({
      ...d,
      mistakes: d.mistakes.map(m =>
        m.id === current.id
          ? { ...m, fsrs_state: { ...m.fsrs_state, due: (Date.now() / 1000) + (rating === "good" ? 86400 * 3 : rating === "hard" ? 86400 : 600) } }
          : m
      ),
    }));
    setIdx(i => i + 1);
  };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "TEXTAREA") return;
      if (e.key === "1") submit("again");
      else if (e.key === "2") submit("hard");
      else if (e.key === "3") submit("good");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (due.length === 0) return (
    <main className="page narrow">
      <h1>今天没有要复习的，太好了</h1>
      <p className="lede">
        <a href="#" onClick={(e) => { e.preventDefault(); nav("record"); }}>+ 录新错题</a>
        {" · "}
        <a href="#" onClick={(e) => { e.preventDefault(); nav("mistakes"); }}>看历史 →</a>
      </p>
    </main>
  );

  if (idx >= due.length) return (
    <main className="page narrow">
      <h1>今日复习完毕（{due.length} 条）</h1>
      <p className="lede"><a href="#" onClick={(e) => { e.preventDefault(); nav("mistakes"); }}>看错题历史 →</a></p>
    </main>
  );

  return (
    <main className="page narrow">
      <PageHeader title="复习" eyebrow={`/review · ${idx + 1} / ${due.length}`} />
      <p className="meta-line">
        知识点: {current.knowledge_ids.map(id => db.knowledge.find(k => k.id === id)?.name).join(", ")}
        {current.cause && <> · 错因: {current.cause.primary_category}{current.cause.confidence != null && ` (${Math.round(current.cause.confidence * 100)}%)`}</>}
      </p>

      <div className="passage-block">
        <div className="meta">题面</div>
        <p className="prose-cn">{current.prompt_md}</p>
      </div>

      {current.reference_md && (
        <details className="reveal">
          <summary>参考答案（点开看）</summary>
          <p className="prose-cn">{current.reference_md}</p>
        </details>
      )}

      <label className="field">
        <span className="lbl">你这次的答案 (可空)</span>
        <textarea rows={3} value={response} onChange={e => setResponse(e.target.value)} />
      </label>

      <div className="rating-row">
        <button type="button" className="btn btn-rating again" onClick={() => submit("again")}>
          <span>不会</span><kbd>1</kbd>
        </button>
        <button type="button" className="btn btn-rating hard" onClick={() => submit("hard")}>
          <span>模糊</span><kbd>2</kbd>
        </button>
        <button type="button" className="btn btn-rating good" onClick={() => submit("good")}>
          <span>会了</span><kbd>3</kbd>
        </button>
      </div>
    </main>
  );
};

// ─── Learning items ─────────────────────────────────────────
const ItemsScreen = ({ db, setDb, nav }) => {
  const [filter, setFilter] = React.useState("");
  const [title, setTitle] = React.useState("");
  const filtered = db.items.filter(i => filter === "" || i.status === filter);

  const create = () => {
    if (!title.trim()) return;
    const id = `li_${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    setDb(d => ({ ...d, items: [{ id, title, content: "", knowledge_ids: [], status: "pending", created_at: now, version: 1 }, ...d.items] }));
    setTitle("");
  };

  const transition = (item, newStatus) => {
    setDb(d => ({ ...d, items: d.items.map(i => i.id === item.id ? { ...i, status: newStatus, completed_at: newStatus === "done" ? Math.floor(Date.now() / 1000) : i.completed_at } : i) }));
  };

  return (
    <main className="page narrow">
      <PageHeader title="学习项" eyebrow="/learning-items" />

      <div className="seg-row">
        {[["", "全部"], ["pending", "待办"], ["in_progress", "进行中"], ["done", "已完成"]].map(([v, l]) =>
          <button key={v} type="button"
            className={`seg ${filter === v ? "is-on" : ""}`}
            onClick={() => setFilter(v)}>{l}</button>
        )}
      </div>

      <details className="add-block" open>
        <summary>+ 新增学习项</summary>
        <div className="add-body">
          <input type="text" value={title} onChange={e => setTitle(e.target.value)}
            placeholder="标题 (例: 学好之乎者也)" />
          <Button variant="primary" onClick={create}>创建</Button>
        </div>
      </details>

      <ul className="card-list">
        {filtered.map(item => (
          <li key={item.id}>
            <Card>
              <div className="card-head">
                <StatusBadge status={item.status} />
                <button className="x-btn" type="button" aria-label="delete">×</button>
              </div>
              <p className="prompt">{item.title}</p>
              <p className="meta">
                {item.status === "done" && item.completed_at
                  ? `完成于 ${fmtDate(item.completed_at).slice(0, 10)}`
                  : `创建于 ${fmtDate(item.created_at).slice(0, 10)}`}
              </p>
              <div className="card-actions">
                {item.status === "pending" && (<>
                  <Button variant="hard" onClick={() => transition(item, "in_progress")}>开始学</Button>
                  <Button variant="good" onClick={() => transition(item, "done")}>我学完了</Button>
                </>)}
                {item.status === "in_progress" && (<>
                  <Button variant="good" onClick={() => transition(item, "done")}>我学完了</Button>
                  <Button variant="ghost" onClick={() => transition(item, "pending")}>改回待办</Button>
                </>)}
                {item.status === "done" && (
                  <Button variant="hard" onClick={() => transition(item, "in_progress")}>重学</Button>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  );
};

// ─── Knowledge tree ─────────────────────────────────────────
const KnowledgeScreen = ({ db, nav }) => (
  <main className="page wide">
    <PageHeader title="/knowledge" eyebrow="knowledge graph">
      <Button variant="primary">AI review my tree</Button>
      <Button variant="secondary">Refresh</Button>
    </PageHeader>
    <p className="lede">
      Knowledge tree (read-only). Effective domain inherited from parent chain.
      AI review writes proposals to <a href="#" onClick={(e) => { e.preventDefault(); nav("knowledge-proposals"); }}>/knowledge/proposals</a>.
    </p>
    <table className="table">
      <thead>
        <tr><th>id</th><th>name</th><th>parent</th><th>domain</th><th>effective_domain</th></tr>
      </thead>
      <tbody>
        {db.knowledge.map(k => (
          <tr key={k.id}>
            <td className="mono">{k.id}</td>
            <td>{k.name}</td>
            <td className="mono muted">{k.parent_id || "—"}</td>
            <td className="muted">{k.domain || "(inherit)"}</td>
            <td>{k.effective_domain}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </main>
);

// ─── Ingest ─────────────────────────────────────────────────
const IngestScreen = ({ nav }) => (
  <main className="page narrow">
    <PageHeader title="录卷子" eyebrow="/ingest · vision pipeline" />
    <p className="lede">上传 1–5 张图片 → vision extract → 切块 → 审核 → 批量导入。</p>
    <div className="dropzone">
      <Icon name="upload" size={28} />
      <p>把图片拖到这里，或点击选择</p>
      <p className="meta">支持 jpg / png / heic · 单张 ≤ 8 MB</p>
    </div>
    <p className="lede">导入会自动落 <code>SourceAsset / SourceDocument / IngestionSession</code>。</p>
  </main>
);

Object.assign(window, { HomeScreen, RecordScreen, MistakesScreen, ReviewScreen, ItemsScreen, KnowledgeScreen, IngestScreen });
