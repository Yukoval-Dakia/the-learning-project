// Loom · cold-start first-session flow (onboarding). Handoff 2026-06-21.
// Screens: ColdToday(intercept) · ScreenWelcome ① · OnboardRecord ②a ·
//          ScreenStarter ②b · ScreenPlacement ③ · ScreenProfile ④.
// Builds on existing primitives (Card/Btn/Icon/QMarkdown) + .ob-* css.
// Walkable: each screen's primary CTA advances the flow via `go`.

const OBJECTIVE_KINDS = ["true_false", "single_choice", "multiple_choice"];

// shared step rail
function ObSteps({ active }) {
  const steps = [
    { id: "welcome", n: "1", label: "设定" },
    { id: "source",  n: "2", label: "备料" },
    { id: "placement", n: "3", label: "定位" },
    { id: "profile", n: "4", label: "档案" },
  ];
  const order = ["welcome", "source", "placement", "profile"];
  const ai = order.indexOf(active);
  return (
    <div className="ob-steps" aria-label="首会流进度">
      {steps.map((s, i) => {
        const si = order.indexOf(s.id);
        const cls = si === ai ? "is-on" : si < ai ? "is-done" : "";
        return (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="ob-step-sep" />}
            <span className={"ob-step " + cls}>
              <span className="ob-step-n">{si < ai ? "✓" : s.n}</span>{s.label}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ═══ cold /today intercept ═══════════════════════════════════ */
function ColdToday({ go }) {
  return (
    <div className="page view ob-cold">
      <div className="ob-cold-hero ob-rise">
        <div className="ob-cold-mark"><BrandMark size={44} /></div>
        <h1 className="ob-cold-title serif">从一张白纸开始</h1>
        <p className="ob-cold-sub">你的今日还空着——没有要复习的，也没有题库。
          带上你的材料，我先为你备一套个人化的练习。</p>
        <div className="ob-cold-cta">
          <Btn variant="primary" size="lg" iconEnd="arrow" onClick={() => go("welcome")}>开始设定 · 约 2 分钟</Btn>
        </div>
        <div className="ob-cold-empty">
          <Icon name="moon" size={14} />昨晚没有 Dreaming agent 跑过 · 冷库 goal·learning_item·mastery_state 三表皆空
        </div>
      </div>
      <div className="ob-cold-lanes" aria-hidden="true">
        {[
          { ic: "review", t: "复习队列", s: "FSRS 还没有到期项" },
          { ic: "layers", t: "学习意图", s: "尚未录入学习项" },
          { ic: "target", t: "AI Coach", s: "等你先答几题" },
        ].map((l) => (
          <div key={l.t} className="ob-cold-lane">
            <Icon name={l.ic} size={20} />
            <div className="ob-cold-lane-t">{l.t}</div>
            <div className="ob-cold-lane-s">{l.s}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══ ① welcome / setup ═══════════════════════════════════════ */
function ScreenWelcome({ go, ui = {} }) {
  const [stage, setStage] = React.useState(null);
  const [leanings, setLeanings] = React.useState([]);
  const [pace, setPace] = React.useState("medium");
  const [goal, setGoal] = React.useState("");
  const [subject, setSubject] = React.useState(null);
  const [err, setErr] = React.useState(false);
  const failMode = ui.obWelcome === "submitfail";

  const togLean = (id) => setLeanings((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  const goalReady = goal.trim().length >= 2;
  // scope preview (mirrors POST /api/goals → scopeKnowledgeIds)
  const scopeN = goalReady ? (subject === "wenyan" || /文言|虚词|句式|翻译/.test(goal) ? 8 : 5) : 0;

  const proceed = (route) => {
    if (!goalReady) { setErr(true); return; }
    if (failMode && route === "starter") { setErr("scope"); return; }
    setErr(false);
    // POST /api/goals fires here in real impl; goalSample stands in.
    go(route);
  };

  return (
    <div className="page view ob-welcome">
      <ObSteps active="welcome" />
      <div className="ob-hero ob-rise">
        <div className="ob-hero-mark"><BrandMark size={36} /></div>
        <div>
          <h1 className="ob-hero-title serif">先认识一下你</h1>
          <p className="ob-hero-sub">带上你的材料，我为你备一套个人化的练习。
            只问两件事——你大概在什么阶段，和你想学什么。</p>
        </div>
      </div>

      <Card pad padLg className="ob-rise">
        {/* 自述 · §6 Q1 轻 */}
        <div className="ob-field">
          <div className="ob-field-head">
            <span className="ob-field-q"><span className="ob-q-no">01</span>你大概在哪个阶段？</span>
            <span className="ob-field-opt">· 轻引导，可跳过</span>
          </div>
          <div className="ob-pick">
            {OB.stages.map((s) => (
              <button key={s} className={"ob-pick-btn" + (stage === s ? " is-on" : "")} onClick={() => setStage(s)}>
                <div className="ob-pick-l">{s}</div>
              </button>
            ))}
          </div>
          <div className="ob-field-hint">学科倾向（可多选 · 仅用于排序起始题，不限制目标）：</div>
          <div className="ob-subjects" style={{ marginTop: 8 }}>
            {OB.leanings.map((l) => (
              <button key={l.id} className={"chip" + (leanings.includes(l.id) ? " is-on" : "")} onClick={() => togLean(l.id)}>
                {leanings.includes(l.id) && <Icon name="check" size={12} />}{l.label}
              </button>
            ))}
          </div>
          <div className="ob-field-hint">每天大概投入：</div>
          <div className="ob-pick" style={{ marginTop: 8, gridTemplateColumns: "repeat(3, 1fr)" }}>
            {OB.paces.map((p) => (
              <button key={p.id} className={"ob-pick-btn" + (pace === p.id ? " is-on" : "")} onClick={() => setPace(p.id)}>
                <div className="ob-pick-l">{p.label}</div>
                <div className="ob-pick-s">{p.sub}</div>
              </button>
            ))}
          </div>
        </div>

        {/* 目标 · 核心 */}
        <div className="ob-field" style={{ marginBottom: 0 }}>
          <div className="ob-field-head">
            <span className="ob-field-q"><span className="ob-q-no">02</span>你想学什么？</span>
          </div>
          <div className="ob-goal-box">
            <div className="composer">
              <textarea rows={2} value={goal} placeholder="用一句话说说目标——比如「把高中文言文虚词和句式啃下来」"
                onChange={(e) => { setGoal(e.target.value); setErr(false); }} aria-label="学习目标" />
            </div>
          </div>
          <div className="ob-subjects">
            <span className="ob-subjects-lbl">学科视角（可选）：</span>
            {OB.subjects.map((s) => (
              <button key={s.id} className={"chip" + (subject === s.id ? " is-on" : "")}
                onClick={() => setSubject(subject === s.id ? null : s.id)}>
                {subject === s.id && <Icon name="check" size={12} />}{s.name}
              </button>
            ))}
          </div>
          {scopeN > 0 && (
            <div className="ob-scope-note"><Icon name="knowledge" size={13} />
              已圈定 <span className="mono">{scopeN}</span> 个知识点作为定位范围 · scopeKnowledgeIds</div>
          )}
          {err === true && <div className="ob-inline-err"><Icon name="alert" size={14} />先写一句你想学什么，我才好圈定范围。</div>}
          {err === "scope" && <div className="ob-inline-err"><Icon name="alert" size={14} />这个目标暂时解析不出可用范围（400）。换个说法，或直接上传材料。</div>}
        </div>
      </Card>

      {/* 分叉 */}
      <div style={{ marginTop: "var(--s-5)" }} className="ob-rise">
        <div className="ob-field-head"><span className="ob-field-q">怎么开始？</span></div>
        <div className="ob-fork">
          <button className="ob-fork-card is-primary" disabled={!goalReady} onClick={() => proceed("onboard-upload")}>
            <div className="ob-fork-ic"><Icon name="record" size={20} /></div>
            <div className="ob-fork-t">上传我的材料</div>
            <div className="ob-fork-d">错题本 / 卷子 / 课本题——拍照或拖入，AI 抽题入池。这是最贴合你的一条路。</div>
            <span className="ob-fork-go">去上传 <Icon name="arrow" size={14} /></span>
          </button>
          <button className="ob-fork-card" disabled={!goalReady} onClick={() => proceed("starter")}>
            <div className="ob-fork-ic"><Icon name="layers" size={20} /></div>
            <div className="ob-fork-t">从起始集开始</div>
            <div className="ob-fork-d">手头没有材料？用该学科的起始题直接进定位练习，之后随时再补自己的材料。</div>
            <span className="ob-fork-go">用起始集 <Icon name="arrow" size={14} /></span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══ ②a record cold-wrap ════════════════════════════════════ */
function OnboardRecord({ go, ui = {} }) {
  const [done, setDone] = React.useState(false);
  // listen for the existing record screen's exit; also offer a demo "complete".
  return (
    <div className="page view page-narrow">
      <div className="page-head">
        <div className="eyebrow">RECORD · onboarding · session=s_ingest_first · 为你建题库</div>
        <ObSteps active="source" />
        <div className="page-head-row">
          <h1 className="page-title serif">上传你的材料</h1>
          <Btn variant="ghost" icon="arrowL" onClick={() => go("welcome")}>返回设定</Btn>
        </div>
      </div>

      <div className="ob-wrap-banner ob-rise">
        <div className="ob-wrap-ic"><Icon name="sparkle" size={16} /></div>
        <div>
          <div className="ob-wrap-t">这一步是在<b>为你建题库</b>。</div>
          <div className="ob-wrap-s">抽出的每道题会自动归类学科、挂到知识点、补上参考答案，
            然后直接拿去做定位练习——你只要上传，剩下交给抽题管道（OCR 默认 · VLM 兜底）。</div>
        </div>
      </div>

      <ObIngest ui={ui} onReady={() => setDone(true)} />

      <div className="ob-exitbar ob-rise">
        <div className="ob-exitbar-fig mono">{done ? OB.ingestBlocks.length : "—"}</div>
        <div className="ob-exitbar-txt">
          {done
            ? <><b>{OB.ingestBlocks.length} 题已就绪并 active</b> · 可以拿它们做定位了。</>
            : <>抽题完成后，这里会亮起「去做定位练习」。</>}
        </div>
        <div className="hero-cta">
          {!done && <Btn variant="ghost" onClick={() => go("starter")}>跳过 · 用起始集</Btn>}
          <Btn variant="primary" iconEnd="arrow" disabled={!done} onClick={() => go("placement")}>去做定位练习</Btn>
        </div>
      </div>
    </div>
  );
}

// SSE-style ingestion progress (GET /api/ingestion/[id]/events)
function ObIngest({ ui = {}, onReady }) {
  const slow = ui.recordState === "pdftimeout";
  const fail = ui.recordState === "rescuefail" || ui.recordState === "emptyblock";
  const [i, setI] = React.useState(0);
  const [stage, setStage] = React.useState("run"); // run | done | fail
  const steps = OB.ingestSteps;

  React.useEffect(() => {
    setI(0); setStage("run");
    if (fail) { const t = setTimeout(() => setStage("fail"), 1400); return () => clearTimeout(t); }
    const gap = slow ? 1500 : 700;
    let n = 0;
    const id = setInterval(() => {
      n += 1; setI(n);
      if (n >= steps.length) { clearInterval(id); setStage("done"); onReady && onReady(); }
    }, gap);
    return () => clearInterval(id);
  }, [ui.recordState]);

  if (stage === "fail") {
    return (
      <Card pad className="ob-rise">
        <ErrorState compact text={ui.recordState === "emptyblock"
          ? "这份材料抽不出可用题块（可能是纯图 / 排版太碎）。换一份，或先用起始集。"
          : "抽题管道中断 · ingestion extract 失败。可重试，或转用起始集。"} onRetry={() => { setStage("run"); setI(0); }} />
      </Card>
    );
  }
  return (
    <Card pad className="ob-rise">
      <OBOriginalChip />
      <div className="ob-ingest">
        {steps.map((s, idx) => {
          const st = idx < i ? "done" : idx === i ? "run" : "wait";
          return (
            <div key={idx} className={"ob-ing-row" + (st === "done" ? " is-done" : "")}>
              <span className={"ob-ing-dot is-" + st}>
                {st === "done" ? <Icon name="check" size={13} /> : st === "run" ? <Icon name="refresh" size={13} className="spin" /> : <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />}
              </span>
              <span className="ob-ing-l">{s.label}</span>
              {(st === "done" || (st === "run" && idx < steps.length)) && <span className="ob-ing-meta">{st === "done" ? s.meta : (slow ? "处理中…" : "…")}</span>}
            </div>
          );
        })}
      </div>
      <div className="ob-ing-sse">
        <span className="dot" />
        {stage === "done"
          ? `event=ingestion.done · 抽到 ${OB.ingestBlocks.length} 题、已就绪`
          : slow ? "SSE · 整页抽取可能慢，正逐题推进度…可关页，重连会续传"
          : "SSE · GET /api/ingestion/[id]/events · 抽题进度逐条推送"}
      </div>
      {stage === "done" && (
        <div className="extracted-list" style={{ marginTop: "var(--s-4)" }}>
          {OB.ingestBlocks.slice(0, 4).map((b, idx) => (
            <div key={idx} className="extract-row confirm-row" style={{ animationDelay: idx * 50 + "ms" }}>
              <span className="extract-type">{b.kind}</span>
              <div className="extract-body"><div className="extract-term">{b.text}</div></div>
              <span className="chip chip-k mono">{b.k}</span>
            </div>
          ))}
          <div className="meta" style={{ marginTop: 8 }}>…等 {OB.ingestBlocks.length} 题，全部已 active</div>
        </div>
      )}
    </Card>
  );
}

function OBOriginalChip() {
  return (
    <div className="nowrap-meta" style={{ marginBottom: "var(--s-3)" }}>
      <span className="chip chip-k"><Icon name="doc" size={12} />错题本.pdf · 3 页</span>
      <span className="meta mono">source · POST /api/ingestion/pdf</span>
    </div>
  );
}

/* ═══ ②b starter set ═════════════════════════════════════════ */
function ScreenStarter({ go, ui = {} }) {
  const sourcing = ui.obPlacement === "sourcing";
  return (
    <div className="page view ob-pl">
      <div className="page-head">
        <div className="eyebrow">STARTER · 起始集 · POST /api/placement/start</div>
        <ObSteps active="source" />
        <div className="page-head-row">
          <h1 className="page-title serif">从起始集开始</h1>
          <Btn variant="ghost" icon="arrowL" onClick={() => go("welcome")}>返回设定</Btn>
        </div>
      </div>

      <Card pad padLg className="ob-rise">
        <div className="nowrap-meta" style={{ marginBottom: "var(--s-3)" }}>
          <span className="chip chip-k"><Icon name="target" size={12} />{OB.goalSample.title}</span>
          <span className="badge tone-info"><span className="dot" />文言文</span>
        </div>
        <p className="ob-lead" style={{ marginBottom: "var(--s-4)" }}>
          没有材料也没关系。我会用<b>文言文起始集</b>里的题带你走一遍定位——
          <span className="mono" style={{ fontSize: 13 }}>{OB.goalSample.scopeKnowledgeIds.length}</span> 个知识点，最多 8 题，几分钟就完。
        </p>
        {sourcing ? (
          <EmptyState icon="clock" title="正在为你准备起始题"
            text="这个学科子图还很薄（只有科目根、题还没生成）。后端正在按需生成起始题——稍后再来，或先上传一份自己的材料。" />
        ) : (
          <div className="hero-cta">
            <Btn variant="primary" iconEnd="arrow" onClick={() => go("placement")}>开始定位练习</Btn>
            <Btn variant="ghost" icon="record" onClick={() => go("onboard-upload")}>其实我有材料，去上传</Btn>
          </div>
        )}
        {sourcing && (
          <div className="hero-cta" style={{ marginTop: "var(--s-4)" }}>
            <Btn variant="ghost" icon="record" onClick={() => go("onboard-upload")}>改为上传材料</Btn>
            <Btn variant="ghost" icon="today" onClick={() => go("today")}>稍后再来</Btn>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ═══ ③ placement loop ═══════════════════════════════════════ */
function ScreenPlacement({ go, ui = {} }) {
  const qs = OB.placementQs;
  const cap = OB.placementCap;
  const mode = ui.obPlacement || "answer"; // answer | loading | sourcing | judgefail
  const [idx, setIdx] = React.useState(0);
  const [answers, setAnswers] = React.useState({});
  const [phase, setPhase] = React.useState(mode === "loading" ? "loading" : mode === "sourcing" ? "sourcing" : "answer");
  const q = qs[idx];

  React.useEffect(() => {
    if (mode === "loading") { const t = setTimeout(() => setPhase("answer"), 1100); return () => clearTimeout(t); }
    if (mode === "sourcing") setPhase("sourcing");
  }, [mode]);

  const setAns = (v) => setAnswers((a) => ({ ...a, [q.questionId]: v }));
  const cur = answers[q?.questionId];
  const answered = q && (OBJECTIVE_KINDS.includes(q.kind)
    ? (Array.isArray(cur) ? cur.length > 0 : cur != null)
    : (typeof cur === "string" && cur.trim().length > 0) || cur === "__img");

  const next = () => {
    // POST /api/review/submit (session_id=probe) then POST /api/placement/[id]/next
    if (idx + 1 >= qs.length) { setPhase("settling"); }
    else setIdx(idx + 1);
  };

  // settling → compute θ̂/FSRS → profile
  React.useEffect(() => {
    if (phase !== "settling") return;
    if (mode === "judgefail") { const t = setTimeout(() => setPhase("judgefail"), 1200); return () => clearTimeout(t); }
    const t = setTimeout(() => go("profile"), 1900);
    return () => clearTimeout(t);
  }, [phase]);

  if (phase === "loading") {
    return <PlacementShell idx={0} go={go}>
      <Card pad padLg><div className="ob-pl-meta"><span className="ob-pl-kind">loading first question</span></div><SkLines rows={3} /></Card>
    </PlacementShell>;
  }
  if (phase === "sourcing") {
    return <PlacementShell idx={0} go={go}>
      <Card pad padLg>
        <EmptyState icon="clock" title="备题中 · 子图还冷"
          text="question === null · sourcingNeeded=true。这个知识子图还没有生成题，后端正在按需供题。稍后再来，或先上传材料。" />
        <div className="hero-cta" style={{ justifyContent: "center", marginTop: "var(--s-3)" }}>
          <Btn variant="ghost" icon="record" onClick={() => go("onboard-upload")}>改为上传材料</Btn>
        </div>
      </Card>
    </PlacementShell>;
  }
  if (phase === "settling") {
    return <PlacementShell idx={cap} go={go} done>
      <Card pad padLg>
        <div className="ob-settle">
          <div className="ob-settle-ring" />
          <div className="ob-settle-t serif">正在收紧你的画像…</div>
          <div className="ob-settle-s mono">judge · θ̂ · FSRS · 写入 mastery_state</div>
        </div>
      </Card>
    </PlacementShell>;
  }
  if (phase === "judgefail") {
    return <PlacementShell idx={cap} go={go} done>
      <Card pad padLg>
        <ErrorState text="评分管道暂时不可用 · judge 降级。你的答题已存，画像稍后会补算。" onRetry={() => { setPhase("settling"); }} />
        <div className="hero-cta" style={{ justifyContent: "center", marginTop: "var(--s-3)" }}>
          <Btn variant="primary" iconEnd="arrow" onClick={() => go("profile")}>先看初步档案</Btn>
        </div>
      </Card>
    </PlacementShell>;
  }

  const answeredCount = Object.keys(answers).length;
  return (
    <PlacementShell idx={idx} go={go} answeredCount={answeredCount}>
      <Card pad padLg className="fade-key" key={q.questionId}>
        <div className="ob-pl-meta">
          <span className="chip chip-k">{q.kp}</span>
          <span className="ob-pl-kind">{q.kind}</span>
          <span className="meta mono">{q.questionId}</span>
        </div>

        {q.passage && (
          <div className="ob-pl-passage">{q.passage}
            {q.passageSrc && <span className="ob-pl-passage-src">{q.passageSrc}</span>}
          </div>
        )}
        <QMarkdown text={q.prompt_md} className="ob-pl-stem" />

        <PlacementAnswer q={q} value={cur} onChange={setAns} />

        <div className="ob-pl-foot">
          <Btn variant="primary" iconEnd={idx + 1 >= qs.length ? "check" : "arrow"} disabled={!answered} onClick={next}>
            {idx + 1 >= qs.length ? "完成定位 · 看起始档案" : "下一题"}
          </Btn>
          {idx > 0 && <Btn variant="ghost" icon="arrowL" onClick={() => setIdx(idx - 1)}>上一题</Btn>}
          {answered && <span className="ob-pl-saved"><Icon name="check" size={12} style={{ color: "var(--good)" }} />已记录</span>}
          <span className="ob-pl-hint">{OBJECTIVE_KINDS.includes(q.kind) ? "选择即记录 · 攒到末尾统一判分" : "作答攒到末尾统一判分"}</span>
        </div>
      </Card>
      <div className="ob-pl-reassure">
        <Icon name="clock" size={14} />这是有界的——最多 {cap} 题、几分钟就结束。答完才统一给反馈，先别急着看对错。
      </div>
    </PlacementShell>
  );
}

function PlacementShell({ idx, go, done, answeredCount = 0, children }) {
  const cap = OB.placementCap;
  const shown = Math.min(idx + 1, cap);
  return (
    <div className="page view ob-pl">
      <div className="page-head">
        <div className="eyebrow">PLACEMENT · session=s_probe_01 · cap={cap} · θ̂·FSRS live</div>
        <ObSteps active="placement" />
        <div className="page-head-row">
          <h1 className="page-title serif">定位练习</h1>
          <Btn variant="ghost" icon="close" onClick={() => go("welcome")}>退出</Btn>
        </div>
      </div>
      <div className="ob-pl-bar">
        <div className="ob-pl-prog">
          <div className="ob-pl-prog-h">
            <span className="ob-pl-prog-k">第 <b>{done ? cap : shown}</b> / 最多 {cap} 题</span>
            <span className="ob-pl-prog-cap">{done ? "已答完" : "答到 cap 或收敛即止"}</span>
          </div>
          <div className="ob-pl-track">
            {Array.from({ length: cap }).map((_, i) => (
              <span key={i} className={"ob-pl-seg" + (done || i < idx ? " is-done" : i === idx ? " is-cur" : "")} />
            ))}
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

function PlacementAnswer({ q, value, onChange }) {
  if (q.kind === "multiple_choice") {
    const sel = Array.isArray(value) ? value : [];
    const tog = (k) => onChange(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
    return (
      <div className="ob-opts" role="group" aria-label="多选">
        {q.options.map((o) => (
          <button key={o.k} className={"ob-opt ob-opt-multi" + (sel.includes(o.k) ? " is-sel" : "")} onClick={() => tog(o.k)} aria-pressed={sel.includes(o.k)}>
            <span className="ob-opt-k">{sel.includes(o.k) ? <Icon name="check" size={13} /> : o.k}</span>
            <QMarkdown text={o.text} className="ob-opt-t" />
          </button>
        ))}
      </div>
    );
  }
  if (OBJECTIVE_KINDS.includes(q.kind)) {
    return (
      <div className="ob-opts" role="radiogroup" aria-label="单选">
        {q.options.map((o) => (
          <button key={o.k} className={"ob-opt" + (value === o.k ? " is-sel" : "")} role="radio" aria-checked={value === o.k} onClick={() => onChange(o.k)}>
            <span className="ob-opt-k">{o.k}</span>
            <QMarkdown text={o.text} className="ob-opt-t" />
          </button>
        ))}
      </div>
    );
  }
  // open answer
  const isImg = value === "__img";
  return (
    <div className="ob-pl-answer">
      <div className="composer answer-composer">
        <textarea rows={q.kind === "essay" || q.kind === "reading" ? 4 : 3} value={isImg ? "" : (value || "")} disabled={isImg}
          placeholder={q.kind === "translation" ? "写下你的译文——也可以拍手写稿上传。" : "写下你的作答——也可以拍照上传。"}
          onChange={(e) => onChange(e.target.value)} aria-label="作答" />
      </div>
      <div className="hero-cta" style={{ marginTop: "var(--s-3)" }}>
        {isImg
          ? <span className="ob-pl-attach"><img src="uploads/draw-7cafddab-274d-4a3a-b03e-a722036e1a59.png" alt="手写稿" /><Icon name="check" size={13} />手写稿已附</span>
          : <Btn variant="ghost" size="sm" icon="camera" onClick={() => onChange("__img")}>拍照上传手写</Btn>}
      </div>
    </div>
  );
}

/* ═══ ④ profile reveal ═══════════════════════════════════════ */
function ScreenProfile({ go, ui = {} }) {
  const sparse = ui.obProfile === "sparse";
  const baseKcs = OB.profileKCs;
  const kcs = sparse
    ? baseKcs.map((k, i) => i < 3 ? k : { ...k, ledger: { s: 0, f: 0, b: k.ledger.b } })
    : baseKcs;

  // ── #41 verify layer · A 未验证 → B 重算中 → C ✓ | D ✗ ──
  const verifyMode = ui.obVerify || "tap";   // tap | auto | drift
  const drift = verifyMode === "drift";
  const auto = verifyMode === "auto" || drift;
  const vr = useRecompute({ auto, mode: drift ? "drift" : "match" });
  const DRIFT_ID = "k_gujin";                 // 罕见:这一项显示口径与重导不符
  const [detailOpen, setDetailOpen] = React.useState(false);
  React.useEffect(() => { setDetailOpen(vr.state === "drift"); }, [vr.state]);

  // 每个 KC:从账本重导(device) → 比对服务端显示值(server)。显示用 server。
  const rows = kcs.map((k) => {
    const rc = recomputeKC(k.ledger);
    let server = rc;
    if (drift && k.id === DRIFT_ID && !rc.untested) {
      server = { ...rc, theta_hat: 0.66, p_l: 0.66, mastery_hi: 0.96 }; // 服务端漂移
    }
    const cmp = rc.untested ? { na: true } : cmpKC(server, rc);
    return { k, rc, server, cmp };
  });
  const tested = rows.filter((r) => !r.rc.untested);
  const answered = tested.reduce((a, r) => a + r.rc.evidence_count, 0);
  const verifiedNum = tested.length;
  const driftRow = rows.find((r) => r.cmp && r.cmp.match === false);
  const ran = vr.state === "match" || vr.state === "drift";

  const pct = (v) => Math.round(v * 100);
  return (
    <div className="page view ob-prof">
      <div className="page-head">
        <div className="eyebrow">PROFILE · per-KC mastery_state · SE = 1/√precision</div>
        <ObSteps active="profile" />
        <div className="page-head-row">
          <h1 className="page-title serif">我们现在怎么看你</h1>
        </div>
      </div>

      <QMarkdown text={sparse ? "你只答了 **3 道题**，所以现在还只能摸到几个点的轮廓——其余多数知识点还『未测』。这很正常：多练几轮，区间会收紧。" : OB.profileNarrative} className="ob-prof-narr ob-rise" />
      <div className="ob-prof-honest ob-rise">
        <Icon name="alert" size={13} />基于 {answered} 道答题的<b style={{ margin: "0 3px" }}>初步信念</b> · 多数还需更多练习确认，下面把不确定一并摆出来
      </div>

      <Card pad padLg className="ob-rise" data-rc={vr.state}>
        {/* ── #41 重算 / 核对 —— 4 状态都落在这条 ── */}
        <div className={"rc-verify rc-state-" + vr.state}>
          <span className="rc-verify-icon">
            {vr.state === "match" ? <Icon name="checkCircle" size={20} />
              : vr.state === "drift" ? <Icon name="alert" size={20} />
              : vr.state === "running" ? <Icon name="refresh" size={20} />
              : <Icon name="bolt" size={20} />}
          </span>
          <div className="rc-verify-text">
            {vr.state === "idle" && <>
              <div className="rc-verify-title">可复现的诊断画像</div>
              <div className="rc-verify-sub">在本设备从你的证据重导上面每个数字，核对它与服务端是否逐位相等。</div>
            </>}
            {vr.state === "running" && <>
              <div className="rc-verify-title">正在本设备重导…</div>
              <div className="rc-verify-sub">从 succ / fail / 难度锚重算 {verifiedNum} 个知识点。</div>
            </>}
            {vr.state === "match" && <>
              <div className="rc-verify-title">已在本设备重导 <span className="rc-tick">✓</span></div>
              <div className="rc-verify-sub">
                {verifiedNum} 个知识点 · 与服务端<b>逐位相等</b> · <RcOffline /> · 刚刚
              </div>
            </>}
            {vr.state === "drift" && <>
              <div className="rc-verify-title">此处记录有 <b className="mono">1</b> 处不同步</div>
              <div className="rc-verify-sub">
                {verifiedNum - 1}/{verifiedNum} 逐位相等，<b>1</b> 项的显示口径与本地重导没对上 · <RcOffline />
              </div>
            </>}
          </div>
          <div className="rc-verify-act">
            {(vr.state === "idle" || vr.state === "running") && (
              <Btn variant="primary" size="sm" icon="refresh"
                onClick={vr.run} disabled={vr.state === "running"}>
                {vr.state === "running" ? "重算中…" : "重算并核对"}
              </Btn>
            )}
            {ran && (
              <>
                <button className="rc-detail-toggle" onClick={() => setDetailOpen((o) => !o)}>
                  {vr.state === "drift" ? (detailOpen ? "收起差异" : "查看差异") : (detailOpen ? "收起逐位详情" : "逐位详情")}
                </button>
                <button className="rc-rerun" onClick={vr.run} title="再算一次"><Icon name="refresh" size={14} /></button>
              </>
            )}
          </div>
        </div>

        <div className="ob-kc-list">
          {rows.map(({ k, server, cmp }) => {
            const untested = server.untested || server.evidence_count === 0;
            const conf = untested ? "none" : server.low_confidence ? "low" : "ok";
            const isDrift = cmp && cmp.match === false;
            return (
              <div key={k.id} className={"ob-kc" + (server.low_confidence ? " is-lowconf" : "") + (untested ? " is-untested" : "") + (isDrift ? " rc-kc-drift" : "")}>
                <div className="ob-kc-id">
                  <span className="ob-kc-name">{k.name}</span>
                  <span className="ob-kc-track">{k.track}</span>
                </div>
                <div className="ob-band">
                  {untested ? (
                    <div className="ob-band-untested">未测 · 暂无证据</div>
                  ) : (
                    <>
                      <div className="ob-band-track">
                        <span className="ob-band-fill" style={{ left: pct(server.mastery_lo) + "%", width: pct(server.mastery_hi - server.mastery_lo) + "%" }} />
                        <span className="ob-band-lo" style={{ left: pct(server.mastery_lo) + "%" }} />
                        <span className="ob-band-hi" style={{ left: pct(server.mastery_hi) + "%" }} />
                        <span className="ob-band-mark" style={{ left: pct(server.theta_hat) + "%" }} />
                      </div>
                      <div className="ob-band-axis"><span>较弱</span><span>可能区间 {pct(server.mastery_lo)}–{pct(server.mastery_hi)}</span><span>较稳</span></div>
                    </>
                  )}
                </div>
                <div className="ob-kc-conf">
                  <span className={"ob-conf-pill t-" + (conf === "none" ? "none" : conf === "low" ? "low" : "ok")}>
                    {conf === "none" ? "未测" : conf === "low" ? "低置信" : "较可信"}
                  </span>
                  <span className="ob-kc-ev">{untested ? "0 题" : `${server.evidence_count} 题 · SE ${rcFmt(server.se)}`}</span>
                  <RcKcChip state={vr.state} cmp={cmp} />
                </div>
              </div>
            );
          })}
        </div>

        {ran && detailOpen && (
          <div className="rc-detail">
            {vr.state === "drift"
              ? <RcDriftDetail row={driftRow} otherCount={verifiedNum - 1} />
              : <RcLedgerTable rows={rows} />}
          </div>
        )}
        {ran && <RcBoundaryNote />}

        <div className="ob-prof-legend">
          <span><i style={{ background: "color-mix(in oklab, var(--coral) 26%, transparent)" }} />珊瑚带 = 可能掌握区间（不是分数）</span>
          <span><i style={{ background: "var(--coral)", width: 8, height: 14, borderRadius: 6 }} />标记 = 当前最可能值 θ̂</span>
          <span><i style={{ background: "color-mix(in oklab, var(--ink-4) 20%, transparent)" }} />灰带 = 低置信，区间很宽</span>
        </div>
      </Card>

      <div className="ob-prof-foot">
        <Btn variant="primary" size="lg" iconEnd="arrow" onClick={() => { window.dispatchEvent(new Event("ob-flow-exit")); go("today"); }}>开始日常练习</Btn>
        <span className="meta">进入今日后，复习队列、学习项、Coach 都会随你练习一起长出来——画像也会越来越准。</span>
      </div>
    </div>
  );
}

Object.assign(window, { ColdToday, ScreenWelcome, OnboardRecord, ScreenStarter, ScreenPlacement, ScreenProfile });
