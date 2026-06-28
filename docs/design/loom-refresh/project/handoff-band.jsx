// Loom · 晨间交班叙事缕 (refresh) — 段2「后叙事」可复用 band 模块。
// 单一真源：被 晨间交班缕.html(standalone) 与 Loom.html(/today) 共用。
// 导出到 window: HandoffBand · MergeCard · MinorFold · useToast。
// 依赖(全局)：DATA · HANDOFF2 · HO2_BANDS · HO2_CAT · Icon/Btn/Card/Badge(components.jsx)。
//
// 硬契约(烤进组件)：mastery 三态(档条/方向/织线)一律无裸数字 + 区间 + 来源二态 + 低置信；
// 备课 conjecture 只给「几道」(无 predicted_p)；提议=软(待裁决) 与 改动=既成(可回滚) 二态可分。

const { useState: hbUseState, useEffect: hbUseEffect, useCallback: hbUseCallback } = React;

// 轻量 toast — 下钻是入口, standalone 用它回执「→ 归宿」(/today 用真路由 go)。
function useToast() {
  const [msg, setMsg] = hbUseState(null);
  const fire = hbUseCallback((m) => { setMsg(m); }, []);
  hbUseEffect(() => { if (!msg) return; const id = setTimeout(() => setMsg(null), 1800); return () => clearTimeout(id); }, [msg]);
  const node = msg ? (
    <div style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 60,
      background: "var(--ink)", color: "var(--paper)", padding: "10px 16px", borderRadius: "var(--r-pill)",
      font: "500 var(--fs-caption)/1 var(--font-sans)", boxShadow: "var(--shadow-3)", display: "flex", alignItems: "center", gap: 8 }}>
      <Icon name="arrow" size={14} />下钻 · {msg}
    </div>
  ) : null;
  return [fire, node];
}

// 依据 event 的可追溯码 (确定性合成, 仅展示认识论透明)
function hbTraceEvents(id) {
  let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ["e_" + (3100 + (h % 880)), "e_" + (3100 + ((h * 7) % 880))];
}

const HO2_DIR = { up: { cls: "up", arr: "↑", word: "在升" }, flat: { cls: "flat", arr: "→", word: "持平" }, down: { cls: "down", arr: "↓", word: "回落" } };

