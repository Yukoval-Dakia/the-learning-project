// Loom · 练习面 — 卷模式 + 交卷结果 + 复盘.
// §6.4 缓冲反馈的视觉语言：作答全程零语义色（导航 pip 只有「已答」的中性墨点），
// 颜色在交卷瞬间才进场——色彩 = 判定。复盘与结果页共用一套 pfr 骨架。

function PfacePaper({ paper, st, setSt, onExit, onSubmit }) {
  const [confirm, setConfirm] = React.useState(false);
  const qs = paper.questions;
  const pos = Math.min(st.pos, qs.length - 1);
  const q = qs[pos];
  const answered = qs.filter((x) => {
    const a = st.answers[x.id];
    return x.type === "choice" ? a != null : (a && a.trim());
  }).length;
  const unanswered = qs.length - answered;

  const setAnswer = (v) => setSt((p) => ({ ...p, answers: { ...p.answers, [q.id]: v } }));
  const goPos = (n) => { setConfirm(false); setSt((p) => ({ ...p, pos: Math.max(0, Math.min(qs.length - 1, n)) })); };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") goPos(pos - 1);
      if (e.key === "ArrowRight") goPos(pos + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos]);

  return (
    <div className="pfp view" data-screen-label={"卷模式 · " + paper.id}>
      <div className="pfp-top">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onExit}>退出 · 进度保留</Btn>
        <span className="pfp-title">{paper.title}</span>
        <span className="pfp-saved"><Icon name="check" size={12} />草稿自动保存</span>
      </div>

      <div className="pfp-buffer">
        <Icon name="clock" size={14} />
        <span>反馈缓冲：这张卷不给即时对错——交卷后统一判分。和散题的节奏是反着的，刻意的。</span>
      </div>

      <div className="pfp-pips" role="tablist" aria-label="题目导航">
        {qs.map((x, i) => {
          const a = st.answers[x.id];
          const has = x.type === "choice" ? a != null : (a && a.trim());
          return (
            <button key={x.id} role="tab" aria-selected={i === pos}
              className={"pfp-pip" + (i === pos ? " current" : "") + (has ? " answered" : "")}
              onClick={() => goPos(i)} title={x.kp}>
              {i + 1}
            </button>
          );
        })}
      </div>

      <Card pad padLg>
        <div className="nowrap-meta" style={{ marginBottom: "var(--s-2)" }}>
          <span className="chip">{q.kp}</span>
          <span className="meta mono">{q.id} · {pos + 1}/{qs.length}</span>
        </div>
        <div className="pfs-stem">{q.stem}</div>
        {q.passage && (
          <div className="pfs-passage wenyan">{q.passage}
            {q.passageSrc && <span className="pfs-passage-src">{q.passageSrc}</span>}
          </div>
        )}

        {q.type === "choice" ? (
          <div className="pfs-opts" role="radiogroup" aria-label="选项">
            {q.options.map((o, i) => (
              <button key={o.k} role="radio" aria-checked={st.answers[q.id] === i}
                className={"pfs-opt" + (st.answers[q.id] === i ? " is-sel" : "")}
                onClick={() => setAnswer(i)}>
                <span className="k mono">{o.k}</span>
                <span className="t">{o.text}</span>
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginTop: "var(--s-5)" }}>
            <div className="composer answer-composer">
              <textarea rows={3} value={st.answers[q.id] || ""}
                placeholder="写下你的译文。交卷前都可以改。"
                onChange={(e) => setAnswer(e.target.value)} aria-label="作答" />
            </div>
          </div>
        )}
      </Card>

      <div className="pfp-foot">
        <Btn size="sm" variant="secondary" icon="arrowL" disabled={pos === 0} onClick={() => goPos(pos - 1)}>上一题</Btn>
        <Btn size="sm" variant="secondary" iconEnd="arrow" disabled={pos === qs.length - 1} onClick={() => goPos(pos + 1)}>下一题</Btn>
        <span className="pfp-count tnum">已答 {answered} / {qs.length}</span>
        {confirm ? (
          <span className="nowrap-meta">
            <span className="meta">还有 {unanswered} 题空着——仍要交？</span>
            <Btn size="sm" variant="primary" icon="send" onClick={onSubmit}>交卷</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setConfirm(false)}>再看看</Btn>
          </span>
        ) : (
          <Btn size="sm" variant="primary" icon="send"
            onClick={() => (unanswered > 0 ? setConfirm(true) : onSubmit())}>
            交卷 · 统一判分
          </Btn>
        )}
      </div>
      <div className="key-hints mono" style={{ marginTop: "var(--s-3)" }}>← → 前后移动 · 中途退出进度保留</div>
    </div>
  );
}

