// Loom · 练习面 host — 状态机 + 持久化 + toast.
// 视图：流 (默认) / 卷架 (param="shelf") / 散题作答 / 卷模式 / 结果 / 复盘.
// 机制不暴露：页面只见 AI 的一句话理由与判定，无 FSRS/调度细节。

const PFACE_LS = "loom-pface-v1";
const pfNow = () => new Date().toTimeString().slice(0, 5);

function pfLoad() {
  try { return JSON.parse(localStorage.getItem(PFACE_LS)) || {}; } catch (e) { return {}; }
}

const PF_VERDICT = {
  good: { label: "对", tone: "good" },
  hard: { label: "部分对", tone: "hard" },
  again: { label: "错", tone: "again" },
};

function ScreenPracticeFace({ go, param }) {
  const saved = React.useRef(pfLoad()).current;
  const [itemStatus, setItemStatus] = React.useState(saved.itemStatus || {});
  const [extra, setExtra] = React.useState(saved.extra || false);
  const [ondemand, setOndemand] = React.useState(saved.ondemand || null); // {title,status:'gen'|'ready',pct}
  const [paperSt, setPaperSt] = React.useState(saved.paper || { answers: {}, pos: 0, submitted: false, started: false, result: null });
  const [mode, setMode] = React.useState("stream"); // stream | solo | paper | result | retro
  const [soloId, setSoloId] = React.useState(null);   // stream item id
  const [retroId, setRetroId] = React.useState(null); // shelf paper id | "__today"
  const [toasts, setToasts] = React.useState([]);
  const [appeals, setAppeals] = React.useState({});   // qid -> 'pending' | 'resolved'
  const [noticeNew, setNoticeNew] = React.useState(false);

  // persist
  React.useEffect(() => {
    localStorage.setItem(PFACE_LS, JSON.stringify({ itemStatus, extra, ondemand, paper: paperSt }));
  }, [itemStatus, extra, ondemand, paperSt]);

  const addToast = (text, tone, icon) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, tone, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  };

  // ── item 状态 ──────────────────────────────────────────────
  const paperItemStatus = paperSt.submitted ? "done" : (paperSt.started ? "in_progress" : "pending");
  const statusOf = (it) => {
    if (it.kind === "paper") return { status: paperItemStatus };
    const o = itemStatus[it.id];
    if (o) return o;
    if (it.init === "done") return { status: "done", verdict: it.doneVerdict, at: it.doneAt };
    return { status: "pending" };
  };

  const items = React.useMemo(() => {
    const arr = [...PFACE.items];
    if (extra) {
      const i = arr.findIndex((it) => statusOf(it).status === "pending");
      arr.splice(i === -1 ? arr.length : i + 1, 0, PFACE.extraItem);
    }
    return arr;
  }, [extra, itemStatus, paperItemStatus]);

  const doneCount = items.filter((it) => statusOf(it).status === "done").length;
  const allDone = doneCount === items.length;
  const currentItem = items.find((it) => statusOf(it).status === "pending");

  // ── 增补 / 重置（Tweaks 触发） ─────────────────────────────
  React.useEffect(() => {
    const inject = () => {
      setExtra((e) => {
        if (e) { addToast("变式已经在流里了——先在 Tweaks 重置演示。", "info", "alert"); return e; }
        setNoticeNew(true);
        setTimeout(() => setNoticeNew(false), 12000);
        addToast("我现做了一道「否定句宾语前置」的变式，排进了流里——不打断你手上这道。", null, "sparkle");
        return true;
      });
    };
    const reset = () => {
      setItemStatus({}); setExtra(false); setOndemand(null); setAppeals({});
      setPaperSt({ answers: {}, pos: 0, submitted: false, started: false, result: null });
      setMode("stream"); setSoloId(null);
      localStorage.removeItem(PFACE_LS);
    };
    window.addEventListener("pface-inject", inject);
    window.addEventListener("pface-reset", reset);
    return () => { window.removeEventListener("pface-inject", inject); window.removeEventListener("pface-reset", reset); };
  }, []);

  // ── 点播生成 tick ──────────────────────────────────────────
  React.useEffect(() => {
    if (!ondemand || ondemand.status !== "gen") return;
    const t = setInterval(() => {
      setOndemand((o) => {
        if (!o || o.status !== "gen") return o;
        const pct = Math.min(100, o.pct + 9 + Math.random() * 8);
        if (pct >= 100) {
          addToast("你点播的卷排好了 · 8 题，已加到流尾。", null, "layers");
          return { ...o, pct: 100, status: "ready" };
        }
        return { ...o, pct };
      });
    }, 650);
    return () => clearInterval(t);
  }, [ondemand && ondemand.status]);

  // ── 不服判 → 异步重判 ─────────────────────────────────────
  const startAppeal = (qid, itemId) => {
    setAppeals((a) => ({ ...a, [qid]: "pending" }));
    setTimeout(() => {
      setAppeals((a) => ({ ...a, [qid]: "resolved" }));
      setItemStatus((s) => {
        const cur = s[itemId];
        if (cur && cur.status === "done") return { ...s, [itemId]: { ...cur, verdict: "good", appealed: true } };
        return s;
      });
      addToast("重判回来了：「吾妻之美我者」改判为对——评级建议已上调。", "info", "review");
    }, 6500);
  };

  // ── 流转 ───────────────────────────────────────────────────
  const openItem = (it) => {
    const st = statusOf(it).status;
    if (it.kind === "paper") {
      if (st === "done") { setRetroId("__today"); setMode("retro"); return; }
      setPaperSt((p) => ({ ...p, started: true }));
      setMode("paper");
      return;
    }
    if (it.id === PFACE.items[0].id || PFACE.questions[it.ref].done) return; // 已完成散题不可重进
    setSoloId(it.id); setMode("solo");
  };

  const completeItem = (itemId, verdict) => {
    const itRef = items.find((x) => x.id === itemId);
    const appealed = itRef && appeals[itRef.ref] === "resolved";
    const entry = { status: "done", verdict, at: pfNow(), appealed };
    const next = (() => {
      const upd = { ...itemStatus, [itemId]: entry };
      const pending = items.filter((it) => {
        if (it.id === itemId) return false;
        const o = it.kind === "paper" ? { status: paperItemStatus } : (upd[it.id] || (it.init === "done" ? { status: "done" } : { status: "pending" }));
        return o.status === "pending";
      });
      return pending[0] || null;
    })();
    setItemStatus((s) => ({ ...s, [itemId]: entry }));
    if (next && next.kind === "question") { setSoloId(next.id); setMode("solo"); }
    else {
      setMode("stream"); setSoloId(null);
      if (next && next.kind === "paper") addToast("下一项是今天的卷——卷内不给即时反馈，准备好了再进。", "info", "layers");
    }
  };

  const skipItem = (it) => {
    setItemStatus((s) => ({ ...s, [it.id]: { status: "skipped" } }));
  };
  const unskip = (it) => {
    setItemStatus((s) => { const c = { ...s }; delete c[it.id]; return c; });
  };

  const submitPaper = () => {
    const qs = PFACE.paper.questions;
    const per = qs.map((q) => {
      const a = paperSt.answers[q.id];
      let verdict;
      if (q.type === "choice") verdict = a == null ? "again" : (a === q.correct ? "good" : "again");
      else verdict = a && a.trim() ? (q.cannedVerdict || "good") : "again";
      return { id: q.id, verdict, answer: a };
    });
    const result = {
      per, at: pfNow(),
      good: per.filter((p) => p.verdict === "good").length,
      hard: per.filter((p) => p.verdict === "hard").length,
      again: per.filter((p) => p.verdict === "again").length,
    };
    setPaperSt((p) => ({ ...p, submitted: true, result }));
    setMode("result");
  };

  // ── 视图分发 ───────────────────────────────────────────────
  const view = param === "shelf" ? "shelf" : "stream";
  const soloItem = soloId && items.find((it) => it.id === soloId);

  let body;
  if (mode === "solo" && soloItem) {
    const pos = items.indexOf(soloItem) + 1;
    body = (
      <PfaceSolo
        key={soloItem.id}
        item={soloItem} q={PFACE.questions[soloItem.ref]} pos={pos} total={items.length}
        appeal={appeals[soloItem.ref]}
        onAppeal={() => startAppeal(soloItem.ref, soloItem.id)}
        onDone={(verdict) => completeItem(soloItem.id, verdict)}
        onBack={() => { setMode("stream"); setSoloId(null); }}
        addToast={addToast}
      />
    );
  } else if (mode === "paper") {
    body = (
      <PfacePaper
        paper={PFACE.paper} st={paperSt} setSt={setPaperSt}
        onExit={() => { setMode("stream"); addToast("进度已保留——卷在流里等你回来。", "info", "clock"); }}
        onSubmit={submitPaper}
      />
    );
  } else if (mode === "result" && paperSt.result) {
    body = (
      <PfaceResult
        paper={PFACE.paper} result={paperSt.result} addToast={addToast}
        onBack={() => { setMode("stream"); go("practice"); }}
        onShelf={() => { setMode("stream"); go("practice/shelf"); }}
      />
    );
  } else if (mode === "retro") {
    body = (
      <PfaceRetro
        retroId={retroId} paperSt={paperSt} addToast={addToast}
        onBack={() => { setMode("stream"); go("practice/shelf"); }}
      />
    );
  } else {
    body = (
      <React.Fragment>
        <div className="page-head">
          <span className="eyebrow">{view === "shelf"
            ? <React.Fragment>PRACTICE · 卷架<span className="dot-sep" style={{ margin: "0 8px" }}>·</span>papers · 待做 / 在做 / 已完成</React.Fragment>
            : <React.Fragment>PRACTICE · GET /api/practice/stream?date=today</React.Fragment>}</span>
          <div className="pface-head-row">
            <h1 className="page-title">练习</h1>
            <div className="seg" role="tablist" aria-label="练习视图">
              <button className={view === "stream" ? "on" : ""} role="tab" aria-selected={view === "stream"} onClick={() => { setMode("stream"); go("practice"); }}><Icon name="review" size={14} />今日流</button>
              <button className={view === "shelf" ? "on" : ""} role="tab" aria-selected={view === "shelf"} onClick={() => { setMode("stream"); go("practice/shelf"); }}><Icon name="archive" size={14} />卷架</button>
            </div>
          </div>
        </div>
        {view === "shelf" ? (
          <PfaceShelf
            paperItemStatus={paperItemStatus} paperSt={paperSt} ondemand={ondemand}
            openPaper={() => { setPaperSt((p) => ({ ...p, started: true })); setMode("paper"); }}
            openRetro={(id) => { setRetroId(id); setMode("retro"); }}
            addToast={addToast}
          />
        ) : (
          <PfaceStream
            items={items} statusOf={statusOf} doneCount={doneCount} allDone={allDone}
            currentItem={currentItem} noticeNew={noticeNew}
            openItem={openItem} skipItem={skipItem} unskip={unskip}
            ondemand={ondemand}
            onDemandSubmit={(text) => setOndemand({ title: text, status: "gen", pct: 6 })}
            addToast={addToast}
          />
        )}
      </React.Fragment>
    );
  }

  return (
    <div className="page page-narrow view" data-screen-label={"练习面 · " + (mode === "stream" ? view : mode)}>
      {body}
      {ReactDOM.createPortal(
        <div className="pf-toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={"pf-toast" + (t.tone === "info" ? " t-info" : "")}>
              <Icon name={t.icon || "sparkle"} size={15} />
              <span>{t.text}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

window.ScreenPracticeFace = ScreenPracticeFace;
window.PF_VERDICT = PF_VERDICT;
