// Loom — unified ingestion screen.
// Replaces the split /record (manual) + /ingest (vision_paper) flows.
// All three sources funnel through one IngestionSession → QuestionBlock → review → import.
// Mirrors PLANNING v0.12 + 2026-05-09 ingestion-pipeline-foundation spec.

const IngestModeTabs = ({ mode, setMode }) => {
  const modes = [
    { id: "manual",        label: "手动",     hint: "粘贴题面 / 答案 / 错答",        phase: "1a · shipped" },
    { id: "vision_single", label: "单题拍照", hint: "1 张图 → vision extract",      phase: "1.5 · shipped" },
    { id: "vision_paper",  label: "整张卷子", hint: "1–5 张图 → 多题切分 + 批改痕迹", phase: "1.5 · shipped" },
  ];
  return (
    <div className="ingest-tabs">
      {modes.map(m => (
        <button key={m.id} type="button"
          className={`ingest-tab ${mode === m.id ? "is-on" : ""}`}
          onClick={() => setMode(m.id)}>
          <span className="t">{m.label}</span>
          <span className="h">{m.hint}</span>
          <span className="p">{m.phase}</span>
        </button>
      ))}
    </div>
  );
};

const IngestPipelineTrace = ({ stage }) => {
  const stages = [
    { id: "uploaded",  label: "uploaded" },
    { id: "extracted", label: "extracted" },
    { id: "reviewed",  label: "reviewed" },
    { id: "imported",  label: "imported" },
  ];
  const i = stages.findIndex(s => s.id === stage);
  return (
    <ol className="pipeline">
      {stages.map((s, idx) => (
        <li key={s.id} className={`step ${idx < i ? "done" : idx === i ? "now" : ""}`}>
          <span className="dot" />
          <span className="lbl">{s.label}</span>
        </li>
      ))}
    </ol>
  );
};

