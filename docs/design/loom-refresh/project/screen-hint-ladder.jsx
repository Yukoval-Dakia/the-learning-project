// Loom · A2 自主滑块 — 从 hint 滑到完整解.
// 默认 hint-first · 每阶用户主动推进 · 可跳到完整解 · 任意阶可交还控制(逃生口).
// 看完整解 = 非独立完成. 取下一阶异步生成(loading) · 生成失败诚实 + 逃生口.
// states demo via `demo`: ok | loading | fail | empty.

function HintLadder({ q, mode = "h0h5", demo = "ok", onEscape }) {
  const ladder = React.useMemo(() => window.ladderFor(q, mode), [q, mode]);
  const fullIdx = ladder.findIndex((s) => s.isFull);
  const [reached, setReached] = React.useState(0);     // highest stage revealed (index)
  const [loading, setLoading] = React.useState(demo === "loading");
  const [failAt, setFailAt] = React.useState(demo === "fail" ? 1 : -1);
  const [revealedFull, setRevealedFull] = React.useState(false);
  const [returned, setReturned] = React.useState(false);
  const tr = window.LADDER_TRACE;

  // empty / unsupported → fall back to 直接作答 + 看完整解
  const unsupported = demo === "empty" || !ladder.length;

  const goStage = (idx, isJump) => {
    if (idx <= reached && !(ladder[idx] && ladder[idx].isFull)) return;
    setLoading(true); setFailAt(-1);
    setTimeout(() => {
      setLoading(false);
      if (demo === "fail" && !isJump) { setFailAt(idx); return; }
      setReached(idx);
      if (ladder[idx] && ladder[idx].isFull) setRevealedFull(true);
    }, 700);
  };

  if (returned) {
    return (
      <div className="ladder">
        <div className="ladder-returned"><Icon name="check" size={16} />控制交还给你了 —— 回到自己作答。需要时再叫我。</div>
      </div>
    );
  }

  if (unsupported) {
    return (
      <div className="ladder">
        <div className="ladder-empty">
          <div className="ladder-empty-t">这道题暂不支持分阶提示</div>
          <div className="ladder-empty-s">题型还没接梯度提示生成。你可以直接作答，或一次看完整解（记为非独立完成）。</div>
          <div className="ladder-empty-acts">
            <button className="ladder-escape" onClick={() => setReturned(true)}><Icon name="undo" size={14} />我自己来</button>
            <button className="ladder-jump" onClick={() => { setRevealedFull(true); setReached(fullIdx); }}><Icon name="eye" size={14} />直接看完整解</button>
          </div>
          {revealedFull && ladder[fullIdx] && (
            <div className="ladder-card full" style={{ marginTop: "var(--s-3)" }}>
              <div className="ladder-card-top"><span className="ladder-badge">完整解</span><span className="ladder-noindep"><Icon name="alert" size={12} />非独立完成</span></div>
              <div className="ladder-body"><span className="wenyan">{ladder[fullIdx].body}</span></div>
              {ladder[fullIdx].explain && <div className="ladder-explain">{ladder[fullIdx].explain}</div>}
            </div>
          )}
        </div>
      </div>
    );
  }

  const cur = ladder[reached];
  const atFull = revealedFull || (cur && cur.isFull);
  const nextIdx = reached + 1;
  const next = ladder[nextIdx];
  const maxLabel = mode === "three" ? "3 阶" : "H0–H5";

  return (
    <div className="ladder">
      <div className="ladder-trace">
        <Icon name="history" size={13} />
        <span>这一阶可追溯到本题 <b>{tr.band}</b>{tr.bandLow ? "（低置信）" : ""} · {tr.cause}。每阶给什么由你决定推进。</span>
      </div>

      {/* autonomy track */}
      <div className="ladder-rail">
        <div className="ladder-rail-head">
          <span className="ladder-rail-l"><Icon name="layers" size={13} />自主程度 · {maxLabel}</span>
          <span className="ladder-rail-r">{atFull ? "已看完整解" : `第 ${cur ? cur.key : ""} 阶`}</span>
        </div>
        <div className="ladder-stops">
          {ladder.map((s, i) => (
            <button key={i} className={"ladder-stop" + (i <= reached ? " reached" : "") + (i === reached ? " current" : "") + (s.isFull ? " is-full" : "")}
              onClick={() => goStage(i, s.isFull)} title={s.key + " · " + s.gives}
              aria-label={"跳到 " + s.key + " 阶：" + s.gives}>
              <span className="ladder-dot" />
              <span className="ladder-stop-l">{s.key}</span>
            </button>
          ))}
        </div>
      </div>

      {/* revealed stage cards up to reached */}
      {ladder.slice(0, reached + 1).map((s, i) => (
        <div key={i} className={"ladder-card" + (s.isFull ? " full" : "")}>
          <div className="ladder-card-top">
            <span className="ladder-badge">{s.key}{!s.isFull ? " · " + s.weight : ""}</span>
            <span className="ladder-gives">{s.gives}</span>
            {s.isFull && <span className="ladder-noindep"><Icon name="alert" size={12} />非独立完成</span>}
          </div>
          <div className="ladder-body"><span className={s.isFull ? "wenyan" : ""}>{s.body}</span></div>
          {s.isFull && s.explain && <div className="ladder-explain">{s.explain}</div>}
        </div>
      ))}

      {loading && <div className="ladder-loading"><span className="ladder-spin" />正在想下一阶提示…</div>}

      {failAt >= 0 && (
        <div className="ladder-fail">
          <div className="ladder-fail-msg"><Icon name="alert" size={14} />这一阶没生成出来 —— 不是装作好了，是真没成。你可以重试，或换条路。</div>
          <div className="ladder-fail-acts">
            <button className="ladder-advance" onClick={() => goStage(failAt, false)}><Icon name="refresh" size={13} />重试这一阶</button>
            <button className="ladder-jump" onClick={() => { setFailAt(-1); setRevealedFull(true); setReached(fullIdx); }}><Icon name="eye" size={14} />直接看完整解</button>
            <button className="ladder-escape" onClick={() => setReturned(true)}><Icon name="undo" size={14} />我自己来</button>
          </div>
        </div>
      )}

      {/* actions: advance one stage · jump to full · escape hatch (always present) */}
      {!loading && failAt < 0 && !atFull && (
        <div className="ladder-acts">
          {next && !next.isFull && (
            <button className="ladder-advance" onClick={() => goStage(nextIdx, false)}>
              <Icon name="chevronDown" size={14} />再给一阶 · {next.key}
            </button>
          )}
          <button className="ladder-jump" onClick={() => goStage(fullIdx, true)}>
            <Icon name="eye" size={14} />直接看完整解
          </button>
          <button className="ladder-escape" onClick={() => setReturned(true)}>
            <Icon name="undo" size={14} />我自己来 · 交还控制
          </button>
        </div>
      )}

      {!loading && atFull && (
        <div className="ladder-acts">
          <button className="ladder-escape" onClick={() => setReturned(true)} style={{ marginLeft: 0 }}>
            <Icon name="undo" size={14} />回到自己作答
          </button>
        </div>
      )}
    </div>
  );
}

window.HintLadder = HintLadder;
