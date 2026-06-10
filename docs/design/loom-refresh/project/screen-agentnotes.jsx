// Loom · "AI 观察" — agent-to-agent notes.
//   • AgentNotesBoard — compact, read-only block on /today (collapsible).
//   • ScreenAgentNotes — the 二级 full-screen view, reached via the block's
//     「看全部」entry (drill-in route "agent-notes", no global nav added —
//     same pattern as /events, /learning-sessions).
// AI tasks leave observation signals for each other; the user only spectates —
// NO accept/dismiss (that's the inbox proposal card's job).

const AN_LS_OPEN = "loom-annotes-open";   // collapse state
const AN_LS_READ = "loom-annotes-read";   // locally-read note ids (no backend write)

// shared local read-state (the only stateful interaction — purely visual).
function useAgentReads() {
  const [read, setRead] = React.useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(AN_LS_READ) || "[]")); }
    catch { return new Set(); }
  });
  const isUnread = (n) => n.fresh && !read.has(n.id);
  const markAllRead = (notes) => {
    const next = new Set(read); notes.forEach((n) => next.add(n.id));
    setRead(next); localStorage.setItem(AN_LS_READ, JSON.stringify([...next]));
  };
  return { isUnread, markAllRead };
}

// light inline markdown: **bold** and `code` only (notes are 1–2 sentences).
function anInlineMd(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<b key={k++}>{tok.slice(2, -2)}</b>);
    else out.push(<code key={k++} className="an-code">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function AgentNote({ n, unread, go }) {
  const sig = SIGNAL_META[n.signal] || { label: n.signal, tone: "neutral" };
  const from = AGENT_META[n.from] || { label: n.from, icon: "sparkle" };
  const tos = n.to.map((id) => AGENT_META[id] || { label: id, icon: "sparkle" });
  return (
    <div className="an-note" data-unread={unread ? "1" : "0"}>
      <div className="an-rail">
        <span className={"an-avatar tone-" + sig.tone} title={from.label}>
          <Icon name={from.icon} size={16} />
        </span>
      </div>
      <div className="an-main">
        <div className="an-route">
          <span className="an-ag an-from"><Icon name={from.icon} size={13} />{from.label}</span>
          <Icon name="arrow" size={13} className="an-flow" />
          <span className="an-ag an-to">
            {tos.map((t, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="an-to-sep">·</span>}
                <Icon name={t.icon} size={13} />{t.label}
              </React.Fragment>
            ))}
          </span>
          {unread && <span className="an-new">新</span>}
          <span className={"an-sig tone-chip-" + sig.tone}>{sig.label}</span>
        </div>

        <div className="an-body">{anInlineMd(n.body)}</div>

        <div className="an-meta">
          {n.confidence != null && (
            <span className="an-conf"><Icon name="sparkle" size={11} />置信 {Math.round(n.confidence * 100)}%</span>
          )}
          <span className="an-time">{n.when}</span>
          <button className="an-evi" onClick={() => go && go("events/" + n.evidence.id)}>
            <Icon name="link" size={12} />{n.evidence.id} →
          </button>
          {n.ttl && (n.ttl.soon
            ? <span className="an-expire"><Icon name="clock" size={11} />临期 · {n.ttl.text}</span>
            : <span className="an-ttl">· {n.ttl.text}</span>)}
        </div>
      </div>
    </div>
  );
}

/* ───────────── compact block (Today) ───────────── */
function AgentNotesBoard({ go, state = "ok", onRetry }) {
  const notes = DATA.agentNotes || [];
  const [open, setOpen] = React.useState(() => localStorage.getItem(AN_LS_OPEN) === "1");
  const { isUnread, markAllRead } = useAgentReads();

  const toggle = () => setOpen((o) => { const v = !o; localStorage.setItem(AN_LS_OPEN, v ? "1" : "0"); return v; });
  const unreadCount = notes.filter(isUnread).length;

  // Empty — a single faint line, no section label, no card. Must not occupy 版面.
  if (state === "empty" || notes.length === 0) {
    return <div className="an-empty"><Icon name="eye" size={13} />暂时没有 AI 间的观察信号。</div>;
  }

  const latest = notes[0];
  const latestFrom = AGENT_META[latest.from] || { label: latest.from };
  const latestTo = AGENT_META[latest.to[0]] || { label: latest.to[0] };
  const latestSig = SIGNAL_META[latest.signal] || { label: latest.signal };

  return (
    <React.Fragment>
      <SectionLabel count={notes.length + " 条"}>AI 观察</SectionLabel>
      <Card pad className={"an-board" + (open ? " is-open" : "")}>
        <div className="an-head">
          <button className="an-head-toggle" aria-expanded={open} onClick={toggle}>
            <span className="card-icon"><Icon name="eye" size={18} /></span>
            <span className="an-head-titles">
              <span className="card-title">AI 之间的观察</span>
              <span className="an-sub">agent 互留的协作信号 · 无需你裁决</span>
            </span>
          </button>
          <span className="an-head-spacer" />
          {unreadCount > 0 && <Badge tone="coral" dot pulse>{unreadCount} 新</Badge>}
          {/* entry → 二级全屏界面 */}
          <button className="an-open-full" onClick={() => go && go("agent-notes")}>
            看全部<Icon name="arrow" size={14} />
          </button>
          <button className="an-chev-btn" aria-label={open ? "收起" : "展开"} onClick={toggle}>
            <Icon name="chevronDown" size={18} className="an-chev" />
          </button>
        </div>

        {state === "loading" ? <SkLines rows={2} />
          : state === "error" ? <ErrorState text="无法读取 agent 观察信号。" onRetry={onRetry} compact />
          : open ? (
            <React.Fragment>
              <div className="an-feed">
                {notes.slice(0, 3).map((n) => <AgentNote key={n.id} n={n} unread={isUnread(n)} go={go} />)}
              </div>
              <div className="an-foot">
                <span className="meta">只读旁观 · 过期信号自动消失</span>
                {notes.length > 3 && (
                  <button className="an-foot-link" onClick={() => go && go("agent-notes")}>
                    还有 {notes.length - 3} 条 · 看全部<Icon name="arrow" size={13} />
                  </button>
                )}
                {unreadCount > 0 && (
                  <Btn size="sm" variant="ghost" icon="check" onClick={() => markAllRead(notes)}>全部已读</Btn>
                )}
              </div>
            </React.Fragment>
          ) : (
            <div className="an-peek" onClick={toggle} role="button" tabIndex={0}>
              <Icon name="dots" size={14} className="meta" />
              <span className="an-peek-txt">
                <b>{latestFrom.label}</b> → {latestTo.label}
                {latest.to.length > 1 ? " 等" : ""} 提到「{latestSig.label}」
              </span>
              <span className="meta">· {latest.when}</span>
            </div>
          )}
      </Card>
    </React.Fragment>
  );
}