// Manual form (current Phase 1a Sub 2 reality).
const ManualForm = ({ db, setDb, nav }) => {
  const [prompt, setPrompt] = React.useState('"之"在「古之学者」中的用法?');
  const [reference, setReference] = React.useState("用在主谓之间，取消句子独立性。");
  const [wrong, setWrong] = React.useState("代词，指代「学者」。");
  const [kindIds, setKindIds] = React.useState(["k_xuci_zhi"]);
  const [err, setErr] = React.useState(null);

  const submit = (e) => {
    e.preventDefault();
    setErr(null);
    if (!prompt.trim() || !wrong.trim() || kindIds.length === 0) {
      setErr("题面、错答、知识点不能为空"); return;
    }
    const id = `m_${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    setDb(d => ({
      ...d,
      mistakes: [{
        id, question_id: `q_${Date.now()}`,
        prompt_md: prompt, reference_md: reference, wrong_answer_md: wrong,
        knowledge_ids: kindIds,
        cause: null,
        source: "manual",
        fsrs_state: { due: now, state: "new" },
        created_at: now,
      }, ...d.mistakes],
    }));
    nav("mistakes");
  };

  return (
    <form onSubmit={submit} className="form-stack">
      <p className="meta">source = <code>manual</code> · 录入后立刻触发 AttributionTask（haiku 4.5 · 失败不阻塞）</p>
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
      {err && <p className="err">{err}</p>}
      <div className="actions">
        <Button variant="primary" type="submit">提交 → AttributionTask</Button>
      </div>
    </form>
  );
};

// Vision flow shared by single + paper. Page-level blocks → user merge → import.
const VisionFlow = ({ paper, db, setDb, nav }) => {
  const [stage, setStage] = React.useState("uploaded");
  const [blocks, setBlocks] = React.useState(null);
  const [selected, setSelected] = React.useState([]);

  const runExtract = () => {
    setStage("extracted");
    setBlocks(paper ? [
      { id: "qb1", page: 1, prompt: "(一) 阅读下面的文言文，完成下列小题。", confidence: 0.91, mark: null,        merged: false },
      { id: "qb2", page: 1, prompt: "1. 下列对加点词的解释,不正确的一项是 (   )", confidence: 0.88, mark: "wrong", merged: false },
      { id: "qb3", page: 2, prompt: "2. 翻译 「师者，所以传道受业解惑也」。", confidence: 0.62, mark: "partial", merged: false },
      { id: "qb4", page: 2, prompt: "3. 概括第一段中作者的观点 …(承接前题)", confidence: 0.81, mark: null,    merged: false },
    ] : [
      { id: "qb1", page: 1, prompt: '"之"在「古之学者必有师」的用法?', confidence: 0.94, mark: "wrong", merged: false },
    ]);
  };

  const toggle = (id) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const mergeSelected = () => {
    if (selected.length < 2) return;
    setBlocks(b => b
      .filter(x => !selected.includes(x.id))
      .concat({
        id: `qb_merged_${Date.now()}`,
        page: "merged",
        prompt: selected.map(id => b.find(x => x.id === id).prompt).join(" / "),
        confidence: 0.85, mark: "merged", merged: true,
        merged_from: selected,
      }));
    setSelected([]);
  };

  const review = () => setStage("reviewed");
  const importAll = () => {
    setStage("imported");
    const now = Math.floor(Date.now() / 1000);
    const wrongs = blocks.filter(b => b.mark === "wrong" || b.mark === "partial");
    setDb(d => ({
      ...d,
      mistakes: [
        ...wrongs.map((b, i) => ({
          id: `m_v_${now}_${i}`,
          question_id: `q_v_${now}_${i}`,
          prompt_md: b.prompt,
          reference_md: "",
          wrong_answer_md: "(从批改痕迹自动归入)",
          knowledge_ids: ["k_xuci_zhi"],
          cause: null,
          source: paper ? "vision_paper" : "vision_single",
          fsrs_state: { due: now, state: "new" },
          created_at: now,
        })),
        ...d.mistakes,
      ],
    }));
    setTimeout(() => nav("mistakes"), 600);
  };

  if (stage === "uploaded") return (
    <div className="form-stack">
      <p className="meta">
        source = <code>{paper ? "vision_paper" : "vision_single"}</code>
        {" · "}IngestionSession → SourceAsset → VisionExtractTask
      </p>
      <div className="dropzone">
        <Icon name="upload" size={28} />
        <p>把图片拖到这里，或点击选择</p>
        <p className="meta">{paper ? "1–5 张 · 卷子按页拍" : "单张题图"}</p>
      </div>
      <div className="actions">
        <Button variant="primary" onClick={runExtract}>模拟上传 + 提取</Button>
      </div>
    </div>
  );

  return (
    <div className="form-stack">
      <IngestPipelineTrace stage={stage} />
      <p className="meta">
        VisionExtractTask 输出 {blocks.length} 个 page-level QuestionBlock
        {paper && "（跨页题需手动合并 — Block Assembly A 路径 MVP）"}
      </p>
      <ul className="block-list">
        {blocks.map(b => (
          <li key={b.id}
            className={`block ${selected.includes(b.id) ? "is-sel" : ""} ${b.mark || ""}`}
            onClick={() => stage === "extracted" && toggle(b.id)}>
            <div className="block-head">
              <span className="meta-mono">page {b.page} · conf {Math.round(b.confidence * 100)}%</span>
              {b.mark === "wrong"   && <Badge tone="again">批改 · 错</Badge>}
              {b.mark === "partial" && <Badge tone="hard">批改 · 部分</Badge>}
              {b.mark === "merged"  && <Badge tone="info">已合并 {b.merged_from?.length}</Badge>}
            </div>
            <p className="block-prompt">{b.prompt}</p>
          </li>
        ))}
      </ul>
      {stage === "extracted" && (
        <div className="actions">
          <Button variant="secondary" disabled={selected.length < 2} onClick={mergeSelected}>
            合并选中 {selected.length || ""}
          </Button>
          <Button variant="ghost">拆分</Button>
          <Button variant="primary" onClick={review}>审核完成 →</Button>
        </div>
      )}
      {stage === "reviewed" && (
        <div className="actions">
          <Button variant="primary" onClick={importAll}>批量导入 · {blocks.filter(b => b.mark).length} 道 → AttributionTask</Button>
        </div>
      )}
      {stage === "imported" && <p className="meta">已写入 Mistake，触发 batch AttributionTask…</p>}
    </div>
  );
};

const RecordScreenUnified = ({ db, setDb, nav }) => {
  const [mode, setMode] = React.useState("manual");
  return (
    <main className="page narrow">
      <PageHeader title="录入" eyebrow="/record · 三条路径，一个管线">
        <Button variant="ghost" onClick={() => nav("today")}>今日 →</Button>
      </PageHeader>
      <p className="lede">
        手动 / 单题拍照 / 整张卷子，最终都落到同一张 <code>IngestionSession</code> 状态机：
        <span className="meta-mono"> uploaded → extracted → reviewed → imported</span>。
        参见 <a href="https://github.com/Yukoval-Dakia/Dakia-the-learning-project" target="_blank" rel="noopener">PLANNING v0.12 · Phase 1.5</a>。
      </p>
      <IngestModeTabs mode={mode} setMode={setMode} />
      {mode === "manual"        && <ManualForm db={db} setDb={setDb} nav={nav} />}
      {mode === "vision_single" && <VisionFlow paper={false} db={db} setDb={setDb} nav={nav} />}
      {mode === "vision_paper"  && <VisionFlow paper={true}  db={db} setDb={setDb} nav={nav} />}
    </main>
  );
};

Object.assign(window, { RecordScreenUnified });
