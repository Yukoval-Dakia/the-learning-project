// Loom · Practice (练习) — 成卷练习 一级页面.
// 今日（待做/进行中 置顶）+ 往日（历史倒序 · 按来源筛）. 条目动作：开始 / 继续 / 查看回顾.
// 区别于 复习（FSRS 逐张到期流）：以整张「卷」为单位作答与回顾.

function PaperStatusPill({ p }) {
  const s = p.session.status;
  if (p.gen === "generating") return <span className="badge tone-info"><span className="dot pulse" />生成中</span>;
  if (s === "in_progress")   return <span className="badge tone-coral"><span className="dot pulse" />进行中</span>;
  if (s === "done")          return <span className="badge tone-good"><Icon name="check" size={12} />已完成</span>;
  return <span className="badge tone-neutral">未开始</span>;
}

function PaperCard({ p, go, past }) {
  const src = PRACTICE_SRC[p.source] || PRACTICE_SRC.custom;
  const s = p.session;
  const generating = p.gen === "generating";
  const pct = s.status === "done" ? Math.round(s.right / (s.right + s.wrong) * 100) : 0;

  return (
    <Card pad hover={!generating} className={"paper-card" + (generating ? " is-gen" : "") + (past ? " is-past" : "")}>
      <div className="paper-top">
        <span className={"card-icon paper-src tone-" + src.tone}><Icon name={src.icon} size={18} /></span>
        <div className="paper-head-main">
          <div className="paper-title">{p.title}</div>
          <div className="paper-meta nowrap-meta">
            <span>{p.source === "coach" ? "Coach 排期" : p.source === "custom" ? "用户自建" : "笔记小测"}</span>
            <span className="dot-sep">·</span>
            <span>{p.created}</span>
            {s.status === "done" && <><span className="dot-sep">·</span><span>用时 {s.dur}</span></>}
          </div>
        </div>
        <div className="paper-count"><b className="tnum">{p.count}</b><span>题</span></div>
      </div>

      <div className="paper-know">
        {p.knowledge.map((k) => <span key={k} className="chip chip-k">{k}</span>)}
      </div>

      {/* coach reason — only on the recommended not-started today paper */}
      {p.reason && s.status === "not_started" && !generating && (
        <div className="paper-reason"><Icon name="sparkle" size={13} className="ico" /><span>{p.reason}</span></div>
      )}

      {/* generating */}
      {generating && (
        <div className="paper-genbar">
          <div className="bar"><span style={{ width: (p.genPct || 40) + "%" }} /></div>
          <span className="paper-gen-label"><Icon name="refresh" size={12} className="spin" />{p.genPct || 40}%</span>
        </div>
      )}

      {/* in-progress position */}
      {s.status === "in_progress" && (
        <div className="paper-prog">
          <div className="bar"><span style={{ width: (s.pos / p.count * 100) + "%" }} /></div>
          <span className="paper-prog-label tnum">{s.pos}/{p.count} · {s.left}</span>
        </div>
      )}

      {/* done summary: 对错分布 */}
      {s.status === "done" && (
        <div className="dist-row">
          <div className="dist-block">
            <div className="dist-bar">
              <span className="dist-seg good" style={{ flex: s.right }} />
              <span className="dist-seg again" style={{ flex: s.wrong }} />
            </div>
            <div className="dist-legend">
              <span className="g-right">{s.right} 对</span><span className="dot-sep">·</span>
              <span className="g-wrong">{s.wrong} 错</span>
            </div>
          </div>
          <div className="dist-score"><b className="serif tnum">{pct}%</b><span>正确率</span></div>
        </div>
      )}

      {/* foot — actions */}
      <div className="paper-foot">
        {s.status === "done"
          ? <span className="paper-when">{s.completedAt} 完成</span>
          : s.status === "in_progress"
            ? <span className="paper-when mono">session {p.sid} · 可恢复</span>
            : generating
              ? <span className="paper-when">Coach 排卷中…</span>
              : <span className="paper-when">{p.est || "未开始"}</span>}

        {generating ? (
          <Btn size="sm" variant="ghost" icon="clock" disabled>等待生成</Btn>
        ) : s.status === "in_progress" ? (
          <Btn size="sm" variant="primary" icon="review" onClick={() => go("review")}>继续</Btn>
        ) : s.status === "done" ? (
          <Btn size="sm" variant="secondary" iconEnd="arrow" onClick={() => go("learning-sessions")}>查看回顾</Btn>
        ) : (
          <Btn size="sm" variant="primary" icon="bolt" onClick={() => go("review")}>开始</Btn>
        )}
      </div>
    </Card>
  );
}

