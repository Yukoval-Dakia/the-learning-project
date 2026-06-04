// Loom · Inbox (AI 提议裁决) + Mistakes (错题归因) — round-2a. Contract §3H / §3E.

/* ───────────────────────── Inbox ───────────────────────── */
function EvidenceLink({ ev, go }) {
  return (
    <button className="evidence-link mono" title={"来源 " + ev.type} onClick={() => go("events")}>
      <Icon name="link" size={12} />→ {ev.type}:{ev.id} · {ev.label}
    </button>
  );
}

function ProposalCard({ p, go, onResolve }) {
  const [resolved, setResolved] = React.useState(null);
  const meta = KIND_META[p.kind] || { label: p.kind, tone: "neutral" };
  const act = (label) => { setResolved(label); onResolve && onResolve(p.id, label); };
  const edgeActions = ["接受", "改方向", "改关系", "忽略"];
  const mergeActions = ["接受合并", "忽略"];
  const baseActions = ["接受", "忽略"];
  const actions = p.kind === "knowledge_edge" ? edgeActions : p.kind === "block_merge" ? mergeActions : baseActions;

  return (
    <Card pad className={"proposal" + (resolved ? " resolved" : "")}>
      <div className="proposal-head">
        <span className={"kind-tag tone-chip-" + meta.tone}><Icon name={meta.icon} size={12} />{meta.label}</span>
        <span className="ai-tag"><Icon name="sparkle" size={12} />AI · {p.from}</span>
        <span className="proposal-title">{p.title}</span>
        <span className="resolved-stamp badge tone-good"><Icon name="check" size={12} />{resolved}</span>
      </div>

      <div className="proposal-body">{p.body}</div>

      {/* kind-specific preview */}
      {p.kind === "knowledge_edge" && p.edge && (
        <div className="edge-preview nowrap-meta">
          <span className="rel-pill">{REL_LABEL[p.edge.rel]}</span>
          <span className="chip chip-k mono">{p.edge.a}</span>
          <Icon name="arrow" size={14} />
          <span className="chip chip-k mono">{p.edge.b}</span>
        </div>
      )}
      {p.kind === "block_merge" && p.merge && (
        <div className="merge-preview">
          <div className="merge-block">
            <div className="merge-label mono">primary · {p.merge.primary.id}</div>
            <div className="merge-text wenyan">{p.merge.primary.text}</div>
          </div>
          <div className="merge-join"><Icon name="merge" size={16} /></div>
          <div className="merge-block merge-into">
            <div className="merge-label mono">并入 · {p.merge.into.id}</div>
            <div className="merge-text wenyan">{p.merge.into.text}</div>
          </div>
          <div className="merge-reason"><Icon name="link" size={12} />连续性：{p.merge.reason}</div>
        </div>
      )}

      <div className="proposal-foot">
        <div className="proposal-actions" style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          {actions.map((a, i) => (
            <Btn key={a} size="sm" variant={i === 0 ? "good" : "ghost"}
              icon={i === 0 ? "check" : a === "忽略" ? "close" : a === "改方向" ? "reverse" : a === "改关系" ? "refresh" : null}
              onClick={() => act(a)}>{a}</Btn>
          ))}
        </div>
        <div className="meta-row">
          <div className="conf-bar"><span className="meta">置信</span>
            <div className="conf-track"><span style={{ width: (p.confidence * 100) + "%" }} /></div>
            <span className="meta tnum">{Math.round(p.confidence * 100)}%</span>
          </div>
          <span className="meta">{p.cost}</span>
        </div>
      </div>

      <div className="proposal-evidence"><EvidenceLink ev={p.evidence} go={go} /></div>
    </Card>
  );
}

function ScreenInbox({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [resolved, setResolved] = React.useState({});
  const [evFilter, setEvFilter] = React.useState(null);
  const all = DATA.proposals;
  const resolveOne = (id) => setResolved((r) => ({ ...r, [id]: 1 }));

  // distinct evidence records for the filter
  const evRecords = [...new Map(all.map((p) => [p.evidence.id, p.evidence])).values()];
  const shown = evFilter ? all.filter((p) => p.evidence.id === evFilter) : all;
  const remaining = shown.filter((p) => !resolved[p.id]).length;

  // group shown by kind
  const lanes = {};
  shown.forEach((p) => { (lanes[p.kind] = lanes[p.kind] || []).push(p); });

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">INBOX · AI 提议 · ADR-0010 mesh</div>
        <div className="page-head-row">
          <h1 className="page-title serif">收件箱</h1>
        </div>
        <p className="page-lead">每条 AI 提议都附证据回链，逐条 accept / dismiss。每次裁决写入一条 action 事件，下次不再露面。</p>
      </div>

      {/* summary + evidence filter */}
      <Card pad sunk style={{ marginBottom: "var(--s-5)" }}>
        <div className="inbox-summary-row nowrap-meta">
          <span className="card-icon accent"><Icon name="sparkle" size={18} /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{remaining} 条待裁决{evFilter ? " · 已过滤" : ""}</div>
            <div className="meta">9 待审 = block_merge 2 · knowledge_edge 3 · note_update 4 · 累计 $0.077</div>
          </div>
        </div>
        <div className="evidence-filter">
          <span className="meta">按证据过滤</span>
          <button className={"chip" + (!evFilter ? " is-on" : "")} onClick={() => setEvFilter(null)}>全部</button>
          {evRecords.map((ev) => (
            <button key={ev.id} className={"chip" + (evFilter === ev.id ? " is-on" : "")} onClick={() => setEvFilter(ev.id)}>
              <Icon name="link" size={11} />{ev.id}
            </button>
          ))}
        </div>
      </Card>

      <Stateful state={ds} onRetry={() => {}} errorText="提议加载失败。"
        skeleton={<><SectionLabel>加载中</SectionLabel><Card pad><SkLines rows={3} /></Card></>}
        empty={<EmptyState icon="checkCircle" title="收件箱已清空" text="所有提议都已裁决。新提议会在下次 Dreaming session 后出现。" />}>
        {remaining === 0 ? (
          <EmptyState icon="checkCircle" title="收件箱已清空" text="所有提议都已裁决。新提议会在下次 Dreaming session 后出现。"
            action={<Btn variant="secondary" size="sm" icon="mistakes" onClick={() => go("mistakes")}>去看错题本</Btn>} />
        ) : (
          Object.keys(lanes).map((kind) => {
            const meta = KIND_META[kind] || { label: kind, icon: "inbox", tone: "neutral" };
            const live = lanes[kind].filter((p) => !resolved[p.id]).length;
            return (
              <div key={kind}>
                <SectionLabel count={live || null}>
                  <span className="inbox-lane-label"><span className={"lane-ic tone-" + meta.tone}><Icon name={meta.icon} size={14} /></span>{meta.label}</span>
                </SectionLabel>
                <div className="grid stagger" style={{ gap: "var(--s-4)" }}>
                  {lanes[kind].map((p) => <ProposalCard key={p.id} p={p} go={go} onResolve={resolveOne} />)}
                </div>
              </div>
            );
          })
        )}
      </Stateful>
    </div>
  );
}

