// Loom · Inbox (AI 提议裁决) + Mistakes (错题归因).
// Readable evidence (no raw IDs up front) + 科目 / 类型 / 状态 / 归因 filters.

/* ── shared helpers ──────────────────────────────────────── */
function subjectFromTags(tags) {
  const s = (tags || []).join(" ");
  if (/k_eng/.test(s)) return "eng";
  if (/k_math|k_suanxue/.test(s)) return "math";
  return "yuwen";
}
function mSubject(m) { return m.subject || subjectFromTags((m.knowledge || []).map((k) => k.tag)); }
function propSubject(p) {
  if (p.subject) return p.subject;
  const hay = JSON.stringify(p.edge || "") + (p.body || "") + ((p.evidence && p.evidence.label) || "");
  if (/k_eng|英语|完形/.test(hay)) return "eng";
  if (/k_math|k_suanxue|导数|算/.test(hay)) return "math";
  return "yuwen";
}
function SubjectTag({ subject }) {
  const s = (window.QSUBJECT && QSUBJECT[subject]) || { label: "语文", tone: "coral" };
  return <span className={"qb-subj tone-" + s.tone}>{s.label}</span>;
}

// turn a techy evidence ref into a plain-language line
function evidenceReadable(ev) {
  const parts = (ev.label || "").split("·").map((s) => s.trim());
  const head = parts[0] || "", subj = parts[1] || "";
  if (head.indexOf("attempt") === 0) return { icon: "mistakes", text: subj ? `源自「${subj}」的一次答错` : "源自一次答错" };
  if (head === "ingestion") return { icon: "record", text: subj ? `源自录入《${subj}》` : "源自一次资料录入" };
  if (head === "note") return { icon: "doc", text: subj ? `源自笔记《${subj}》` : "源自一条笔记" };
  if (head === "judge") return { icon: "sparkle", text: "源自一次 AI 判定" };
  return { icon: "link", text: ev.label || "相关事件" };
}
function EvidenceReadable({ ev, go }) {
  const r = evidenceReadable(ev);
  return (
    <button className="evidence-readable" title={"事件 " + ev.type + ":" + ev.id} onClick={() => go("events")}>
      <span className="er-ic"><Icon name={r.icon} size={13} /></span>
      <span className="er-text">{r.text}</span>
      <span className="er-go">查看事件链 →</span>
    </button>
  );
}