function PracticeEmptyToday({ go }) {
  return (
    <Card pad className="paper-empty">
      <EmptyState icon="target" title="今天还没有成卷"
        text="Coach 会在夜间根据你的薄弱点排出今日卷；也可以现在自己建一张测验。"
        action={
          <div className="hero-cta" style={{ justifyContent: "center", marginTop: "var(--s-4)" }}>
            <Btn variant="secondary" icon="clock" onClick={() => go("coach")}>看 Coach 排期</Btn>
            <Btn variant="primary" icon="plus" onClick={() => go("record")}>新建自定义卷</Btn>
          </div>
        } />
    </Card>
  );
}

function ScreenPractice({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const P = DATA.practice;
  const [filter, setFilter] = React.useState("全部");

  const filters = [
    { id: "全部", label: "全部" },
    { id: "coach", label: "Coach 排期", icon: "target" },
    { id: "custom", label: "用户自建", icon: "pencil" },
    { id: "note", label: "笔记小测", icon: "doc" },
  ];
  const past = filter === "全部" ? P.past : P.past.filter((p) => p.source === filter);

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow"><span className="dot-sep">●</span>PRACTICE · session(type='paper') · 今日 {P.today.length} · 往日 {P.past.length}</div>
        <div className="page-head-row">
          <h1 className="page-title serif">练习</h1>
          <div className="practice-aux">
            <Btn variant="ghost" icon="clock" onClick={() => go("coach")}>Coach 排期</Btn>
            <Btn variant="secondary" icon="plus" onClick={() => go("record")}>新建自定义卷</Btn>
          </div>
        </div>
        <p className="page-lead">成卷练习管理成组的试卷 —— Coach 夜间排出的今日卷、你自建的测验，以及笔记里的内嵌小测。与「复习」逐张到期的 FSRS 流不同，这里以整张卷为单位作答与回顾。</p>
      </div>

      {/* ── 今日 ── */}
      <SectionLabel count={P.today.length}>今日</SectionLabel>
      <Stateful state={ds} onRetry={() => {}} errorText="无法读取今日成卷。"
        skeleton={<div className="paper-grid">{[1, 2].map((i) => <Card key={i} pad><SkLines rows={2} /></Card>)}</div>}
        empty={<PracticeEmptyToday go={go} />}>
        {P.today.length === 0
          ? <PracticeEmptyToday go={go} />
          : <div className="paper-grid stagger">{P.today.map((p) => <PaperCard key={p.id} p={p} go={go} />)}</div>}
      </Stateful>

      {/* ── 往日 ── */}
      <SectionLabel count={P.past.length}>往日</SectionLabel>
      <div className="status-tabs" role="tablist">
        {filters.map((f) => {
          const n = f.id === "全部" ? P.past.length : P.past.filter((p) => p.source === f.id).length;
          return (
            <button key={f.id} role="tab" aria-selected={filter === f.id}
              className={"status-tab" + (filter === f.id ? " on" : "")} onClick={() => setFilter(f.id)}>
              {f.icon && <Icon name={f.icon} size={13} />}{f.label}
              <span className="mono status-tab-n">{n}</span>
            </button>
          );
        })}
      </div>

      {past.length === 0 ? (
        <EmptyState icon="history" title="这个来源还没有记录" text="切换其它来源，或先做一张卷。" />
      ) : (
        <div className="paper-grid stagger">{past.map((p) => <PaperCard key={p.id} p={p} go={go} past />)}</div>
      )}
    </div>
  );
}

window.ScreenPractice = ScreenPractice;
