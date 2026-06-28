// Loom · A1 交班缕 (handoff thread) — 今日之线 layer ①.
// Two takes: list (条目) · ribbon (织带). 先轻后叙事 via narrateTiming.
// States: ok · loading(正在准备) · empty(空夜态) · error(降级,部分渲染).
// Hard constraints: MasteryBand(离散档+置信区间+来源二态) · 追溯 · 忽略.

const HO_BANDS = ["萌芽", "成长", "稳固", "精熟"];
const HO_KIND = {
  reorder: { label: "重排复习", tone: "coral", icon: "review" },
  drill:   { label: "备题",     tone: "info",  icon: "layers" },
  edge:    { label: "改图谱",   tone: "coral", icon: "knowledge" },
  recap:   { label: "复盘",     tone: "good",  icon: "target" },
};
const HO_AGENT = {
  dreaming: { label: "dreaming", icon: "moon" },
  coach:    { label: "coach",    icon: "target" },
};

// ── MasteryBand · 离散档 + 置信区间 + 来源二态(硬轨/软轨) ──────────
// 绝不裸数字。band 0..3, lo/hi 区间(band 索引,含端). source: hard|soft.
function MasteryBand({ m }) {
  const segW = 100 / HO_BANDS.length;
  const loX = m.lo * segW;
  const hiX = (m.hi + 1) * segW;
  const pointX = (m.band + 0.5) * segW;
  const soft = m.source === "soft";
  return (
    <div className={"mb " + (soft ? "mb-soft" : "mb-hard")}>
      <div className="mb-top">
        <span className="mb-band">{HO_BANDS[m.band]}</span>
        <span className="mb-node">{m.node}</span>
        <span className="mb-src" title={soft ? "软轨：LLM 先验回吐 prior-echo，未经真实作答校准" : "硬轨：真实作答校准过 firm-up"}>
          <span className="mb-src-dot" />{soft ? "软轨先验" : "硬轨校准"}
        </span>
        {m.lowConf && <span className="mb-lowtag">低置信</span>}
      </div>
      <div className="mb-track" role="img"
        aria-label={`掌握档 ${HO_BANDS[m.band]}，区间 ${HO_BANDS[m.lo]}–${HO_BANDS[m.hi]}，来源 ${soft ? "软轨先验" : "硬轨校准"}${m.lowConf ? "，低置信" : ""}`}>
        {HO_BANDS.map((b, i) => <span key={i} className="mb-seg" style={{ width: segW + "%" }} />)}
        <span className="mb-interval" style={{ left: loX + "%", width: (hiX - loX) + "%" }} />
        <span className="mb-point" style={{ left: pointX + "%" }} />
      </div>
      <div className="mb-scale">
        {HO_BANDS.map((b, i) => <span key={i} className={"mb-tick" + (i === m.band ? " on" : "")}>{b}</span>)}
      </div>
    </div>
  );
}

// ── shared inner content (gist / reason / mastery / narrative / foot) ──
function HandoffInner({ th, go, narrOpen, setNarrOpen, narratable }) {
  const [trace, setTrace] = React.useState(false);
  return (
    <React.Fragment>
      <div className="ho-gist">{th.gist}</div>
      <div className="ho-reason">{th.reason}</div>
      {th.mastery && <MasteryBand m={th.mastery} />}

      {narratable && (
        <button className={"ho-narr-toggle" + (narrOpen ? " open" : "")} onClick={() => setNarrOpen(!narrOpen)}>
          <Icon name="chevronRight" size={14} />
          {narrOpen ? "收起团队复盘" : "展开团队复盘"}
        </button>
      )}
      {narratable && narrOpen && (
        <div className="ho-narr">
          {th.narrative}
          <span className="ho-narr-sig">— {HO_AGENT[th.agent].label} · 昨夜为你复盘</span>
        </div>
      )}

      {trace && (
        <div className="ho-trace">
          来自 <b>{th.trace.posture}</b> 姿势 · {th.trace.when} · 依据 event：
          {th.trace.events.map((e) => <code key={e} className="evt">{e}</code>)}
          <br />{th.trace.note}
        </div>
      )}

      <div className="ho-foot">
        <Btn size="sm" variant={th.isChange ? "secondary" : "primary"} iconEnd="arrow" onClick={() => go(th.next.route)}>
          {th.next.label}
        </Btn>
        <div className="ho-foot-end">
          <button className="ho-linkbtn" onClick={() => setTrace((v) => !v)}>
            <Icon name="history" size={14} />追溯
          </button>
          <button className="ho-linkbtn" title="忽略后，编排者下次不再提这类" onClick={th.onDismiss}>
            <Icon name="close" size={14} />忽略
          </button>
        </div>
      </div>
    </React.Fragment>
  );
}