/* ───────────────────────── Mistakes ───────────────────────── */
function AttributionBadge({ at }) {
  if (at.pending) return <span className="badge tone-hard attr-badge"><Icon name="refresh" size={12} className="spin" />归因中…</span>;
  if (at.by === "ai") return <span className="badge tone-info attr-badge"><Icon name="sparkle" size={12} />AI 归因 · {at.cause}{at.confidence ? ` (${Math.round(at.confidence * 100)}%)` : ""}</span>;
  return <span className="badge tone-good attr-badge"><Icon name="today" size={12} />用户归因 · {at.cause}</span>;
}

function MistakeCard({ m, go }) {
  const [open, setOpen] = React.useState(false);
  const stateTone = m.state === "已纠正" ? "good" : m.state === "归因中…" ? "hard" : "neutral";
  return (
    <Card pad className="mistake-card-v2">
      <div className="mistake-top">
        <div className="mistake-q wenyan">{m.q}</div>
        <span className={"badge tone-" + stateTone + " state-badge"}>
          {m.state === "已纠正" && <Icon name="check" size={12} />}{m.state}
        </span>
      </div>
      <div className="mistake-cmp">
        <span><span className="cmp-label">误</span><span className="cmp-wrong">{m.wrong}</span></span>
        <span><span className="cmp-label">正</span><span className="cmp-right">{m.right}</span></span>
      </div>
      <div className="mistake-meta-row">
        <div className="kp-badges">
          {m.knowledge.map((k) => (
            <button key={k.tag} className="chip chip-k mono kp-chip" onClick={() => go("knowledge")} title="跳到知识图">{k.label}</button>
          ))}
        </div>
        <AttributionBadge at={m.attribution} />
      </div>
      <div className="mistake-foot">
        <button className="expander" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "arrowL" : "arrow"} size={13} style={{ transform: open ? "rotate(90deg)" : "rotate(90deg)" }} />
          事件链 · {m.events.length}
        </button>
        <button className="evidence-link mono" onClick={() => go("events")} title="完整事件页（round-2b）">
          <Icon name="link" size={12} />→ events:{m.eventId}
        </button>
      </div>
      {open && (
        <div className="event-chain fade-key">
          {m.events.map((e, i) => (
            <div key={i} className="event-row">
              <span className="event-rail"><span className="event-dot" />{i < m.events.length - 1 && <span className="event-line" />}</span>
              <div className="event-body">
                <div className="event-head nowrap-meta"><span className="mono event-label">{e.label}</span><span className="meta">{e.t}</span></div>
                <div className="event-note">{e.note}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ScreenMistakes({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const pending = DATA.mistakes.filter((m) => m.attribution.pending).length;
  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">MISTAKES · 错题归因 · 最近 {DATA.mistakes.length} 条 · 归因中 {pending}</div>
        <div className="page-head-row">
          <h1 className="page-title serif">错题本</h1>
          <div className="hero-cta">
            <Btn variant="ghost" size="sm" icon="record" onClick={() => go("record")}>录新错题</Btn>
            <Btn variant="primary" size="sm" icon="review" onClick={() => go("review")}>重练薄弱点</Btn>
          </div>
        </div>
        <p className="page-lead">每条错题是一条 event-sourced 记录：题面 / 错答 / 知识点 / 归因（AI vs 人）/ 纠错状态，展开看 caused_by 事件链。</p>
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="错题加载失败。"
        skeleton={<div className="grid" style={{ gap: "var(--s-3)" }}>{[1,2,3].map((i) => <Card key={i} pad><SkLines rows={1} /></Card>)}</div>}
        empty={<EmptyState icon="mistakes" title="还没有错题" text="复习答错或手动录入后，错题会聚到这里并自动归因。"
          action={<Btn variant="primary" size="sm" icon="record" onClick={() => go("record")}>+ 录新错题</Btn>} />}>
        <div className="grid stagger" style={{ gap: "var(--s-3)" }}>
          {DATA.mistakes.map((m) => <MistakeCard key={m.id} m={m} go={go} />)}
        </div>
      </Stateful>
    </div>
  );
}

window.ScreenInbox = ScreenInbox;
window.ScreenMistakes = ScreenMistakes;