/* ════════════════════ mastery viz · 三态 (无裸数字 · 区间 · 来源二态) ════════════════════ */
function MasteryViz({ m, style }) {
  const bands = HO2_BANDS;
  const soft = m.source === "soft";
  const srcCls = soft ? "is-soft" : "is-hard";
  const Top = (
    <div className="mv-top">
      <span className="mv-node">{m.node}</span>
      <span className="mv-src"><span className="mv-src-dot" />{soft ? "软轨 · 先验" : "硬轨 · 校准"}</span>
      {m.lowConf && <span className="mv-low">低置信</span>}
    </div>
  );

  if (style === "方向") {
    const d = HO2_DIR[m.dir] || HO2_DIR.flat;
    return (
      <div className={"mv mv-dir " + srcCls} role="img"
        aria-label={`${m.node}：当前${bands[m.band]}，区间${bands[m.lo]}–${bands[m.hi]}，方向${d.word}，${soft ? "软轨先验" : "硬轨校准"}${m.lowConf ? "，低置信" : ""}`}>
        {Top}
        <div className="mv-dirrow">
          <span className="mv-chip">{bands[m.band]}</span>
          <span className={"mv-dir-glyph " + d.cls}><span className="arr">{d.arr}</span>{d.word}</span>
          <span className="mv-range">落在 <b>{bands[m.lo]}–{bands[m.hi]}</b> 之间 · 精确画像在详情页</span>
        </div>
      </div>
    );
  }

  if (style === "织线") {
    const rows = [46, 34, 22, 10]; // 萌芽(下)→精熟(上)
    const yTop = rows[m.hi], yBot = rows[m.lo];
    const wave = (y) => `M5 ${y} q 8 -4 16 0 t 16 0 t 16 0 t 16 0`;
    return (
      <div className={"mv mv-weave " + srcCls} role="img"
        aria-label={`${m.node}：当前${bands[m.band]}，区间${bands[m.lo]}–${bands[m.hi]}，${soft ? "软轨先验" : "硬轨校准"}${m.lowConf ? "，低置信" : ""}`}>
        {Top}
        <div className="mv-weave-row">
          <div className="mv-loom">
            <svg width="80" height="56" viewBox="0 0 80 56">
              <rect className="band-fill" x="2" y={yTop - 5} width="76" height={(yBot - yTop) + 10} rx="6" />
              {rows.map((y, i) => (
                <path key={i} className={"strand " + (i <= m.band ? "on" : "off")} d={wave(y)}
                  strokeWidth={i === m.band ? 3 : i <= m.band ? 2.3 : 1.4} />
              ))}
            </svg>
          </div>
          <div className="mv-weave-meta">
            <span className="mv-weave-band">{bands[m.band]}</span>
            <span className="mv-weave-sub">织实到「{bands[m.band]}」· 区间 {bands[m.lo]}–{bands[m.hi]}</span>
          </div>
        </div>
      </div>
    );
  }

  // 默认 · 档条 (discrete band track + interval + point)
  const segW = 100 / bands.length;
  const loX = m.lo * segW, hiX = (m.hi + 1) * segW, pointX = (m.band + 0.5) * segW;
  return (
    <div className={"mv mv-band " + srcCls} role="img"
      aria-label={`${m.node}：当前${bands[m.band]}，区间${bands[m.lo]}–${bands[m.hi]}，${soft ? "软轨先验" : "硬轨校准"}${m.lowConf ? "，低置信" : ""}`}>
      {Top}
      <div className="mv-track">
        {bands.map((b, i) => <span key={i} className="mv-seg" />)}
        <span className="mv-interval" style={{ left: loX + "%", width: (hiX - loX) + "%" }} />
        <span className="mv-point" style={{ left: pointX + "%" }} />
      </div>
      <div className="mv-scale">
        {bands.map((b, i) => <span key={i} className={"mv-tick" + (i === m.band ? " on" : "")}>{b}</span>)}
      </div>
    </div>
  );
}

/* ════════════════════ 共享 entry inner ════════════════════ */
function EntryInner({ it, go, narrOpen, setNarrOpen, masteryStyle }) {
  const [trace, setTrace] = hbUseState(false);
  const ev = hbTraceEvents(it.id);
  return (
    <React.Fragment>
      <div className="hx-gist">{it.gist}</div>
      <div className="hx-reason">{it.reason}</div>
      {it.mastery && <MasteryViz m={it.mastery} style={masteryStyle} />}
      {it.conjectureCount && (
        <div className="mv" style={{ marginTop: "var(--s-2)" }}>
          <span className="hx-cat tone-coral"><Icon name="sparkle" size={13} />{it.conjectureCount} 道 · 待你试做</span>
        </div>
      )}

      {it.narrative && (
        <button className={"hx-narr-toggle" + (narrOpen ? " open" : "")} onClick={() => setNarrOpen(!narrOpen)}>
          <Icon name="chevronRight" size={14} />{narrOpen ? "收起复盘" : "展开我的复盘"}
        </button>
      )}
      {it.narrative && narrOpen && (
        <div className="hx-narr">
          {it.narrative}
          <span className="hx-sig">— {it.agent} · 昨夜为你复盘</span>
        </div>
      )}

      {trace && (
        <div className="hx-trace">
          来自 <b>{it.agent}</b> 姿势 · {it.time} · 依据 event：
          {ev.map((e) => <code key={e} className="evt">{e}</code>)}
        </div>
      )}

      <div className="hx-foot">
        <Btn size="sm" variant={it.proposal || it.change ? "secondary" : "primary"} iconEnd="arrow" onClick={() => go(it.drill.route)}>
          {it.drill.label}
        </Btn>
        <div className="hx-foot-end">
          <button className="hx-link" onClick={() => setTrace((v) => !v)}><Icon name="history" size={14} />追溯</button>
          <button className="hx-link" title="忽略后，编排者下次不再提这类" onClick={it.onDismiss}><Icon name="close" size={14} />忽略</button>
        </div>
      </div>
    </React.Fragment>
  );
}