// ── one entry · list take ──
function HandoffCard({ th, go, narrOpen, setNarrOpen, narratable, dismissed, onUndo }) {
  const k = HO_KIND[th.kind];
  if (dismissed) {
    return (
      <div className="ho-undo">
        <Icon name="check" size={15} />
        已忽略「{th.gist}」· 编排者下次不再提这类。
        <button className="ho-linkbtn" style={{ marginLeft: "auto" }} onClick={onUndo}><Icon name="undo" size={14} />撤销</button>
      </div>
    );
  }
  return (
    <div className={"ho-card" + (th.isChange ? " is-change" : "")}>
      <div className="ho-row">
        <span className={"ho-ic tone-" + k.tone}><Icon name={k.icon} size={18} /></span>
        <div className="ho-body">
          <div className="ho-meta">
            <span className={"ho-kind tone-" + k.tone}>{k.label}</span>
            <span className="ho-attr"><Icon name={HO_AGENT[th.agent].icon} size={13} />{HO_AGENT[th.agent].label}</span>
            {th.isChange && <span className="ho-change-flag"><Icon name="undo" size={13} />可回滚</span>}
          </div>
          <HandoffInner th={th} go={go} narrOpen={narrOpen} setNarrOpen={setNarrOpen} narratable={narratable} />
        </div>
      </div>
    </div>
  );
}