/* ───────────── 二级全屏界面 (drill-in route "agent-notes") ───────────── */
function ScreenAgentNotes({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const all = DATA.agentNotes || [];
  const { isUnread, markAllRead } = useAgentReads();
  const [filter, setFilter] = React.useState("all");

  const counts = {};
  all.forEach((n) => { counts[n.signal] = (counts[n.signal] || 0) + 1; });
  const signalOrder = Object.keys(SIGNAL_META).filter((k) => counts[k]);
  const notes = filter === "all" ? all : all.filter((n) => n.signal === filter);
  const unreadCount = all.filter(isUnread).length;
  const agentsActive = [...new Set(all.flatMap((n) => [n.from, ...n.to]))];

  // group newest-first by relative day
  const dayOf = (w) => (w.includes("前天") ? "前天" : w.includes("昨天") ? "昨天" : "今天");
  const groups = [];
  notes.forEach((n) => {
    const d = dayOf(n.when);
    let g = groups.find((x) => x.label === d);
    if (!g) { g = { label: d, items: [] }; groups.push(g); }
    g.items.push(n);
  });

  return (
    <div className="page view">
      <button className="back-link" onClick={() => go("today")}><Icon name="arrowL" size={14} />今日</button>
      <div className="page-head">
        <div className="eyebrow"><span className="dot-sep">●</span>OBSERVE · agent_note · events subject_kind='agent_note'</div>
        <h1 className="page-title serif">AI 之间的观察</h1>
        <p className="page-lead">各 AI task 给彼此留的观察信号：谁发现了什么、想让谁去补。你只读旁观，无需裁决；过期信号会自动消失。</p>
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="无法读取 agent 观察信号。"
        skeleton={<Card pad><SkLines rows={4} /></Card>}
        empty={<EmptyState icon="eye" title="暂无观察信号" text="AI 们目前没有互留新的观察。新的信号会在夜间推理与日常运行后出现。" future="即将接入：对话 agent 误解检测 · 录入 agent 切题反复" />}>

        <Card pad className="an-overview">
          <div className="an-ov-top">
            <div className="an-ov-stat">
              <span className="an-ov-n serif tnum">{all.length}</span>
              <span className="an-ov-lab">活跃信号<span className="meta"> · 涉及 {agentsActive.length} 个 agent · 只读</span></span>
            </div>
            {unreadCount > 0 && <Btn size="sm" variant="ghost" icon="check" onClick={() => markAllRead(all)}>全部标为已读（{unreadCount}）</Btn>}
          </div>
          <div className="an-filterbar">
            <button className={"an-fchip" + (filter === "all" ? " is-on" : "")} onClick={() => setFilter("all")}>
              全部 <b className="mono">{all.length}</b>
            </button>
            {signalOrder.map((k) => {
              const m = SIGNAL_META[k];
              return (
                <button key={k} className={"an-fchip" + (filter === k ? " is-on" : "")} onClick={() => setFilter(filter === k ? "all" : k)}>
                  <span className="an-fdot" style={{ background: `var(--${m.tone})` }} />{m.label} <b className="mono">{counts[k]}</b>
                </button>
              );
            })}
          </div>
        </Card>

        {groups.map((g) => (
          <React.Fragment key={g.label}>
            <SectionLabel count={g.items.length + " 条"}>{g.label}</SectionLabel>
            <Card pad>
              <div className="an-feed">
                {g.items.map((n) => <AgentNote key={n.id} n={n} unread={isUnread(n)} go={go} />)}
              </div>
            </Card>
          </React.Fragment>
        ))}
        {notes.length === 0 && <div className="an-empty"><Icon name="eye" size={13} />该类型下暂无信号。</div>}
      </Stateful>
    </div>
  );
}

window.AgentNotesBoard = AgentNotesBoard;
window.ScreenAgentNotes = ScreenAgentNotes;
