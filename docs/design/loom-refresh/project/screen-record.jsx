// Loom · Record (round-2a) — capture / ingestion. Contract §3B.
// mode tabs: context / manual / vision_single / vision_paper.
// + auto_enrolled review surface (revert). loading / empty / error throughout.

function ModeTabs({ mode, setMode }) {
  return (
    <div className="seg seg-wrap" role="tablist" aria-label="录入模式">
      {DATA.recordModes.map((m) => (
        <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? "on" : ""} onClick={() => setMode(m.id)}>
          <Icon name={m.icon} size={15} />{m.label}
        </button>
      ))}
    </div>
  );
}

// context (学习记录)
function ContextMode() {
  const [kind, setKind] = React.useState(DATA.contextKinds[0]);
  const [picked, setPicked] = React.useState(["k_xuci_zhi"]);
  const toggle = (tag) => setPicked((p) => p.includes(tag) ? p.filter((x) => x !== tag) : [...p, tag]);
  return (
    <Card pad>
      <div className="form-row">
        <label className="field-label">记录类型</label>
        <div className="chip-set" role="radiogroup">
          {DATA.contextKinds.map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={"chip" + (kind === k ? " is-on" : "")} onClick={() => setKind(k)}>{k}</button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label className="field-label">内容</label>
        <div className="composer" style={{ borderRadius: "var(--r-3)" }}>
          <textarea rows={4} placeholder={`记下你的${kind}……输入 @ 关联知识节点`} defaultValue="「之」用于主谓之间时取消句子独立性——今天才真正想通这点。" />
        </div>
      </div>
      <div className="form-row">
        <label className="field-label">知识点 <span className="meta">（多选）</span></label>
        <div className="chip-set">
          {DATA.kpoints.map((k) => (
            <button key={k.tag} className={"chip" + (picked.includes(k.tag) ? " is-on" : "")} onClick={() => toggle(k.tag)}>
              {picked.includes(k.tag) && <Icon name="check" size={12} />}{k.label}
            </button>
          ))}
        </div>
      </div>
      <div className="hero-cta"><Btn variant="primary" icon="check">保存记录</Btn><Btn variant="ghost" icon="sparkle">让 AI 抽取知识点</Btn></div>
    </Card>
  );
}

// manual (错题录入) — full mistake form
function ManualMode() {
  const [type, setType] = React.useState(DATA.mistakeTypes[0]);
  const [diff, setDiff] = React.useState(3);
  const [kp, setKp] = React.useState(["k_xuci_zhi"]);
  const [cause, setCause] = React.useState(["概念混淆"]);
  const tog = (set, v) => set((p) => p.includes(v) ? p.filter((x) => x !== v) : [...p, v]);
  return (
    <Card pad>
      <div className="form-row">
        <label className="field-label">题型</label>
        <div className="chip-set" role="radiogroup">
          {DATA.mistakeTypes.map((t) => (
            <button key={t} role="radio" aria-checked={type === t} className={"chip" + (type === t ? " is-on" : "")} onClick={() => setType(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="form-row">
        <label className="field-label">题面</label>
        <div className="composer" style={{ borderRadius: "var(--r-3)" }}>
          <textarea rows={2} placeholder="录入题面……" defaultValue="解释「卒相与欢，为刎颈之交」中「卒」的读音与含义。" />
        </div>
      </div>
      <div className="form-2col">
        <div className="form-row">
          <label className="field-label">参考答案</label>
          <input className="field-input" defaultValue="卒 cù，终于、最终。" />
        </div>
        <div className="form-row">
          <label className="field-label">你的错答</label>
          <input className="field-input field-wrong" defaultValue="士卒 zú。" />
        </div>
      </div>
      <div className="form-row">
        <label className="field-label">难度 <span className="meta">{diff} / 5</span></label>
        <input className="slider" type="range" min="1" max="5" step="1" value={diff} onChange={(e) => setDiff(+e.target.value)} aria-label="难度" />
        <div className="slider-ticks mono"><span>1 易</span><span>3 中</span><span>5 难</span></div>
      </div>
      <div className="form-2col">
        <div className="form-row">
          <label className="field-label">知识点 <span className="meta">（多选）</span></label>
          <div className="chip-set">
            {DATA.kpoints.map((k) => (
              <button key={k.tag} className={"chip" + (kp.includes(k.tag) ? " is-on" : "")} onClick={() => tog(setKp, k.tag)}>
                {kp.includes(k.tag) && <Icon name="check" size={12} />}{k.label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-row">
          <label className="field-label">错因 <span className="meta">（多选）</span></label>
          <div className="chip-set">
            {DATA.causes.map((c) => (
              <button key={c} className={"chip" + (cause.includes(c) ? " is-on" : "")} onClick={() => tog(setCause, c)}>
                {cause.includes(c) && <Icon name="check" size={12} />}{c}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="hero-cta"><Btn variant="primary" icon="check">录入错题</Btn><Btn variant="ghost" icon="close">清空</Btn></div>
    </Card>
  );
}

// vision_single / vision_paper — capture → extract → confirm → exit (A8)
function VisionMode({ paper, recordState = "ok", go }) {
  const d = DATA.ingestDraft;
  const [stage, setStage] = React.useState("capture"); // capture | extracting | confirm | error | rescuefail | progress | cancelled | exit
  const [extracted, setExtracted] = React.useState([]);
  const [cancelled, setCancelled] = React.useState(false);
  const pdfSteps = [
    { label: "上传原件 · PDF 2 页", state: "done", meta: "642 KB" },
    { label: "OCR 逐页识别", state: "done", meta: "2/2" },
    { label: "VLM 兜底校正 + 切分题块", state: "running", meta: "…" },
    { label: "挂知识点 · 生成出口", state: "pending" },
  ];
  const run = () => {
    setCancelled(false);
    if (recordState === "rescuefail") { setStage("rescuefail"); return; }
    if (recordState === "pdftimeout") { setStage("progress"); return; }
    setStage("extracting"); setExtracted([]);
    d.extracted.forEach((e, i) => setTimeout(() => {
      setExtracted((p) => [...p, e]);
      if (i === d.extracted.length - 1) setStage("confirm");
    }, 420 * (i + 1)));
  };
  return (
    <Card pad>
      {stage === "capture" && (
        <div className="vision-drop" onClick={run} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && run()}>
          <span className="vision-ic"><Icon name={paper ? "doc" : "camera"} size={28} /></span>
          <div className="vision-title serif">{paper ? "拖入整页文档或多题照片" : "拍摄 / 拖入单题照片"}</div>
          <div className="vision-sub">{paper ? "AI 将切分为多个 question block 后逐题抽取" : "AI 将抽取该题的 question block"}</div>
          <Btn variant="primary" icon="sparkle">{paper ? "上传并抽取" : "拍照并抽取"}</Btn>
        </div>
      )}
      {stage === "progress" && (
        <IngestProgress steps={pdfSteps} cancelled={cancelled}
          onCancel={() => setCancelled(true)}
          note="超时也能真取消 —— 点取消即停后台任务，不是假装。关页/刷新可重连重放。" />
      )}
      {stage === "rescuefail" && <RescueFail onRetry={() => setStage("capture")} go={go} />}
      {stage === "extracting" && (
        <div>
          <OriginalChip />
          <div className="vision-status nowrap-meta"><Icon name="refresh" size={14} className="spin" />抽取中… · vision_extract</div>
          <SkLines rows={3} />
          <div className="hero-cta" style={{ marginTop: "var(--s-3)" }}>
            <Btn variant="ghost" size="sm" icon="alert" onClick={() => setStage("error")}>模拟失败</Btn>
          </div>
        </div>
      )}
      {stage === "error" && (
        <div><OriginalChip /><ErrorState text="抽取失败 · vision_extract 超时。" onRetry={run} /></div>
      )}
      {stage === "confirm" && (
        <div>
          <OriginalChip />
          <div className="vision-status nowrap-meta"><Icon name="check" size={14} style={{ color: "var(--good)" }} />抽取完成 · 确认 {extracted.length} 个 block</div>
          <div className="extracted-list">
            {extracted.map((e, i) => (
              <div key={i} className="extract-row confirm-row" style={{ animationDelay: i * 60 + "ms" }}>
                <span className="extract-type">{e.type}</span>
                <div className="extract-body">
                  <div className="extract-term wenyan">{e.text}</div>
                  <input className="field-input field-inline" defaultValue={e.note} aria-label="可编辑释义" />
                </div>
                <span className="chip chip-k mono">{e.k}</span>
                <IconBtn icon="close" size={14} title="移除该 block" />
              </div>
            ))}
          </div>
          <div className="hero-cta" style={{ marginTop: "var(--s-4)" }}>
            <Btn variant="primary" icon="check" onClick={() => setStage("exit")}>确认并纳入</Btn>
            <Btn variant="ghost" icon="undo" onClick={() => setStage("capture")}>重新抽取</Btn>
          </div>
        </div>
      )}
      {stage === "exit" && <IngestExit go={go || (() => {})} degrade={["docx", "emptyblock", "figurecrop"].includes(recordState) ? recordState : null} />}
    </Card>
  );
}

// auto_enrolled review surface (observe-only is common; populated + revert designed)
function AutoEnrollPanel({ ui }) {
  const ds = ui.dataState || "ok";
  const [reverted, setReverted] = React.useState({});
  const [observe, setObserve] = React.useState(false); // toggle observe-only empty state
  const list = DATA.autoEnrolled;
  return (
    <div>
      <SectionLabel count={observe ? null : list.length}>
        <span className="inbox-lane-label"><span className="lane-ic tone-coral"><Icon name="bolt" size={14} /></span>AI 自动录入 · 复审</span>
      </SectionLabel>
      <div className="observe-note nowrap-meta">
        <span className="badge tone-info"><span className="dot" />observe-only</span>
        <span className="meta">WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED = OFF · 当前仅观察、块留 draft</span>
        <Btn size="sm" variant="ghost" style={{ marginLeft: "auto" }} onClick={() => setObserve((o) => !o)}>{observe ? "看示例列表" : "看 observe 空态"}</Btn>
      </div>
      <Card pad>
        <Stateful state={observe ? "empty" : ds} errorText="无法读取自动录入项。" onRetry={() => {}}
          skeleton={<SkLines rows={3} />}
          empty={<EmptyState icon="eye" title="AI 正在观察，尚未自动录入"
            text="开启 auto-enroll 后，AI 拟录入的错题 / 记录会列在这里，每项可一键撤销。" />}>
          <div className="strip-list">
            {list.map((a) => (
              <div key={a.id} className={"strip auto-row" + (reverted[a.id] ? " is-undone" : "")}>
                <span className={"badge tone-" + (a.route === "mistake" ? "again" : "good")}>{a.route}</span>
                <div className="strip-body">
                  <div className="strip-title">{a.title}</div>
                  <div className="strip-sub nowrap-meta mono">confidence {a.confidence.toFixed(2)} · → <span className="chip chip-k" style={{ padding: "1px 6px" }}>{a.knowledge}</span> · {a.state}</div>
                </div>
                <div className="strip-end">
                  {reverted[a.id]
                    ? <Badge tone="neutral"><Icon name="undo" size={12} />已撤销</Badge>
                    : <Btn size="sm" variant="ghost" icon="undo" onClick={() => setReverted((r) => ({ ...r, [a.id]: 1 }))}>撤销</Btn>}
                </div>
              </div>
            ))}
          </div>
        </Stateful>
      </Card>
    </div>
  );
}

function ScreenRecord({ go, ui = {} }) {
  const [mode, setMode] = React.useState("context");
  return (
    <div className="page view page-narrow">
      <div className="page-head">
        <div className="eyebrow">RECORD · 录入与抽取 · ADR-0007 ingestion</div>
        <div className="page-head-row">
          <h1 className="page-title serif">录入</h1>
          <div className="hero-cta"><Btn variant="ghost" icon="clock">草稿箱 3</Btn></div>
        </div>
        <p className="page-lead">把任何材料喂给 Loom：记一条学习记录、手动录错题，或拍照让 AI 抽取题目。</p>
      </div>

      <ModeTabs mode={mode} setMode={setMode} />

      <div className="mode-body fade-key" key={mode}>
        {mode === "context" && <ContextMode />}
        {mode === "manual" && <ManualMode />}
        {mode === "vision_single" && <VisionMode paper={false} recordState={ui.recordState || "ok"} go={go} />}
        {mode === "vision_paper" && <VisionMode paper={true} recordState={ui.recordState || "ok"} go={go} />}
      </div>

      <AutoEnrollPanel ui={ui} />
    </div>
  );
}
window.ScreenRecord = ScreenRecord;
