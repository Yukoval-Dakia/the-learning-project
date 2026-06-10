// Loom · 练习面 — 卷架 (卷的持久收藏与复盘).
// 浏览/复盘面：按状态分区（待做 / 在做 / 已完成），按来源筛。
// 唯一写操作 = 从待做/在做卷发起作答；已完成卷点开复盘。

function PfaceShelf({ paperItemStatus, paperSt, ondemand, openPaper, openRetro, addToast }) {
  const [src, setSrc] = React.useState("all");
  const today = PFACE.paper;

  // 待做 / 在做 / 已完成 — 今日卷按 runtime 状态归区
  const todo = [];
  const doing = [];
  const done = [];

  if (paperItemStatus === "pending") todo.push({ kind: "today" });
  if (paperItemStatus === "in_progress") doing.push({ kind: "today" });
  if (paperItemStatus === "done" && paperSt.result) done.push({ kind: "today" });
  todo.push({ kind: "gen", p: PFACE.shelf.generating });
  if (ondemand && ondemand.status === "ready") todo.push({ kind: "ondemand" });
  PFACE.shelf.done.forEach((p) => done.push({ kind: "hist", p }));

  const srcOf = (e) => e.kind === "today" ? "paper" : e.kind === "ondemand" ? "on_demand" : e.p.source;
  const fil = (arr) => src === "all" ? arr : arr.filter((e) => srcOf(e) === src);

  const counts = {};
  [...todo, ...doing, ...done].forEach((e) => { const s = srcOf(e); counts[s] = (counts[s] || 0) + 1; });
  const FILTERS = [["all", "全部"], ["paper", "AI 打包"], ["on_demand", "点播"], ["import", "导入"]];

  const answeredN = today.questions.filter((q) => {
    const a = paperSt.answers[q.id];
    return q.type === "choice" ? a != null : (a && a.trim());
  }).length;

  const card = (e, i) => {
    if (e.kind === "today" || e.kind === "ondemand") {
      const isOd = e.kind === "ondemand";
      const title = isOd ? "点播 · " + ondemand.title : today.title;
      const count = isOd ? 8 : today.count;
      const st = isOd ? "pending" : paperItemStatus;
      const r = paperSt.result;
      return (
        <Card pad hover key={"t" + i} className="paper-card">
          <div className="paper-top">
            <span className={"card-icon paper-src tone-" + (isOd ? "info" : "coral")}><Icon name={isOd ? "send" : "layers"} size={18} /></span>
            <div className="paper-head-main">
              <div className="paper-title">{title}</div>
              <div className="paper-meta nowrap-meta">
                <span>{PFACE_SRC[isOd ? "on_demand" : "paper"].label}</span>
                <span className="dot-sep">·</span><span>今 07:00</span>
              </div>
            </div>
            <div className="paper-count"><b className="tnum">{count}</b><span>题</span></div>
          </div>
          {!isOd && <div className="paper-know">{today.kps.map((k) => <span key={k} className="chip chip-k">{k}</span>)}</div>}

          {st === "in_progress" && (
            <div className="paper-prog">
              <div className="bar"><span style={{ width: (answeredN / today.count * 100) + "%" }} /></div>
              <span className="paper-prog-label tnum">已答 {answeredN}/{today.count} · 草稿已存</span>
            </div>
          )}
          {st === "done" && r && (
            <div className="dist-row">
              <div className="dist-block">
                <div className="dist-bar">
                  {r.good > 0 && <span className="dist-seg good" style={{ flex: r.good }} />}
                  {r.hard > 0 && <span className="dist-seg" style={{ flex: r.hard, background: "var(--hard)" }} />}
                  {r.again > 0 && <span className="dist-seg again" style={{ flex: r.again }} />}
                </div>
                <div className="dist-legend">
                  <span className="g-right">{r.good} 对</span><span className="dot-sep">·</span>
                  <span className="g-wrong">{r.again + r.hard} 待巩固</span>
                </div>
              </div>
              <div className="dist-score"><b className="serif tnum">{r.good}/{today.count}</b><span>今天 {r.at}</span></div>
            </div>
          )}

          <div className="paper-foot">
            {st === "done"
              ? <span className="paper-when">今天 {r && r.at} 完成</span>
              : st === "in_progress"
                ? <span className="paper-when mono">draft · 可恢复</span>
                : <span className="paper-when">{isOd ? "约 12 分钟" : today.est}</span>}
            {isOd
              ? <Btn size="sm" variant="secondary" icon="bolt" onClick={() => addToast("示例点播卷未配题面——作答演示请走今日卷。", "info", "alert")}>开始</Btn>
              : st === "done"
                ? <Btn size="sm" variant="secondary" iconEnd="arrow" onClick={() => openRetro("__today")}>复盘</Btn>
                : <Btn size="sm" variant="primary" icon={st === "in_progress" ? "review" : "bolt"} onClick={openPaper}>{st === "in_progress" ? "继续" : "开始"}</Btn>}
          </div>
        </Card>
      );
    }

    if (e.kind === "gen") {
      const p = e.p;
      return (
        <Card pad key={p.id} className="paper-card is-gen">
          <div className="paper-top">
            <span className="card-icon paper-src tone-info"><Icon name="send" size={18} /></span>
            <div className="paper-head-main">
              <div className="paper-title">{p.title}</div>
              <div className="paper-meta nowrap-meta"><span>{PFACE_SRC[p.source].label}</span><span className="dot-sep">·</span><span>{p.created}</span></div>
            </div>
            <div className="paper-count"><b className="tnum">{p.count}</b><span>题</span></div>
          </div>
          <div className="paper-reason"><Icon name="sparkle" size={13} className="ico" /><span>{p.reason}</span></div>
          <div className="paper-genbar">
            <div className="bar"><span style={{ width: p.genPct + "%" }} /></div>
            <span className="paper-gen-label"><Icon name="refresh" size={12} className="spin" />{p.genPct}%</span>
          </div>
          <div className="paper-foot">
            <span className="paper-when">排卷中…</span>
            <Btn size="sm" variant="ghost" icon="clock" disabled>等待生成</Btn>
          </div>
        </Card>
      );
    }

    // 历史已完成卷
    const p = e.p;
    return (
      <Card pad hover key={p.id} className="paper-card is-past">
        <div className="paper-top">
          <span className={"card-icon paper-src tone-" + (p.source === "import" ? "info" : "good")}><Icon name={PFACE_SRC[p.source].icon} size={18} /></span>
          <div className="paper-head-main">
            <div className="paper-title">{p.title}</div>
            <div className="paper-meta nowrap-meta">
              <span>{PFACE_SRC[p.source].label}</span><span className="dot-sep">·</span>
              <span>{p.created}</span><span className="dot-sep">·</span><span>用时 {p.dur}</span>
            </div>
          </div>
          <div className="paper-count"><b className="tnum">{p.count}</b><span>题</span></div>
        </div>
        <div className="paper-know">{p.kps.map((k) => <span key={k} className="chip chip-k">{k}</span>)}</div>
        <div className="dist-row">
          <div className="dist-block">
            <div className="dist-bar">
              <span className="dist-seg good" style={{ flex: p.right }} />
              <span className="dist-seg again" style={{ flex: p.wrong }} />
            </div>
            <div className="dist-legend">
              <span className="g-right">{p.right} 对</span><span className="dot-sep">·</span>
              <span className="g-wrong">{p.wrong} 错</span>
            </div>
          </div>
          <div className="dist-score"><b className="serif tnum">{Math.round(p.right / p.count * 100)}%</b><span>正确率</span></div>
        </div>
        <div className="paper-foot">
          <span className="paper-when">{p.completedAt} 完成</span>
          <Btn size="sm" variant="secondary" iconEnd="arrow" onClick={() => openRetro(p.id)}>复盘 · 逐题与去向</Btn>
        </div>
      </Card>
    );
  };

  const section = (label, arr) => {
    const list = fil(arr);
    if (list.length === 0) return null;
    return (
      <React.Fragment key={label}>
        <SectionLabel count={list.length}>{label}</SectionLabel>
        <div className="paper-grid">{list.map(card)}</div>
      </React.Fragment>
    );
  };

  return (
    <div className="pface" data-screen-label="卷架">
      <div className="pfh-filter">
        <span className="filter-row-l mono">来源</span>
        {FILTERS.map(([k, label]) => (
          <button key={k} className={"chip" + (src === k ? " chip-k" : "")} onClick={() => setSrc(k)}>
            {label}{k !== "all" && counts[k] ? <span className="tnum" style={{ opacity: .7 }}>{counts[k]}</span> : null}
          </button>
        ))}
      </div>

      {section("待做", todo)}
      {section("在做", doing)}
      {section("已完成 · 可复盘", done)}

      {fil([...todo, ...doing, ...done]).length === 0 && (
        <EmptyState icon="archive" title="这个来源下还没有卷" text="换个筛选，或回到流里向我点播一份。" />
      )}
    </div>
  );
}

window.PfaceShelf = PfaceShelf;