// ── one entry · ribbon take ──
function HandoffNode({ th, go, narrOpen, setNarrOpen, narratable, dismissed, onUndo }) {
  const k = HO_KIND[th.kind];
  return (
    <div className={"ho-node is-" + th.kind + (dismissed ? " is-dismissed" : "")}>
      <span className="ho-node-dot" />
      <div className="ho-node-body">
        <div className="ho-rb-when">{th.trace.when} · {HO_AGENT[th.agent].label}</div>
        {dismissed ? (
          <div className="ho-undo" style={{ border: 0, padding: 0, background: "transparent" }}>
            已忽略此缕。<button className="ho-linkbtn" onClick={onUndo}><Icon name="undo" size={14} />撤销</button>
          </div>
        ) : (
          <div className="ho-row">
            <span className={"ho-ic tone-" + k.tone}><Icon name={k.icon} size={18} /></span>
            <div className="ho-body">
              <div className="ho-meta">
                <span className={"ho-kind tone-" + k.tone}>{k.label}</span>
                {th.isChange && <span className="ho-change-flag"><Icon name="undo" size={13} />可回滚</span>}
              </div>
              <HandoffInner th={th} go={go} narrOpen={narrOpen} setNarrOpen={setNarrOpen} narratable={narratable} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 空夜态 (the flagship empty state) ──
function HandoffEmpty({ go }) {
  return (
    <div className="ho-empty">
      <div className="ho-empty-weave" aria-hidden="true">
        <svg viewBox="0 0 600 260" preserveAspectRatio="none">
          <path d="M0 70 C 150 70, 150 130, 300 130 S 450 70, 600 70" />
          <path d="M0 130 C 150 130, 150 190, 300 190 S 450 130, 600 130" />
          <path d="M0 190 C 150 190, 150 250, 300 250 S 450 190, 600 190" />
        </svg>
      </div>
      <div className="ho-empty-inner">
        <div className="ho-empty-eyebrow"><Icon name="moon" size={13} />夜链 · 空夜</div>
        <h3 className="ho-empty-title">昨夜还没有可以交给你的东西。</h3>
        <p className="ho-empty-body">
          团队是在你持续学习之后，才开始为你做夜间复盘的 —— 今晚，它会第一次为你准备。
          现在不必着急，先从一件小事起头就好。
        </p>
        <div className="ho-empty-cta">
          <Btn variant="primary" icon="layers" onClick={() => go("practice")}>先做第一道题</Btn>
          <Btn variant="secondary" icon="record" onClick={() => go("record")}>先录入材料</Btn>
        </div>
        <div className="ho-empty-future">
          <div className="ho-empty-future-lbl"><Icon name="sparkle" size={13} />这里日后会出现</div>
          <div className="ho-ghosts">
            <div className="ho-ghost"><span className="ho-ghost-ic"><Icon name="review" size={15} /></span><span className="ho-ghost-txt"><b>昨夜重排了什么</b> —— 连同为什么把它提到了前面</span></div>
            <div className="ho-ghost"><span className="ho-ghost-ic"><Icon name="layers" size={15} /></span><span className="ho-ghost-txt"><b>为你弱点备了哪些题</b> —— 梯度刚好接住你</span></div>
            <div className="ho-ghost"><span className="ho-ghost-ic"><Icon name="knowledge" size={15} /></span><span className="ho-ghost-txt"><b>图谱改了哪条边</b> —— 一条提议，留下或撤掉都行</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 加载态 (正在准备) ──
function HandoffLoading() {
  return (
    <React.Fragment>
      <div className="ho-loading-banner">
        <span className="ho-loading-spin" />
        夜链仍在运行 · 正在复盘昨夜的作答，交班缕马上就好。
        <span className="ho-loading-prog">dreaming · 2 / 4 就绪</span>
      </div>
      <div className="ho-list">
        {[0, 1].map((i) => (
          <div key={i} className="ho-card"><div className="ho-row">
            <div className="sk" style={{ width: 34, height: 34, borderRadius: "var(--r-2)", flex: "none" }} />
            <div style={{ flex: 1 }}>
              <div className="sk" style={{ width: "30%", height: 12, marginBottom: 10 }} />
              <div className="sk" style={{ width: "70%", height: 16, marginBottom: 8 }} />
              <div className="sk" style={{ width: "90%", height: 12 }} />
            </div>
          </div></div>
        ))}
      </div>
    </React.Fragment>
  );
}

// ── HandoffThread · parent (resolves take · timing · states) ──
function HandoffThread({ go, ds = "ok", style = "list", narrateTiming = "manual" }) {
  const all = HANDOFF.threads;
  // narrative default seed: auto → milestone entries open; else closed
  const seed = React.useCallback(
    () => Object.fromEntries(all.map((t) => [t.id, narrateTiming === "auto" && t.milestone])),
    [narrateTiming]
  );
  const [narrMap, setNarrMap] = React.useState(seed);
  const [dismissed, setDismissed] = React.useState({});
  React.useEffect(() => { setNarrMap(seed()); }, [narrateTiming]);

  const setNarr = (id, v) => setNarrMap((m) => ({ ...m, [id]: v }));
  const allOpen = all.every((t) => narrMap[t.id]);
  const flipAll = () => { const v = !allOpen; setNarrMap(Object.fromEntries(all.map((t) => [t.id, v]))); };

  // header — shared across ok/loading/error (hidden for empty, which is self-contained)
  const Header = (extra) => (
    <div className="ho-head">
      <div className="ho-head-main">
        <div className="ho-eyebrow">
          <Icon name="moon" size={13} className="moon-ic" />
          <span className="ho-eyebrow-txt">夜链 · <b>{HANDOFF.run.label.split(" · ")[1] || "dreaming"}</b> · {HANDOFF.run.finished} · 复盘 {HANDOFF.run.events} 个 event · <b className="mono">${HANDOFF.run.cost.toFixed(3)}</b></span>
        </div>
        <h3 className="ho-title">昨夜，团队为你想了这些。</h3>
        <p className="ho-lede">你不在的时候，它复盘了进度、重排了计划、备了专攻你弱点的题 —— 每条都附了为什么，你随时改方向盘。</p>
      </div>
      {narrateTiming === "both" && (
        <div className="ho-head-end">
          <div className="ho-narrtoggle" role="group" aria-label="叙事程度">
            <button className={allOpen ? "" : "on"} onClick={() => !allOpen || flipAll()}>轻</button>
            <button className={allOpen ? "on" : ""} onClick={() => allOpen || flipAll()}>叙事</button>
          </div>
        </div>
      )}
    </div>
  );

  if (ds === "empty") {
    return <div className="handoff"><HandoffEmpty go={go} /></div>;
  }
  if (ds === "loading") {
    return <div className="handoff">{Header()}<HandoffLoading /></div>;
  }

  // error → 降级: render the part that completed (first 2), honestly flag the rest
  const list = ds === "error" ? all.slice(0, 2) : all;
  const missing = ds === "error" ? all.length - 2 : 0;

  const renderEntry = (th) => {
    const props = {
      th: { ...th, onDismiss: () => setDismissed((d) => ({ ...d, [th.id]: 1 })) },
      go,
      narrOpen: !!narrMap[th.id],
      setNarrOpen: (v) => setNarr(th.id, v),
      narratable: !!th.narrative,
      dismissed: !!dismissed[th.id],
      onUndo: () => setDismissed((d) => { const n = { ...d }; delete n[th.id]; return n; }),
    };
    return style === "ribbon"
      ? <HandoffNode key={th.id} {...props} />
      : <HandoffCard key={th.id} {...props} />;
  };

  return (
    <div className="handoff">
      {Header()}
      {ds === "error" && (
        <div className="ho-degrade-banner">
          <Icon name="alert" size={18} />
          <div className="ho-degrade-txt">
            <b>昨夜的复盘没跑完。</b>下面是已经准备好的部分 —— 没生成的那几条不会凭空消失，今晚会重试。
          </div>
        </div>
      )}

      {style === "ribbon" ? (
        <div className="ho-ribbon">
          <div className="ho-ribbon-spine" aria-hidden="true">
            <svg viewBox="0 0 12 100" preserveAspectRatio="none">
              <path className="wstrand" style={{ opacity: 0.85 }} d="M6 0 C 1 12, 11 24, 6 36 S 1 60, 6 72 S 11 90, 6 100" />
              <path className="wstrand" style={{ opacity: 0.5 }} d="M6 0 C 11 12, 1 24, 6 36 S 11 60, 6 72 S 1 90, 6 100" />
            </svg>
          </div>
          <div className="ho-ribbon-open">
            <div className="ho-rb-greet">你不在的这几个钟头，它一直在转。</div>
            <p className="ho-rb-sub">从昨夜 02:40 到今晨 03:14，团队顺着你这周的作答，一件件理了下来 ——</p>
          </div>
          {list.map(renderEntry)}
          {ds === "error" && missing > 0 && (
            <div className="ho-degrade-miss"><Icon name="clock" size={14} />另有 {missing} 缕因 dreaming job 中断未生成 · 今晚会重试。</div>
          )}
          <div className="ho-ribbon-close">
            <div className="ho-rb-welcome"><span className="ho-node-dot" style={{ position: "static" }} />欢迎回来，{DATA.user.name}。方向盘在你手里。</div>
          </div>
        </div>
      ) : (
        <div className="ho-list">
          {list.map(renderEntry)}
          {ds === "error" && missing > 0 && (
            <div className="ho-degrade-miss"><Icon name="clock" size={14} />另有 {missing} 缕因 dreaming job 中断未生成 · 今晚会重试。</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Layer ③ · 次级副歌折叠 (策展≠隐藏) ──
function EncoreFold({ children, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={"encore-fold" + (open ? " open" : "")}>
      <button className="encore-bar" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="ec-ic"><Icon name="layers" size={17} /></span>
        <span>
          全部进行中与待裁决
          <span className="ec-sub">{open ? "收起 —— 上面三缕是策展，这里是全貌" : "展开会话 · AI 改动 · 提议收件箱 · AI 观察 —— 全量永远可下钻"}</span>
        </span>
        <Icon name="chevronDown" size={18} className="ec-chev" />
      </button>
      {open && <div className="encore-body">{children}</div>}
    </div>
  );
}

// ── Layer ④ · 完成度收尾锚 ──
function ClosingAnchor({ go }) {
  const steps = [
    { label: "复习队列", done: false, icon: "review" },
    { label: "专攻练习", done: false, icon: "layers" },
    { label: "录入材料", done: true, icon: "record" },
  ];
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);
  return (
    <div className="closing-anchor">
      <div className="ca-ring"><Ring percent={pct} /></div>
      <div className="ca-main">
        <h3 className="ca-title">今天，你走了三分之一。</h3>
        <p className="ca-line">不用一次走完 —— 把今天最前那缕「之」收掉，就已经赢过昨天。剩下的，明早团队还会替你记着。</p>
        <div className="ca-steps">
          {steps.map((s) => (
            <span key={s.label} className={"ca-step" + (s.done ? " done" : "")}>
              <span className="ca-dot"><Icon name={s.done ? "check" : s.icon} size={12} /></span>{s.label}
            </span>
          ))}
        </div>
      </div>
      <Btn variant="primary" icon="review" onClick={() => go("review")}>继续今天</Btn>
    </div>
  );
}

Object.assign(window, { MasteryBand, HandoffThread, EncoreFold, ClosingAnchor });