/* ── 结果/复盘共用骨架 ── */
function PfrQRow({ n, kp, stem, verdict, you, fb, explain, trace, appealable, addToast }) {
  const [open, setOpen] = React.useState(verdict !== "good");
  const [appealed, setAppealed] = React.useState(false);
  const v = PF_VERDICT[verdict];
  return (
    <div className="pfr-q">
      <button className="pfr-q-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="pfr-q-n">{String(n).padStart(2, "0")}</span>
        <span className="pfr-q-stem">{kp ? <b style={{ fontWeight: 600 }}>{kp}</b> : null}{kp ? " · " : ""}{stem}</span>
        <span className={"badge tone-" + v.tone}>{v.label}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={15} style={{ color: "var(--ink-4)", flex: "none" }} />
      </button>
      {open && (
        <div className="pfr-q-body">
          {you != null && <div className="pfr-q-row"><span className="cmp-label">你的作答</span>{you === "" ? <span className="quiet-empty" style={{ padding: 0 }}>（未作答）</span> : <span className="wenyan">{you}</span>}</div>}
          {(fb || explain) && <div className="pfr-q-row"><span className="cmp-label">AI 反馈</span>{fb || explain}</div>}
          {trace && (
            <div className="pfr-trace">
              <span className="pfr-trace-row"><Icon name="mistakes" size={13} />{trace.attributed}</span>
              {trace.variant && <span className="pfr-trace-row"><Icon name="spark2" size={13} />{trace.variant}</span>}
            </div>
          )}
          {appealable && verdict !== "good" && (
            appealed
              ? <span className="badge tone-info" style={{ alignSelf: "flex-start" }}><span className="dot pulse" />重判中 · 结果回来会提醒你</span>
              : <button className="pfs-appeal-link" style={{ alignSelf: "flex-start" }}
                  onClick={() => { setAppealed(true); addToast && addToast("已提交重判——异步跑，不挡你复盘。", "info", "clock"); }}>
                  不服判？附理由重判
                </button>
          )}
        </div>
      )}
    </div>
  );
}

function PfrBody({ title, meta, good, hard, again, total, summary, summaryMeta, rows, addToast, appealable }) {
  return (
    <React.Fragment>
      <div className="pfr-hero">
        <div className="pfr-score">
          <b className="tnum">{good}<span style={{ fontSize: 28, color: "var(--ink-4)" }}> / {total}</span></b>
          <span>对 · {meta}</span>
        </div>
        <div className="pfr-dist">
          <div className="dist-bar" style={{ height: 10 }}>
            {good > 0 && <span className="dist-seg good" style={{ flex: good }} />}
            {hard > 0 && <span className="dist-seg" style={{ flex: hard, background: "var(--hard)" }} />}
            {again > 0 && <span className="dist-seg again" style={{ flex: again }} />}
          </div>
          <div className="dist-legend">
            <span className="g-right">{good} 对</span>
            {hard > 0 && <React.Fragment><span className="dot-sep">·</span><span style={{ color: "var(--hard-ink)" }}>{hard} 部分</span></React.Fragment>}
            <span className="dot-sep">·</span><span className="g-wrong">{again} 错</span>
          </div>
        </div>
      </div>

      <div className="pfr-summary">
        <span className="pf-open-ava"><Icon name="sparkle" size={16} /></span>
        <div>
          <p className="pfr-summary-text">{summary}</p>
          <div className="pfr-summary-meta">{summaryMeta}</div>
        </div>
      </div>

      <div className="pfr-list">
        {rows.map((r, i) => <PfrQRow key={i} n={i + 1} {...r} appealable={appealable} addToast={addToast} />)}
      </div>
    </React.Fragment>
  );
}