// reusable labeled chip-filter row
function FilterRow({ label, value, options, onChange }) {
  return (
    <div className="filter-row">
      <span className="filter-row-l">{label}</span>
      {options.map(([v, l]) => (
        <button key={v} className={"chip" + (value === v ? " is-on" : "")} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

const SUBJECT_OPTS = [["all", "全部"], ["yuwen", "语文"], ["math", "数学"], ["eng", "英语"]];

/* ───────────────────────── Inbox ───────────────────────── */
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
        <SubjectTag subject={propSubject(p)} />
        <span className="ai-tag"><Icon name="sparkle" size={12} />AI · {p.from}</span>
        <span className="proposal-title">{p.title}</span>
        <span className="resolved-stamp badge tone-good"><Icon name="check" size={12} />{resolved}</span>
      </div>

      <div className="proposal-body">{p.body}</div>

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

      <div className="proposal-evidence"><EvidenceReadable ev={p.evidence} go={go} /></div>
    </Card>
  );
}

const TYPE_OPTS = [["all", "全部"], ["knowledge_edge", "知识关系"], ["block_merge", "块合并"], ["note_update", "笔记更新"]];

function ScreenInbox({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [lane, setLane] = React.useState("B");
  const [resolved, setResolved] = React.useState({});
  const [subject, setSubject] = React.useState("all");
  const [type, setType] = React.useState("all");
  const all = DATA.proposals;
  const resolveOne = (id) => setResolved((r) => ({ ...r, [id]: 1 }));

  const shown = all.filter((p) =>
    (subject === "all" || propSubject(p) === subject) &&
    (type === "all" || p.kind === type));
  const remaining = shown.filter((p) => !resolved[p.id]).length;
  const bTotal = all.filter((p) => !resolved[p.id]).length;
  const activeFilters = (subject !== "all") + (type !== "all");

  // readable breakdown by type
  const byKind = {};
  shown.forEach((p) => { byKind[p.kind] = (byKind[p.kind] || 0) + 1; });
  const breakdown = Object.entries(byKind).map(([k, n]) => `${(KIND_META[k] || {}).label || k} ${n}`).join(" · ");
  const cost = shown.reduce((a, p) => a + parseFloat((p.cost || "0").replace("$", "")), 0);

  // group shown by kind
  const lanes = {};
  shown.forEach((p) => { (lanes[p.kind] = lanes[p.kind] || []).push(p); });

  const TABS = [
    { id: "B", label: "待裁决", icon: "inbox", count: bTotal, tone: "coral" },
    { id: "A", label: "自动应用", icon: "bolt", count: INBOX_A4.autoApplied.length, tone: "good" },
    { id: "C", label: "已处理", icon: "archive", count: INBOX_A4.movedOut.length, tone: "neutral" },
  ];
  const curTab = TABS.find((x) => x.id === lane);

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">INBOX · AI 提议 · 按「可逆性 × 后果」分三档</div>
        <div className="page-head-row">
          <h1 className="page-title serif">收件箱</h1>
        </div>
        <p className="page-lead">{TIER_META[lane].sub}。三档各自成面，互不淹没 —— 切到你要处理的那一档。</p>
      </div>

      {/* tier tab bar — each tier is its own view */}
      <div className="inbox-tabs" role="tablist" aria-label="收件箱分档">
        {TABS.map((tb) => (
          <button key={tb.id} role="tab" aria-selected={lane === tb.id}
            className={"inbox-tab" + (lane === tb.id ? " on" : "")} onClick={() => setLane(tb.id)}>
            <span className={"inbox-tab-no tone-" + tb.tone}>{tb.id}</span>
            <span className="inbox-tab-l"><Icon name={tb.icon} size={14} />{tb.label}</span>
            <span className="inbox-tab-n">{tb.count}</span>
          </button>
        ))}
      </div>

      <Stateful state={ds} onRetry={() => {}} errorText="提议加载失败。"
        skeleton={<><SectionLabel>加载中</SectionLabel><Card pad><SkLines rows={3} /></Card></>}
        empty={<EmptyState icon="checkCircle" title="收件箱已清空" text="所有提议都已裁决。新提议会在下次 Dreaming session 后出现。" />}>

        <div className="fade-key" key={lane}>
          {/* ── B 档 · 逐条人审 ── */}
          {lane === "B" && (
            <React.Fragment>
              <Card pad sunk style={{ marginBottom: "var(--s-5)" }}>
                <div className="inbox-summary-row nowrap-meta">
                  <span className="card-icon accent"><Icon name="sparkle" size={18} /></span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{remaining} 条待你裁决{activeFilters ? " · 已筛选" : ""}</div>
                    <div className="meta">{breakdown || "无匹配"}{cost ? ` · 累计 $${cost.toFixed(4)}` : ""}</div>
                  </div>
                </div>
                <FilterRow label="科目" value={subject} options={SUBJECT_OPTS} onChange={setSubject} />
                <FilterRow label="类型" value={type} options={TYPE_OPTS} onChange={setType} />
              </Card>
              {remaining === 0 ? (
                <EmptyState icon={activeFilters ? "filter" : "checkCircle"} title={activeFilters ? "没有匹配的提议" : "都裁决完了"}
                  text={activeFilters ? "放宽科目或类型筛选试试。" : "新提议会在下次 dreaming 后出现。"}
                  action={activeFilters
                    ? <Btn variant="secondary" size="sm" icon="close" onClick={() => { setSubject("all"); setType("all"); }}>清除筛选</Btn>
                    : <Btn variant="secondary" size="sm" icon="mistakes" onClick={() => go("mistakes")}>去看错题本</Btn>} />
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
            </React.Fragment>
          )}

          {/* ── A 档 · 自动应用 + 撤销窗口 ── */}
          {lane === "A" && (
            <React.Fragment>
              <div className="tier-sub" style={{ marginBottom: "var(--s-4)" }}>{TIER_META.A.sub} · 绕过了人审闸，所以「可撤销」始终可达。</div>
              <TierABlock items={INBOX_A4.autoApplied} />
            </React.Fragment>
          )}

          {/* ── C 档 · 纯状态,移出裁决面 ── */}
          {lane === "C" && (
            <React.Fragment>
              <div className="tier-sub" style={{ marginBottom: "var(--s-4)" }}>{TIER_META.C.sub} —— 它们不需要你裁决，列在这里只是「让你知道去哪了」。</div>
              <TierCBlock items={INBOX_A4.movedOut} go={go} defaultOpen={true} />
            </React.Fragment>
          )}
        </div>
      </Stateful>
    </div>
  );
}

/* ───────────────────────── Mistakes ───────────────────────── */
function AttributionBadge({ at }) {
  if (at.pending) return <span className="badge tone-hard attr-badge"><Icon name="refresh" size={12} className="spin" />归因中…</span>;
  if (at.by === "ai") return <span className="badge tone-info attr-badge"><Icon name="sparkle" size={12} />AI 归因 · {at.cause}{at.confidence ? ` (${Math.round(at.confidence * 100)}%)` : ""}</span>;
  return <span className="badge tone-good attr-badge"><Icon name="today" size={12} />我标注 · {at.cause}</span>;
}

function MistakeCard({ m, go }) {
  const [open, setOpen] = React.useState(false);
  const stateTone = m.state === "已纠正" ? "good" : m.state === "归因中…" ? "hard" : "neutral";
  const last = m.events[m.events.length - 1];
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
          <SubjectTag subject={mSubject(m)} />
          {m.knowledge.map((k) => (
            <button key={k.tag} className="chip chip-k mono kp-chip" onClick={() => go("knowledge")} title="跳到知识图">{k.label}</button>
          ))}
        </div>
        <AttributionBadge at={m.attribution} />
      </div>
      <div className="mistake-foot">
        <button className="expander" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="arrow" size={13} style={{ transform: open ? "rotate(90deg)" : "rotate(90deg)" }} />
          事件链 · {m.events.length} 步
        </button>
        <button className="evidence-readable" onClick={() => go("events")} title={"事件 events:" + m.eventId}>
          <span className="er-ic"><Icon name="clock" size={13} /></span>
          <span className="er-text">最近：{last.note}</span>
          <span className="er-go">查看事件链 →</span>
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

const MSTATE_OPTS = [["all", "全部"], ["待重学", "待重学"], ["已纠正", "已纠正"], ["归因中…", "归因中"]];
const MATTR_OPTS = [["all", "全部"], ["ai", "AI 归因"], ["user", "我标注"]];

function ScreenMistakes({ go, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [subject, setSubject] = React.useState("all");
  const [state, setState] = React.useState("all");
  const [attr, setAttr] = React.useState("all");
  const all = DATA.mistakes;

  const attrOf = (m) => m.attribution.pending ? "ai" : m.attribution.by;
  const shown = all.filter((m) =>
    (subject === "all" || mSubject(m) === subject) &&
    (state === "all" || m.state === state) &&
    (attr === "all" || attrOf(m) === attr));
  const activeFilters = (subject !== "all") + (state !== "all") + (attr !== "all");
  const pending = all.filter((m) => m.attribution.pending).length;
  const reset = () => { setSubject("all"); setState("all"); setAttr("all"); };

  return (
    <div className="page view">
      <div className="page-head">
        <div className="eyebrow">MISTAKES · 错题归因 · 共 {all.length} 条 · 归因中 {pending}</div>
        <div className="page-head-row">
          <h1 className="page-title serif">错题本</h1>
          <div className="hero-cta">
            <Btn variant="ghost" size="sm" icon="record" onClick={() => go("record")}>录新错题</Btn>
            <Btn variant="primary" size="sm" icon="review" onClick={() => go("review")}>重练薄弱点</Btn>
          </div>
        </div>
        <p className="page-lead">每条错题是一条记录：题面 / 错答 / 知识点 / 归因（AI vs 我）/ 纠错状态，展开看事件链。</p>
      </div>

      {/* filters */}
      <Card pad sunk style={{ marginBottom: "var(--s-5)" }}>
        <div className="inbox-summary-row nowrap-meta">
          <span className="card-icon accent"><Icon name="mistakes" size={18} /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{shown.length} 条错题{activeFilters ? " · 已筛选" : ""}</div>
            <div className="meta">待重学 {all.filter((m) => m.state === "待重学").length} · 已纠正 {all.filter((m) => m.state === "已纠正").length} · 归因中 {pending}</div>
          </div>
          {activeFilters > 0 && <button className="qf2-reset" style={{ marginLeft: "auto" }} onClick={reset}><Icon name="close" size={13} />清除筛选</button>}
        </div>
        <FilterRow label="科目" value={subject} options={SUBJECT_OPTS} onChange={setSubject} />
        <FilterRow label="状态" value={state} options={MSTATE_OPTS} onChange={setState} />
        <FilterRow label="归因" value={attr} options={MATTR_OPTS} onChange={setAttr} />
      </Card>

      <Stateful state={ds} onRetry={() => {}} errorText="错题加载失败。"
        skeleton={<div className="grid" style={{ gap: "var(--s-3)" }}>{[1, 2, 3].map((i) => <Card key={i} pad><SkLines rows={1} /></Card>)}</div>}
        empty={<EmptyState icon="mistakes" title="还没有错题" text="复习答错或手动录入后，错题会聚到这里并自动归因。"
          action={<Btn variant="primary" size="sm" icon="record" onClick={() => go("record")}>+ 录新错题</Btn>} />}>
        {shown.length === 0 ? (
          <EmptyState icon="filter" title="没有匹配的错题" text="放宽科目 / 状态 / 归因筛选试试。"
            action={<Btn variant="secondary" size="sm" icon="close" onClick={reset}>清除筛选</Btn>} />
        ) : (
          <div className="grid stagger" style={{ gap: "var(--s-3)" }}>
            {shown.map((m) => <MistakeCard key={m.id} m={m} go={go} />)}
          </div>
        )}
      </Stateful>
    </div>
  );
}

window.ScreenInbox = ScreenInbox;
window.ScreenMistakes = ScreenMistakes;
