// Loom · Review (round-2a) — FSRS loop, two-phase. Contract §3C.
// answering(题面 + 作答框 + reveal + skip) → feedback(对照 split + 归因 + attempt
// 时间线 + AI 判定 + 评分建议 → again/hard/good). Keys: Ctrl/Cmd+Enter reveal ·
// s skip · 1/2/3 rate · a advice. Session: create-on-enter / hide-to-pause / url-resume.

function ScreenReview({ go }) {
  const c = DATA.reviewCard;
  const [phase, setPhase] = React.useState("answering"); // answering | feedback
  const [answer, setAnswer] = React.useState("");
  const [submitted, setSubmitted] = React.useState("");   // captured user answer
  const [idx, setIdx] = React.useState(c.index);
  const [done, setDone] = React.useState(false);
  const [grading, setGrading] = React.useState(null);
  const [paused, setPaused] = React.useState(false);
  const sid = React.useRef("rs_" + (40 + c.index));
  const taRef = React.useRef(null);

  const reveal = () => { if (phase !== "answering") return; setSubmitted(answer); setPhase("feedback"); };
  const skip = () => { advance(true); };
  const advance = (skipped) => {
    if (idx >= c.total) { setDone(true); return; }
    setIdx((n) => n + 1); setPhase("answering"); setAnswer(""); setSubmitted("");
  };
  const grade = (g) => {
    setGrading(g);
    setTimeout(() => { setGrading(null); if (idx >= c.total) setDone(true); else advance(false); }, 260);
  };
  const applyAdvice = () => { if (phase === "feedback") grade(c.judge.advice); };

  // session lifecycle — pause when tab hidden, resume on return
  React.useEffect(() => {
    const onVis = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // keyboard contract
  React.useEffect(() => {
    const onKey = (e) => {
      if (done || paused) return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key === "Enter") { e.preventDefault(); reveal(); return; }
      if (phase === "answering") {
        if (e.key === "s" && document.activeElement !== taRef.current) { e.preventDefault(); skip(); }
      } else {
        if (e.key === "1") grade("again");
        if (e.key === "2") grade("hard");
        if (e.key === "3") grade("good");
        if (e.key === "a") { e.preventDefault(); applyAdvice(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, done, paused, answer, idx]);

  if (done) return (
    <div className="page view">
      <div className="review-done card card-pad-lg" style={{ maxWidth: "var(--cap-prose)", margin: "0 auto" }}>
        <span className="card-icon accent" style={{ margin: "0 auto var(--s-4)", width: 56, height: 56 }}><Icon name="checkCircle" size={28} /></span>
        <h1 className="page-title serif">今日复习已织完</h1>
        <p className="page-lead" style={{ margin: "var(--s-3) auto var(--s-6)" }}>{c.total} 张卡片 · 留存率提升 +1.2% · 用时 18 分钟。明日还有 24 张到期。</p>
        <div className="hero-cta" style={{ justifyContent: "center" }}>
          <Btn variant="primary" icon="today" onClick={() => go("today")}>回到今日</Btn>
          <Btn variant="secondary" icon="mistakes" onClick={() => go("mistakes")}>看看错题</Btn>
        </div>
      </div>
    </div>
  );

  return (
    <div className="page view">
      {/* session banner */}
      <div className="review-session nowrap-meta">
        <span className="badge tone-neutral"><span className={"dot" + (paused ? "" : " pulse")} />{paused ? "已暂停" : "进行中"}</span>
        <span className="mono">session {sid.current}</span>
        <span className="dot-sep">·</span><span>URL 可恢复</span>
        <span className="topbar-spacer" />
        {paused
          ? <Btn size="sm" variant="primary" icon="review" onClick={() => setPaused(false)}>恢复</Btn>
          : <Btn size="sm" variant="ghost" icon="clock" onClick={() => setPaused(true)}>暂停</Btn>}
      </div>

      <div className="review-prog">
        <span className="meta tnum">{idx}/{c.total}</span>
        <div className="bar"><span style={{ width: (idx / c.total * 100) + "%" }} /></div>
        <span className="meta">逾期 {c.overdue}</span>
      </div>

      <div className="review-stage">
        <div className={"flash-card" + (grading ? " fade-key" : "")} style={grading ? { borderColor: `var(--${grading}-line)` } : null}>
          <div className="review-meta nowrap-meta">
            <Badge tone="neutral"><Icon name="items" size={12} />{c.deck}</Badge>
            <span className="chip chip-k mono">{c.tag}</span>
            <span className="meta">知识点 · {idx}/{c.total}</span>
          </div>

          <div className="flash-q wenyan">{c.q}</div>

          {phase === "answering" ? (
            <div className="answer-block">
              <label className="field-label">你的作答</label>
              <div className="composer answer-composer">
                <textarea ref={taRef} rows={3} value={answer} placeholder="先用你自己的话作答，再翻面对照参考与 AI 判定…"
                  onChange={(e) => setAnswer(e.target.value)} aria-label="作答" />
              </div>
              <div className="answer-actions">
                <Btn variant="primary" icon="eye" onClick={reveal}>显示答案</Btn>
                <Btn variant="ghost" icon="arrow" onClick={skip}>跳过</Btn>
                <span className="key-hints nowrap-meta mono">⌘/Ctrl+Enter 翻面 · s 跳过</span>
              </div>
            </div>
          ) : (
            <div className="flash-reveal">
              {/* answer vs reference split */}
              <div className="cmp-split">
                <div className="cmp-pane cmp-you">
                  <div className="cmp-head"><Icon name="pencil" size={13} />你的作答</div>
                  <div className="cmp-text wenyan">{submitted || <span className="quiet-empty" style={{ padding: 0 }}>（未作答）</span>}</div>
                </div>
                <div className="cmp-pane cmp-ref">
                  <div className="cmp-head"><Icon name="check" size={13} />参考答案</div>
                  <div className="cmp-text wenyan">{c.reference}</div>
                </div>
              </div>

              {/* AI judge + cause */}
              <div className="judge-panel">
                <div className="judge-head">
                  <span className="ai-tag"><Icon name="sparkle" size={12} />AI 判定</span>
                  <span className="badge tone-hard">{c.judge.verdict}</span>
                  <span className="meta" style={{ marginLeft: "auto" }}>judge · attribute</span>
                </div>
                <div className="judge-cause"><span className="cmp-label">错因</span>{c.judge.cause}</div>
                {/* attempt timeline */}
                <div className="attempt-tl">
                  {c.attempts.map((a) => (
                    <div key={a.n} className="attempt-row">
                      <span className={"attempt-dot tone-" + (a.outcome === "failure" ? "again" : "hard")} />
                      <span className="mono attempt-when">{a.when}</span>
                      <span className={"badge tone-" + (a.outcome === "failure" ? "again" : "hard")}>{a.outcome === "failure" ? "failure" : "partial"}</span>
                      <span className="attempt-note">{a.note}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* FSRS pills (real backend stats) */}
              <div className="fsrs-row">
                <span className="fsrs-pill">稳定度 <b>{c.fsrs.stability}</b></span>
                <span className="fsrs-pill">难度 <b>{c.fsrs.difficulty}</b></span>
                <span className="fsrs-pill">可提取性 <b>{c.fsrs.retr}</b></span>
              </div>

              {/* rating advisor */}
              <div className="advisor nowrap-meta">
                <Icon name="sparkle" size={14} className="advisor-ic" />
                <span>评分建议：<b>{c.grades.find((g) => g.g === c.judge.advice).label}</b></span>
                <span className="meta">基于错因与 attempt 历史</span>
                <Btn size="sm" variant="secondary" onClick={applyAdvice} style={{ marginLeft: "auto" }}>采纳建议 · a</Btn>
              </div>

              {/* three-tier grading */}
              <div className="grade-row">
                {c.grades.map((g) => (
                  <button key={g.g} className={"grade-btn " + g.cls + (c.judge.advice === g.g ? " is-advised" : "")} onClick={() => grade(g.g)}>
                    <span className="g-num mono">{g.num}</span>
                    <span className="g-label">{g.label}</span>
                    <span className="g-when mono">{g.when}</span>
                  </button>
                ))}
              </div>
              <div className="key-hints nowrap-meta mono" style={{ textAlign: "center", marginTop: "var(--s-3)" }}>1 不会 · 2 模糊 · 3 会了 · a 采纳建议</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
window.ScreenReview = ScreenReview;