function PfaceResult({ paper, result, onBack, onShelf, addToast }) {
  const wrongish = result.hard + result.again;
  const summary = paper.summaryByWrong[wrongish] || paper.summaryByWrong.n;
  const rows = paper.questions.map((q, i) => {
    const per = result.per[i];
    const you = q.type === "choice"
      ? (per.answer != null ? q.options[per.answer].k + " · " + q.options[per.answer].text : "")
      : (per.answer || "");
    return { kp: q.kp, stem: q.stem, verdict: per.verdict, you,
      fb: per.verdict === "good" ? q.explain : (q.explain + (q.reference ? "　参考：" + q.reference : "")),
      trace: per.verdict !== "good" ? { attributed: "已归因 · caused_by 链写入事件", variant: "变式生成中 · 将排入明天的流" } : null };
  });
  return (
    <div className="pfr view" data-screen-label={"交卷结果 · " + paper.id}>
      <div className="pfs-top">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>回到流</Btn>
        <span className="pfp-title">{paper.title} · 结果</span>
      </div>
      <PfrBody good={result.good} hard={result.hard} again={result.again} total={paper.count}
        meta={"交卷 " + result.at} summary={summary}
        summaryMeta="paper.judge · Sonnet · $0.14 · 38s" rows={rows} addToast={addToast} appealable />
      <div className="pfr-foot">
        <Btn variant="primary" icon="review" onClick={onBack}>回到流 · 还有下一项</Btn>
        <Btn variant="secondary" icon="archive" onClick={onShelf}>进卷架看历史</Btn>
      </div>
    </div>
  );
}

function PfaceRetro({ retroId, paperSt, onBack, addToast }) {
  // 复盘：今日卷（runtime）或卷架历史卷（authored）
  if (retroId === "__today") {
    const r = paperSt.result;
    if (!r) return null;
    const paper = PFACE.paper;
    const wrongish = r.hard + r.again;
    const rows = paper.questions.map((q, i) => {
      const per = r.per[i];
      const you = q.type === "choice"
        ? (per.answer != null ? q.options[per.answer].k + " · " + q.options[per.answer].text : "")
        : (per.answer || "");
      return { kp: q.kp, stem: q.stem, verdict: per.verdict, you, fb: q.explain,
        trace: per.verdict !== "good" ? { attributed: "已归因 · caused_by 链写入事件", variant: "变式生成中 · 将排入明天的流" } : null };
    });
    return (
      <div className="pfr view" data-screen-label="复盘 · 今日卷">
        <div className="pfs-top">
          <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>返回卷架</Btn>
          <span className="pfp-title">{paper.title} · 复盘</span>
        </div>
        <PfrBody good={r.good} hard={r.hard} again={r.again} total={paper.count}
          meta={"今天 " + r.at + " 完成"} summary={paper.summaryByWrong[wrongish] || paper.summaryByWrong.n}
          summaryMeta="paper.judge · Sonnet · $0.14" rows={rows} addToast={addToast} appealable />
        <div className="pfr-foot"><Btn variant="secondary" icon="arrowL" onClick={onBack}>返回卷架</Btn></div>
      </div>
    );
  }

  const p = PFACE.shelf.done.find((x) => x.id === retroId);
  if (!p) return null;
  const rows = p.review.map((r) => ({ kp: r.kp, stem: r.stem, verdict: r.verdict, you: r.you, fb: r.fb, trace: r.trace }));
  return (
    <div className="pfr view" data-screen-label={"复盘 · " + p.id}>
      <div className="pfs-top">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>返回卷架</Btn>
        <span className="pfp-title">{p.title} · 复盘</span>
        <span className="meta mono">{p.completedAt} 完成 · 用时 {p.dur}</span>
      </div>
      <PfrBody good={p.right} hard={0} again={p.wrong} total={p.count}
        meta={p.completedAt + " · " + p.dur} summary={p.summary}
        summaryMeta="paper.judge · Sonnet" rows={rows} addToast={addToast} appealable={false} />
      <div className="pfr-foot"><Btn variant="secondary" icon="arrowL" onClick={onBack}>返回卷架</Btn></div>
    </div>
  );
}

window.PfacePaper = PfacePaper;
window.PfaceResult = PfaceResult;
window.PfaceRetro = PfaceRetro;
window.PfrBody = PfrBody;
