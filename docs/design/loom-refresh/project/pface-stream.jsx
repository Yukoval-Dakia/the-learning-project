// Loom · 练习面 — 流 (今日练什么 · 默认视图).
// §6.1 形态：织线 thread — 一条纵向线，item 挂在线上；AI 的开场白与每条理由
// 用第一人称挂在 item 旁，「陪练递题」。已完成的项收紧成织入的一行。

function PfSrcBadge({ source }) {
  const s = PFACE_SRC[source];
  return <span className={"badge tone-" + s.tone}><Icon name={s.icon} size={12} />{s.label}</span>;
}

function PfaceStream({ items, statusOf, doneCount, allDone, currentItem, noticeNew, openItem, skipItem, unskip, ondemand, onDemandSubmit, addToast }) {
  const [demand, setDemand] = React.useState("");
  const newRef = React.useRef(null);

  const active = items.filter((it) => statusOf(it).status !== "skipped");
  const skipped = items.filter((it) => statusOf(it).status === "skipped");
  const remainQ = items.filter((it) => statusOf(it).status === "pending");
  const etaMin = remainQ.reduce((m, it) => m + (it.kind === "paper" ? 10 : 2), 0);

  const scrollToNew = () => {
    const el = newRef.current;
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: "smooth" });
  };

  const submitDemand = () => {
    const t = demand.trim();
    if (!t) return;
    if (ondemand) { addToast("上一份点播还在排——做完这份再点。", "info", "alert"); return; }
    onDemandSubmit(t);
    setDemand("");
  };

  const row = (it) => {
    const st = statusOf(it);
    const q = it.kind === "question" ? PFACE.questions[it.ref] : null;
    const cls = ["pf-row", "kind-" + it.kind,
      st.status === "done" ? "is-done" : st.status === "skipped" ? "is-skipped" : (currentItem && currentItem.id === it.id) ? "is-current" : "is-pending",
      it.isNew ? "is-new" : ""].join(" ");

    // 已完成 — 织入的一行
    if (st.status === "done") {
      return (
        <div key={it.id} className={cls}>
          <span className="pf-node" />
          <div className="pf-done">
            <PfSrcBadge source={it.source} />
            <span className="pf-done-kp">{it.kind === "paper" ? PFACE.paper.title : q.kp}</span>
            {st.verdict && <span className={"badge tone-" + PF_VERDICT[st.verdict].tone}>{PF_VERDICT[st.verdict].label}</span>}
            {st.appealed && <span className="badge tone-info"><Icon name="review" size={11} />已改判</span>}
            <span className="pf-done-at">{st.at || ""} 完成</span>
          </div>
        </div>
      );
    }

    const isCur = currentItem && currentItem.id === it.id;
    const isSkipped = st.status === "skipped";

    // 卷 item — 摞起来的纸 (§6.2)
    if (it.kind === "paper") {
      const p = PFACE.paper;
      return (
        <div key={it.id} className={cls} ref={it.isNew ? newRef : null}>
          <span className="pf-node" />
          <div className="pf-item-stack">
            <div className="pf-item" role="button" tabIndex={0} onClick={() => openItem(it)}
              onKeyDown={(e) => { if (e.key === "Enter") openItem(it); }}>
              <div className="pf-item-top">
                <PfSrcBadge source={it.source} />
                <span className="pf-item-kind mono"><span className="src-q">paper · {p.id}</span></span>
              </div>
              <div className="pf-paper-title">{p.title}</div>
              <div className="pf-paper-facts">
                <span><b className="tnum">{p.count}</b> 题</span><span className="dot-sep">·</span>
                <span>{p.est}</span>
                {st.status === "in_progress" && <React.Fragment><span className="dot-sep">·</span><span>进行中 · 草稿已存 · 可恢复</span></React.Fragment>}
              </div>
              <span className="pf-paper-note"><Icon name="clock" size={12} />交卷后统一判分 · 卷内无即时反馈</span>
              <div className="pf-reason"><Icon name="sparkle" size={13} /><span>{it.reason}</span></div>
              <div className="pf-item-cta">
                <Btn size="sm" variant={isCur ? "primary" : "secondary"} icon="layers"
                  onClick={(e) => { e.stopPropagation(); openItem(it); }}>
                  {st.status === "in_progress" ? "继续这张卷" : "进入卷"}
                </Btn>
                {!isSkipped && <button className="pf-skip" onClick={(e) => { e.stopPropagation(); skipItem(it); }}>跳过 · 流尾可回头</button>}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // 散题 item
    return (
      <div key={it.id} className={cls} ref={it.isNew ? newRef : null}>
        <span className="pf-node" />
        <div className="pf-item" role="button" tabIndex={0} onClick={() => openItem(it)}
          onKeyDown={(e) => { if (e.key === "Enter") openItem(it); }}>
          <div className="pf-item-top">
            <PfSrcBadge source={it.source} />
            {it.isNew && <span className="badge tone-coral"><span className="dot pulse" />刚排入</span>}
            <span className="pf-item-kp">{q.kp}</span>
            <span className="pf-item-kind mono"><span className="src-q">question · {it.ref}</span></span>
          </div>
          <div className="pf-reason"><Icon name="sparkle" size={13} /><span>{it.reason}</span></div>
          <div className="pf-item-cta">
            <Btn size="sm" variant={isCur ? "primary" : "ghost"} icon={isSkipped ? "undo" : "pencil"}
              onClick={(e) => { e.stopPropagation(); if (isSkipped) unskip(it); else openItem(it); }}>
              {isSkipped ? "捡回来" : "开始作答"}
            </Btn>
            {!isSkipped && <button className="pf-skip" onClick={(e) => { e.stopPropagation(); skipItem(it); }}>跳过 · 流尾可回头</button>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="pface">
      {/* AI 开场白 */}
      <div className="pf-open">
        <span className="pf-open-ava"><Icon name="sparkle" size={18} /></span>
        <div>
          <p className="pf-open-line">{allDone ? "都织完了——下面是今天的线头。" : PFACE.opening}</p>
          <span className="pf-open-meta">{PFACE.openingMeta}</span>
        </div>
      </div>

      {/* 进度 */}
      <div className="pf-prog">
        <span className="pf-prog-n"><b className="tnum">{doneCount}</b> / {items.length}</span>
        <div className="bar thin"><span style={{ width: (doneCount / items.length * 100) + "%" }} /></div>
        <span className="pf-prog-eta">{allDone ? "今日完成" : `预计还剩 ~${etaMin} 分钟`}</span>
      </div>

      {/* AI 白天增补 — 可感知、不打断 (§6.3) */}
      {noticeNew && (
        <button className="pf-notice" onClick={scrollToNew}>
          <Icon name="sparkle" size={13} />我刚补了 1 道变式进来 · 点这里看
        </button>
      )}

      <div className="pf-thread">
        {active.map(row)}
      </div>

      {/* 跳过的 · 流尾可回头 */}
      {skipped.length > 0 && (
        <React.Fragment>
          <div className="section-label pf-skipped-label"><h2 className="serif">跳过的</h2><span className="rule" /><span className="count">{skipped.length}</span></div>
          <div className="pf-thread">{skipped.map(row)}</div>
        </React.Fragment>
      )}

      {/* 收尾短结 — 今日全部织完后 */}
      {allDone && (
        <div className="pf-close" style={{ marginTop: "var(--s-8)" }}>
          <span className="pf-open-ava"><Icon name="checkCircle" size={18} /></span>
          <div>
            <p className="pf-close-line">{PFACE.closing}</p>
            <span className="pf-close-meta">coach · 收尾 · $0.006</span>
          </div>
        </div>
      )}

      {/* 点播 — on_demand */}
      <div className="pf-ondemand">
        <div className="pf-ondemand-label"><Icon name="send" size={13} />点播 · ON_DEMAND</div>

        {ondemand && ondemand.status === "gen" && (
          <div className="pf-row kind-paper" style={{ marginBottom: "var(--s-3)" }}>
            <span className="pf-node" style={{ borderStyle: "dashed" }} />
            <div className="pf-item" style={{ cursor: "default" }}>
              <div className="pf-item-top">
                <PfSrcBadge source="on_demand" />
                <span className="pf-item-kp">{ondemand.title}</span>
              </div>
              <div className="pf-gen">
                <div className="bar thin"><span style={{ width: ondemand.pct + "%" }} /></div>
                <span className="pf-gen-label">生成中 · {Math.round(ondemand.pct)}%</span>
              </div>
            </div>
          </div>
        )}

        {ondemand && ondemand.status === "ready" && (
          <div className="pf-row kind-paper is-new" style={{ marginBottom: "var(--s-3)" }}>
            <span className="pf-node" />
            <div className="pf-item-stack">
              <div className="pf-item" role="button" tabIndex={0}
                onClick={() => addToast("示例点播卷未配题面——作答演示请走今日卷。", "info", "alert")}>
                <div className="pf-item-top">
                  <PfSrcBadge source="on_demand" />
                  <span className="badge tone-coral"><span className="dot" />已排好</span>
                </div>
                <div className="pf-paper-title">点播 · {ondemand.title}</div>
                <div className="pf-paper-facts"><span><b className="tnum">8</b> 题</span><span className="dot-sep">·</span><span>约 12 分钟</span></div>
                <div className="pf-reason"><Icon name="sparkle" size={13} /><span>你点的——排在今天流尾，也放进了卷架的待做。</span></div>
              </div>
            </div>
          </div>
        )}

        <div className="composer">
          <textarea rows={1} value={demand} placeholder="向我点播：比如「来份判断句专项卷」"
            onChange={(e) => setDemand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitDemand(); } }}
            aria-label="向 AI 点播" />
          <IconBtn icon="send" size={16} title="点播" onClick={submitDemand} />
        </div>
      </div>
    </div>
  );
}

window.PfaceStream = PfaceStream;
