// Loom · /learning-items/[id] full editor (F) + TeachingDrawer entry.
function ParentPicker({ current, items, onPick }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const cur = items.find((i) => i.id === current);
  const matches = items.filter((i) => i.kind === "hub" && i.id !== current && (i.title.includes(q) || i.sub.includes(q)));
  return (
    <div className="parent-picker">
      <button className="field-input picker-trigger" onClick={() => setOpen((o) => !o)}>
        <Icon name="items" size={14} /><span>{cur ? cur.title : "无父节点"}</span><Icon name="arrow" size={13} style={{ marginLeft: "auto", transform: "rotate(90deg)" }} />
      </button>
      {open && (
        <div className="picker-pop fade-key">
          <input className="field-input field-inline" autoFocus placeholder="搜索 hub…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="picker-opt" onClick={() => { onPick(null); setOpen(false); }}>无父节点</button>
          {matches.map((m) => <button key={m.id} className="picker-opt" onClick={() => { onPick(m.id); setOpen(false); }}><span className="wenyan">{m.title}</span><span className="meta">{m.sub}</span></button>)}
          {matches.length === 0 && <div className="quiet-empty" style={{ padding: "var(--s-2)" }}>无匹配</div>}
        </div>
      )}
    </div>
  );
}

function ScreenItemDetail({ go, param, ui = {} }) {
  const base = DATA.items.find((i) => i.id === param) || DATA.items.find((i) => i.id === "li_zhi");
  const [it, setIt] = React.useState(base);
  const [teach, setTeach] = React.useState(false);
  const [retracted, setRetracted] = React.useState(false);
  React.useEffect(() => { setIt(DATA.items.find((i) => i.id === param) || base); }, [param]);
  const children = DATA.items.filter((i) => i.parent === it.id);
  const flow = ITEM_STATUSES;

  return (
    <div className="page view">
      <button className="back-link" onClick={() => go("items")}><Icon name="arrowL" size={14} />学习项</button>
      <div className="page-head">
        <div className="eyebrow">LEARNING_ITEM · {it.id} · {it.kind}</div>
        <div className="page-head-row">
          <input className="title-input serif" defaultValue={it.title} aria-label="标题" />
          <div className="hero-cta">
            <Btn variant="secondary" icon="teach" onClick={() => setTeach(true)}>对话教学</Btn>
            <Btn variant="primary" icon="review" onClick={() => go("review")}>复习</Btn>
          </div>
        </div>
      </div>

      <div className="kd-grid">
        <div className="kd-main">
          {/* origin proposal */}
          {it.origin && (
            <Card pad className={"origin-card" + (retracted ? " resolved" : "")} style={{ marginBottom: "var(--s-5)" }}>
              <div className="proposal-head">
                <span className="ai-tag"><Icon name="sparkle" size={12} />AI · {it.origin.from}</span>
                <span className="proposal-title">由 AI 拆解提议创建</span>
                <span className="meta mono" style={{ marginLeft: "auto" }}>{Math.round(it.origin.confidence * 100)}% · {it.origin.when}</span>
              </div>
              <div className="proposal-body">{it.origin.reason}</div>
              <div className="proposal-foot">
                {retracted ? <Badge tone="neutral"><Icon name="undo" size={12} />已撤回 · 原因：与现有专项重叠</Badge>
                  : <Btn size="sm" variant="ghost" icon="undo" onClick={() => setRetracted(true)}>撤回此提议（记录原因）</Btn>}
              </div>
            </Card>
          )}

          {/* related notes — independent entities linked by shared knowledge labels */}
          {(() => {
            const notes = notesForItem(it);
            return (<>
              <SectionLabel count={notes.length || null}>关联笔记</SectionLabel>
              <div className="kd-note-hint meta"><Icon name="link" size={12} />笔记是独立实体，通过 knowledge_id 标签与本学习项关联——同一条笔记可被多个学习项 / 知识点引用，打开后是同一篇 /notes/[id]</div>
              {notes.length === 0 ? (
                <Card pad><EmptyState icon="note" title="尚无关联笔记" text="新建一条笔记并打上本学习项的知识点标签，或让 AI 生成初稿。" action={<Btn size="sm" variant="primary" icon="sparkle">AI 生成</Btn>} /></Card>
              ) : (
                <div className="grid" style={{ gap: "var(--s-3)" }}>
                  {notes.map((nt) => (
                    <Card key={nt.id} pad hover className="note-ref">
                      <div className="note-ref-head">
                        <span className="card-icon"><Icon name="note" size={16} /></span>
                        <button className="note-ref-title" onClick={() => go("notes/" + nt.id + "~i~" + it.id)}>{nt.title}</button>
                        <span className={"verify-badge " + nt.verify}><Icon name={nt.verify === "verified" ? "check" : "sparkle"} size={11} />{nt.verify === "verified" ? "已校验" : "草稿"}</span>
                      </div>
                      <div className="note-ref-labels">
                        <span className="meta">标签</span>
                        {nt.labels.map((k) => (
                          <button key={k} className={"chip chip-k mono" + (it.knowledge.includes(k) ? " is-on" : "")} onClick={() => go("knowledge/" + k)}>
                            {k}{it.knowledge.includes(k) && <Icon name="check" size={11} />}
                          </button>
                        ))}
                        <span className="meta" style={{ marginLeft: "auto" }}>更新 {nt.updated}</span>
                      </div>
                      <div className="note-ref-acts">
                        <Btn size="sm" variant="primary" icon="doc" iconEnd="arrow" onClick={() => go("notes/" + nt.id + "~i~" + it.id)}>打开笔记</Btn>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </>);
          })()}

          {/* children */}
          {children.length > 0 && (
            <>
              <SectionLabel count={children.length}>子项</SectionLabel>
              <div className="grid" style={{ gap: "var(--s-2)" }}>
                {children.map((c) => (
                  <button key={c.id} className="child-row" onClick={() => go("items/" + c.id)}>
                    <span className={"item-ic " + c.color} style={{ width: 32, height: 32 }}><Icon name={c.icon} size={16} /></span>
                    <span className="wenyan">{c.title}</span><StatusBadge status={c.status} />
                    <Ring percent={Math.round(c.mastered / c.cards * 100)} /><Icon name="arrow" size={14} className="thread-arrow" />
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="kd-side">
          <SectionLabel>属性</SectionLabel>
          <Card pad>
            <div className="prop-field">
              <div className="field-label">状态</div>
              <div className="status-flow">
                {flow.map((s) => (
                  <button key={s} className={"status-step" + (it.status === s ? " on" : "")} onClick={() => setIt((x) => ({ ...x, status: s }))}>
                    <span className="status-glyph" aria-hidden="true">{STATUS_META[s].glyph}</span>{STATUS_META[s].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="prop-field">
              <div className="field-label">知识点</div>
              <div className="chip-set">
                {it.knowledge.map((k) => <button key={k} className="chip chip-k mono" onClick={() => go("knowledge/" + k)}>{k}<Icon name="close" size={11} /></button>)}
                <button className="chip"><Icon name="plus" size={11} />添加</button>
              </div>
            </div>
            <div className="prop-field">
              <div className="field-label">父节点</div>
              <ParentPicker current={it.parent} items={DATA.items} onPick={(p) => setIt((x) => ({ ...x, parent: p }))} />
            </div>
            <div className="prop-field">
              <div className="field-label">artifact 视图</div>
              <div className="seg seg-sm"><button className="on">块树</button><button>大纲</button><button>只读</button></div>
            </div>
          </Card>
        </div>
      </div>

      <TeachingDrawer open={teach} onClose={() => setTeach(false)} item={it} />
    </div>
  );
}
window.ScreenItemDetail = ScreenItemDetail;