function MetaRow({ it }) {
  const cat = HO2_CAT[it.cat];
  return (
    <div className="hx-metarow">
      <span className={"hx-cat tone-" + cat.tone}><Icon name={cat.icon} size={13} />{cat.label}</span>
      <span className="hx-attr"><Icon name={it.agent === "coach" ? "target" : "moon"} size={13} />{it.agent}</span>
      {it.proposal && <span className="hx-flag is-pending"><Icon name="inbox" size={13} />软提议 · 待裁决</span>}
      {it.change && <span className="hx-flag"><Icon name="undo" size={13} />可回滚</span>}
      <span className="hx-time">{it.time}</span>
    </div>
  );
}

/* ════════════════════ 缕卡形态 A · 缕带 (ribbon) ════════════════════ */
function RibbonTake({ items, go, narrMap, setNarr, masteryStyle, dismissed, onDismiss, onUndo, missNote }) {
  return (
    <div className="hx-ribbon">
      <div className="hx-spine" aria-hidden="true">
        <svg viewBox="0 0 14 100" preserveAspectRatio="none">
          <path className="s1" d="M7 0 C 1 12, 13 24, 7 36 S 1 60, 7 72 S 13 90, 7 100" />
          <path className="s2" d="M7 0 C 13 12, 1 24, 7 36 S 13 60, 7 72 S 1 90, 7 100" />
        </svg>
      </div>
      <div className="hx-open">
        <p className="hx-open-line">你不在的这几个钟头，我顺着你这周的作答，一件件理了下来——</p>
      </div>
      {items.map((it) => (
        <div key={it.id} className={"hx-node is-" + it.cat + (it.proposal ? " is-proposal" : "") + (it.change ? " is-change" : "") + (dismissed[it.id] ? " is-dismissed" : "")}>
          <span className="hx-node-dot" />
          <div className="hx-node-body">
            {dismissed[it.id] ? (
              <div className="hx-undo" style={{ border: 0, padding: 0, background: "transparent" }}>
                <Icon name="check" size={15} />已忽略「{it.gist}」。
                <button className="hx-link" style={{ marginLeft: "auto" }} onClick={() => onUndo(it.id)}><Icon name="undo" size={14} />撤销</button>
              </div>
            ) : (
              <React.Fragment>
                <MetaRow it={it} />
                <EntryInner it={{ ...it, onDismiss: () => onDismiss(it.id) }} go={go}
                  narrOpen={!!narrMap[it.id]} setNarrOpen={(v) => setNarr(it.id, v)} masteryStyle={masteryStyle} />
              </React.Fragment>
            )}
          </div>
        </div>
      ))}
      {missNote && <div className="hx-miss"><Icon name="clock" size={14} />{missNote}</div>}
      <div className="hx-close">
        <div className="hx-close-line">
          <span className="hx-seal"><Icon name="check" size={13} /></span>
          欢迎回来，{DATA.user.name}。每条都附了为什么；方向盘在你手里。<span style={{ color: "var(--ink-4)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)" }}>— dreaming</span>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════ 缕卡形态 B · 交班帖 (cards) ════════════════════ */
function CardsTake({ items, go, narrMap, setNarr, masteryStyle, dismissed, onDismiss, onUndo, missNote }) {
  return (
    <div className="hx-cards">
      {items.map((it) => {
        const cat = HO2_CAT[it.cat];
        if (dismissed[it.id]) {
          return (
            <div key={it.id} className="hx-undo">
              <Icon name="check" size={15} />已忽略「{it.gist}」· 编排者下次不再提这类。
              <button className="hx-link" style={{ marginLeft: "auto" }} onClick={() => onUndo(it.id)}><Icon name="undo" size={14} />撤销</button>
            </div>
          );
        }
        return (
          <div key={it.id} className={"hx-card is-" + it.cat + (it.proposal ? " is-proposal" : "") + (it.change ? " is-change" : "")}>
            <span className={"hx-ic tone-" + cat.tone}><Icon name={cat.icon} size={18} /></span>
            <div className="hx-card-body">
              <MetaRow it={it} />
              <EntryInner it={{ ...it, onDismiss: () => onDismiss(it.id) }} go={go}
                narrOpen={!!narrMap[it.id]} setNarrOpen={(v) => setNarr(it.id, v)} masteryStyle={masteryStyle} />
            </div>
          </div>
        );
      })}
      {missNote && <div className="hx-miss"><Icon name="clock" size={14} />{missNote}</div>}
    </div>
  );
}

/* ════════════════════ 轻改动折叠 (AI 观察 · refine) ════════════════════ */
function MinorFold({ items, go }) {
  const [open, setOpen] = hbUseState(false);
  if (!items || !items.length) return null;
  return (
    <div className={"hx-minor" + (open ? " open" : "")}>
      <button className="hx-minor-bar" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        另有 {items.length} 项轻改动（AI 观察 · 录入 refine）—— {open ? "收起" : "展开看看"}
        <Icon name="chevronDown" size={16} className="ec-chev" />
      </button>
      {open && (
        <div className="hx-minor-list">
          {items.map((mi) => {
            const cat = HO2_CAT[mi.cat];
            return (
              <div key={mi.id} className={"hx-minor-item" + (mi.change ? " is-change" : "")}>
                <span className="hx-mi-ic"><Icon name={cat.icon} size={15} /></span>
                <div className="hx-mi-body">
                  <div className="hx-mi-gist">{mi.gist}</div>
                  <div className="hx-mi-note">{mi.note} · <span className="mono" style={{ color: "var(--ink-4)" }}>{mi.time}</span></div>
                </div>
                <div className="hx-mi-go"><Btn size="sm" variant="ghost" iconEnd="arrow" onClick={() => go(mi.route)}>{mi.change ? "查看 / 回滚" : "看一眼"}</Btn></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ════════════════════ 状态 · 首日空夜 (预告) ════════════════════ */
function FirstNight({ go }) {
  const d = HANDOFF2.firstNight;
  return (
    <div className="hx-first">
      <div className="hx-first-weave" aria-hidden="true">
        <svg viewBox="0 0 600 240" preserveAspectRatio="none">
          <path d="M0 70 C 150 70, 150 130, 300 130 S 450 70, 600 70" />
          <path d="M0 130 C 150 130, 150 190, 300 190 S 450 130, 600 130" />
          <path d="M0 190 C 150 190, 150 250, 300 250 S 450 190, 600 190" />
        </svg>
      </div>
      <div className="hx-first-inner">
        <div className="hx-eyebrow"><span className="hx-moon"><Icon name="moon" size={13} /></span>{d.eyebrow}</div>
        <h3 className="hx-first-title">{d.title}</h3>
        <p className="hx-first-body">{d.body}</p>
        <div className="hx-first-cta">
          {d.ctas.map((c) => <Btn key={c.label} variant={c.variant} icon={c.icon} onClick={() => go(c.route)}>{c.label}</Btn>)}
        </div>
        <div className="hx-first-foretell">
          <div className="hx-foretell-lbl"><Icon name="sparkle" size={13} />{d.previewLabel}</div>
          <div className="hx-ghosts">
            {d.preview.map((p, i) => (
              <div key={i} className="hx-ghost">
                <span className="hx-ghost-ic"><Icon name={p.icon} size={15} /></span>
                <div><div className="hx-ghost-title">{p.title}</div><div className="hx-ghost-sub">{p.sub}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════ 状态 · 稳态安静夜 (极简) ════════════════════ */
function QuietNight() {
  const d = HANDOFF2.quietNight;
  return (
    <div className="hx-quiet">
      <span className="hx-quiet-moon"><Icon name="moon" size={20} /></span>
      <div className="hx-quiet-main">
        <h3 className="hx-quiet-title">{d.title}</h3>
        <p className="hx-quiet-body">{d.body}</p>
      </div>
      <div className="hx-quiet-foot">{d.foot}</div>
    </div>
  );
}

/* ════════════════════ 状态 · 加载 (正在准备) ════════════════════ */
function HBLoading() {
  const d = HANDOFF2.loading;
  return (
    <React.Fragment>
      <div className="hx-loadbar">
        <span className="hx-spin" />{d.banner}<span className="hx-prog">{d.progress}</span>
      </div>
      <div className="hx-skel">
        {[0, 1].map((i) => (
          <div key={i} className="hx-skel-card">
            <div className="sk" style={{ width: 36, height: 36, borderRadius: "var(--r-2)", flex: "none" }} />
            <div style={{ flex: 1 }}>
              <div className="sk" style={{ width: "28%", height: 12, marginBottom: 10 }} />
              <div className="sk" style={{ width: "68%", height: 16, marginBottom: 8 }} />
              <div className="sk" style={{ width: "88%", height: 12 }} />
            </div>
          </div>
        ))}
      </div>
    </React.Fragment>
  );
}

/* ════════════════════ 状态 · 部分降级 + job 失败 ════════════════════ */
function DegradeHead({ jobFailHonest }) {
  const d = HANDOFF2.degrade;
  return (
    <div className="hx-degrade-banner">
      <Icon name="alert" size={18} />
      <div className="hx-degrade-txt">
        <b>昨夜有一项没跑完。</b>下面是已经备好的部分 —— 缺的那几条不会凭空消失，今晚会重试。
        {jobFailHonest && (
          <div className="hx-jobfail">
            <Icon name="moon" size={13} />job 失败：{d.jobsFailed.map((j) => <code key={j.name} className="evt">{j.name} · {j.reason}</code>)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════ band header ════════════════════ */
function BandHeader({ density, setDensity, showDensity }) {
  const r = HANDOFF2.run;
  return (
    <div className="hx-head">
      <div className="hx-eyebrow">
        <span className="hx-moon"><Icon name="moon" size={13} /></span>
        <span className="hx-eyebrow-txt">夜链 · <b>{r.agent}</b> · 复盘 {r.events} 个 event · <span className="hx-cost mono">${r.cost.toFixed(3)}</span></span>
      </div>
      <div className="hx-since-line">{r.window} · {r.sinceVisit}；缺锚点时首版退化为固定「昨夜」窗</div>
      <h2 className="hx-title">昨夜，<span className="hx-name">我</span>替你做了这些。</h2>
      <p className="hx-lede">你睡着的时候，我复盘了进度、补了题、提了边，还为你备了课 —— 每条都能点开看为什么，也都能改方向或撤掉。</p>
      <svg className="hx-woven" viewBox="0 0 600 26" preserveAspectRatio="none" aria-hidden="true">
        <path className="wv1" d="M0 8 C 150 8, 150 20, 300 20 S 450 8, 600 8" />
        <path className="wv2" d="M0 13 C 150 13, 150 25, 300 25 S 450 13, 600 13" />
        <path className="wv3" d="M0 18 C 150 18, 150 6, 300 6 S 450 18, 600 18" />
      </svg>
      {showDensity && (
        <div className="hx-density" role="group" aria-label="叙事浓度">
          {[["轻", "轻"], ["里程碑", "里程碑"], ["叙事", "全叙事"]].map(([v, label]) => (
            <button key={v} className={density === v ? "on" : ""} onClick={() => setDensity(v)}>{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// 安静夜的极简 header
function BandHeaderQuiet() {
  const r = HANDOFF2.run;
  return (
    <div className="hx-head" style={{ marginBottom: "var(--s-4)" }}>
      <div className="hx-eyebrow">
        <span className="hx-moon"><Icon name="moon" size={13} /></span>
        <span className="hx-eyebrow-txt">夜链 · <b>{r.agent}</b> · 跑过了，没攒出要紧的</span>
      </div>
    </div>
  );
}

// 段2 eyebrow
function SegAfter() {
  return <div className="seg-eyebrow is-after"><span className="seg-no">后</span><span className="seg-txt">昨夜替你做的 · 交班</span><span className="seg-rule" /></div>;
}

/* ════════════════════ HandoffBand · 段2 parent (explicit props · 内置 density) ════════════════════ */
function HandoffBand({ cardStyle = "缕带", masteryStyle = "档条", density: densityProp = "里程碑", state = "ok", jobFailHonest = true, go }) {
  const items = HANDOFF2.items;
  const [density, setDensity] = hbUseState(densityProp);
  hbUseEffect(() => { setDensity(densityProp); }, [densityProp]);

  const seed = hbUseCallback(() => Object.fromEntries(items.map((it) => [it.id,
    density === "叙事" ? true : density === "里程碑" ? !!it.milestone : false])), [density]);
  const [narrMap, setNarrMap] = hbUseState(seed);
  hbUseEffect(() => { setNarrMap(seed()); }, [density]);
  const setNarr = (id, v) => setNarrMap((m) => ({ ...m, [id]: v }));

  const [dismissed, setDismissed] = hbUseState({});
  const onDismiss = (id) => setDismissed((d) => ({ ...d, [id]: 1 }));
  const onUndo = (id) => setDismissed((d) => { const n = { ...d }; delete n[id]; return n; });

  // 非 OK 态 —— 各有面貌
  if (state === "firstNight") return <div className="hx-band"><SegAfter /><FirstNight go={go} /></div>;
  if (state === "quietNight") return <div className="hx-band"><SegAfter /><BandHeaderQuiet /><QuietNight /></div>;
  if (state === "loading") return <div className="hx-band"><SegAfter /><BandHeader density={density} setDensity={setDensity} showDensity={false} /><HBLoading /></div>;

  // OK / degrade
  const degrade = state === "degrade";
  const shown = degrade ? items.slice(0, HANDOFF2.degrade.doneCount) : items;
  const missNote = degrade ? HANDOFF2.degrade.missNote : null;
  const Take = cardStyle === "交班帖" ? CardsTake : RibbonTake;

  return (
    <div className="hx-band">
      <SegAfter />
      <BandHeader density={density} setDensity={setDensity} showDensity={true} />
      {degrade && <DegradeHead jobFailHonest={jobFailHonest} />}
      <Take items={shown} go={go} narrMap={narrMap} setNarr={setNarr} masteryStyle={masteryStyle}
        dismissed={dismissed} onDismiss={onDismiss} onUndo={onUndo} missNote={missNote} />
      {!degrade && <MinorFold items={HANDOFF2.minor} go={go} />}
    </div>
  );
}

// 并入 · 同家族紧凑缕卡 (第三类缕, 嵌进 今日之线)
function MergeCard({ it, go }) {
  const cat = HO2_CAT[it.cat];
  const dir = HO2_DIR[it.mastery && it.mastery.dir] || HO2_DIR.flat;
  return (
    <div className={"hx-merge-card" + (it.proposal ? " is-proposal" : "")} onClick={() => go(it.drill.route)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") go(it.drill.route); }}>
      <div className="hx-merge-top">
        <span className="hx-merge-moon"><Icon name={cat.icon} size={15} /></span>
        <span className="hx-merge-label">{cat.label}</span>
        <Icon name="arrow" size={16} className="hx-merge-arrow" />
      </div>
      <div className="hx-merge-gist">{it.gist}</div>
      <div className="hx-merge-reason">{it.reason}</div>
      {it.mastery && <div style={{ marginTop: 2 }}><span className={"mv-dir-glyph " + dir.cls} style={{ fontSize: "var(--fs-meta)" }}><span className="arr">{dir.arr}</span>{HO2_BANDS[it.mastery.band]} · {it.mastery.source === "soft" ? "软轨" : "硬轨"}{it.mastery.lowConf ? " · 低置信" : ""}</span></div>}
      <div className="hx-merge-cta">{it.drill.label} <Icon name="arrow" size={13} /></div>
    </div>
  );
}

Object.assign(window, { useToast, HandoffBand, MergeCard, MinorFold, HO2_DIR });
