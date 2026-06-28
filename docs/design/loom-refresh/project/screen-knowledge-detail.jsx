// Loom · /knowledge/[id] deep page (D).
const BACKLINK_KIND = { atomic: "原子项", hub: "枢纽项", long: "长文/学习项", quiz: "测验" };

// A note shown under a knowledge node via its label. Its other labels are visible,
// making the many-to-many relationship explicit. Collapsible readonly render.
function NoteRefCard({ note, here, go }) {
  const [open, setOpen] = React.useState(false);
  const titleOf = (kid) => { const k = DATA.knowledge.find((n) => n.id === kid); return k ? k.title : kid; };
  return (
    <Card pad hover className="note-ref">
      <div className="note-ref-head">
        <span className="card-icon"><Icon name="note" size={16} /></span>
        <button className="note-ref-title" onClick={() => go("notes/" + note.id + "~k~" + here)}>{note.title}</button>
        <span className={"verify-badge " + note.verify}><Icon name={note.verify === "verified" ? "check" : "sparkle"} size={11} />{note.verify === "verified" ? "已校验" : "草稿"}</span>
      </div>
      <div className="note-ref-labels">
        <span className="meta">标签</span>
        {note.labels.map((kid) => (
          <button key={kid} className={"chip chip-k mono" + (kid === here ? " is-on" : "")} onClick={() => go("knowledge/" + kid)} title={titleOf(kid)}>
            {kid}{kid === here && <Icon name="check" size={11} />}
          </button>
        ))}
        <span className="meta" style={{ marginLeft: "auto" }}>更新 {note.updated} · {note.from}</span>
      </div>
      <div className="note-ref-acts">
        <Btn size="sm" variant="primary" icon="doc" iconEnd="arrow" onClick={() => go("notes/" + note.id + "~k~" + here)}>打开笔记</Btn>
        <button className="note-ref-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "minus" : "eye"} size={13} />{open ? "收起预览" : "快速预览"}
        </button>
      </div>
      {open && <div className="note-ref-body fade-key"><NoteEditor doc={note.blocks} editable={false} onLink={(l) => l.tag && go("knowledge/" + l.tag)} /></div>}
    </Card>
  );
}

function ScreenKnowledgeDetail({ go, param, ui = {} }) {
  const ds = ui.dataState || "ok";
  const node = DATA.knowledge.find((n) => n.id === param) || DATA.knowledge.find((n) => n.id === "k_xuci_zhi");
  const extra = (window.KA5 && KA5.nodeExtra[node.id]) || null;
  const parent = DATA.knowledge.find((n) => n.id === node.parent);
  const children = DATA.knowledge.filter((n) => n.parent === node.id);
  const rels = DATA.knowledgeEdges.filter((e) => e.a === node.id || e.b === node.id);
  const other = (e) => DATA.knowledge.find((n) => n.id === (e.a === node.id ? e.b : e.a));
  const detail = DATA.knowledgeDetail[node.id];
  // group typed neighbors by relation
  const byRel = {};
  rels.forEach((e) => { (byRel[e.rel] = byRel[e.rel] || []).push(other(e)); });

  return (
    <div className="page view">
      <button className="back-link" onClick={() => go("knowledge")}><Icon name="arrowL" size={14} />知识</button>
      <div className="page-head">
        <div className="eyebrow">KNOWLEDGE · {node.tag} · {node.kind}</div>
        <div className="kd-head">
          <div style={{ minWidth: 0 }}>
            <h1 className="page-title serif">{node.title}</h1>
            <div className="kd-metrics nowrap-meta">
              <BandChip node={node} />
              <span className="meta mono">{node.evidence} evidence</span><span className="dot-sep">·</span>
              {(() => { const db = DECAY_BUCKET[node.decay] || DECAY_BUCKET.slow; return (
                <span className={"decay-bucket tone-" + db.tone} title={db.hint}>
                  <Icon name={DECAY_META[node.decay].icon} size={12} />
                  <span>衰减 · {db.label}</span>
                </span>
              ); })()}
              {node.mistakes > 0 && <Badge tone="again">{node.mistakes} 错题</Badge>}
            </div>
          </div>
          <div className="hero-cta" style={{ marginLeft: "auto" }}>
            <Btn variant="secondary" icon="review" onClick={() => go("review")}>复习此点</Btn>
          </div>
        </div>
      </div>

      <NodeComposite node={node} extra={extra} />

      <div className="kd-grid">
        <div className="kd-main">
          <SectionLabel count={KA5.misconceptions.filter((m) => m.targets.includes(node.id)).length || null}>指向此点的误区 · misconception</SectionLabel>
          <MisconceptionList node={node} go={go} />

          <SectionLabel>迁移而来的掉握 · transfer credit</SectionLabel>
          <TransferList extra={extra} />

          <SectionLabel>诊断下钻 · CDM / IRT</SectionLabel>
          <DiagnosticDrill extra={extra} />

          {/* notes for this knowledge id — split by kind, NOT flattened */}
          {(() => {
            const nbk = notesByKindForKnowledge(node.id);
            const annos = annotationsForKnowledge(node.id);
            const hasAny = nbk.primary || nbk.atomic.length || nbk.hub.length || nbk.long.length;
            return (
              <>
                <SectionLabel>笔记</SectionLabel>
                <div className="kd-note-hint meta"><Icon name="link" size={12} />knowledge_id 是笔记上的标签 · 笔记按 note_atomic / note_hub / note_long 区分，一条笔记可挂多个知识点</div>

                {!hasAny ? (
                  <Card pad><EmptyState icon="note" title="还没有带此标签的笔记" text="撰写一条笔记并打上该知识点标签，或让 AI 从相关 evidence 起草。" action={<Btn size="sm" variant="primary" icon="sparkle">AI 起草</Btn>} /></Card>
                ) : (
                  <>
                    {/* primary atomic — full reading body inline */}
                    {nbk.primary && (
                      <Card pad className="kd-primary-note">
                        <div className="kd-primary-head">
                          <span className="note-kind-tag note-kind-atomic"><Icon name="note" size={12} />primary · note_atomic</span>
                          <span className="kd-primary-title serif">{nbk.primary.title}</span>
                          <span className={"verify-badge " + nbk.primary.verify}><Icon name={nbk.primary.verify === "verified" ? "check" : "sparkle"} size={11} />{nbk.primary.verify === "verified" ? "已校验" : "草稿"}</span>
                        </div>
                        <div className="kd-primary-body"><NoteEditor doc={nbk.primary.blocks} editable={false} onLink={(l) => l.tag && go("knowledge/" + l.tag)} /></div>
                        <div className="note-ref-acts" style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s-3)" }}>
                          <Btn size="sm" variant="primary" icon="doc" iconEnd="arrow" onClick={() => go("notes/" + nbk.primary.id + "~k~" + node.id)}>在阅读器中打开</Btn>
                          <Btn size="sm" variant="ghost" icon="pencil">编辑</Btn>
                        </div>
                      </Card>
                    )}

                    {/* other notes grouped by kind — compact link rows */}
                    {[["atomic", nbk.atomic, "其它 atomic 笔记"], ["hub", nbk.hub, "hub 笔记"], ["long", nbk.long, "long 长文"]].filter(([, arr]) => arr.length).map(([kind, arr, label]) => (
                      <div key={kind} className="kd-note-group">
                        <div className="kd-note-group-h"><span className={"note-kind-tag note-kind-" + kind}>{kind}</span>{label} · {arr.length}</div>
                        {arr.map((nt) => (
                          <button key={nt.id} className="note-link-row" onClick={() => go("notes/" + nt.id + "~k~" + node.id)}>
                            <Icon name={kind === "long" ? "doc" : kind === "hub" ? "items" : "note"} size={15} />
                            <span className="note-link-title">{nt.title}</span>
                            <span className={"verify-badge " + nt.verify} style={{ flex: "none" }}><Icon name={nt.verify === "verified" ? "check" : "sparkle"} size={10} />{nt.verify === "verified" ? "已校验" : "草稿"}</span>
                            <span className="meta">{nt.updated}</span>
                            <Icon name="arrow" size={13} className="thread-arrow" />
                          </button>
                        ))}
                      </div>
                    ))}
                  </>
                )}

                {/* 标注笔记 — annotation group (lighter than the 3 note kinds) */}
                <SectionLabel count={annos.length || null}>标注笔记</SectionLabel>
                {annos.length === 0 ? (
                  <div className="quiet-empty">无标注</div>
                ) : (
                  <Card pad className="anno-list">
                    {annos.map((a) => (
                      <div key={a.id} className="anno-row">
                        <span className={"anno-actor adm-actor mono"}><Icon name={a.author === "agent" ? "sparkle" : "today"} size={12} />{a.author}</span>
                        <div className="anno-body">
                          <div className="anno-text">{a.text}</div>
                          <div className="anno-meta meta">
                            {a.onNote ? <button className="anno-anchor" onClick={() => go("notes/" + a.onNote + "~k~" + node.id)}><Icon name="link" size={11} />{a.onNote}{a.onBlock ? "#" + a.onBlock : ""}</button> : <span>未锚定</span>}
                            <span className="dot-sep">·</span>{a.when}
                          </div>
                        </div>
                      </div>
                    ))}
                    <button className="note-link-row anno-add"><Icon name="plus" size={14} />添加标注</button>
                  </Card>
                )}
              </>
            );
          })()}

          {/* neighbors grouped by relation */}
          <SectionLabel>邻居 · 按关系分组</SectionLabel>
          <Card pad>
            <div className="kd-rel-block">
              <div className="kd-rel-h"><Icon name="tree" size={13} />层级</div>
              {parent && <button className="rel-row" onClick={() => go("knowledge/" + parent.id)}><span className="rel-kind mono">parent</span><span className="wenyan">{parent.title}</span><Icon name="arrow" size={13} /></button>}
              {children.map((c) => <button key={c.id} className="rel-row" onClick={() => go("knowledge/" + c.id)}><span className="rel-kind mono">child</span><span className="wenyan">{c.title}</span><BandChip node={c} /></button>)}
              {!parent && children.length === 0 && <div className="quiet-empty">无层级邻居</div>}
            </div>
            {Object.keys(byRel).map((rel) => (
              <div key={rel} className="kd-rel-block">
                <div className="kd-rel-h"><span className={"rel-tag rel-tag-" + rel}><span className="mono">{REL_CUE[rel].glyph}</span>{REL_CUE[rel].label}</span></div>
                {byRel[rel].map((o) => <button key={o.id} className="rel-row" onClick={() => go("knowledge/" + o.id)}><span className="wenyan">{o.title}</span><span className="chip chip-k mono">{o.tag}</span><Icon name="arrow" size={13} /></button>)}
              </div>
            ))}
          </Card>
        </div>

        <div className="kd-side">
          {/* backlinks grouped by SOURCE ARTIFACT TYPE */}
          <SectionLabel>反向链接 · 按来源类型</SectionLabel>
          <Card pad>
            {(() => {
              const bl = backlinksByArtifact(node.id);
              const ARTI = { question: { label: "题目", icon: "quiz" }, note: { label: "笔记", icon: "note" }, learning_item: { label: "学习项", icon: "items" }, mistake: { label: "错题", icon: "mistakes" }, session: { label: "会话", icon: "history" } };
              const routeFor = { question: "questions", note: null, learning_item: "items", mistake: "mistakes", session: "learning-sessions" };
              if (!bl) return <div className="quiet-empty">无反向链接</div>;
              return Object.keys(bl).filter((t) => bl[t].length).map((t) => (
                <div key={t} className="bl-group">
                  <div className="bl-kind mono"><Icon name={ARTI[t].icon} size={12} />{ARTI[t].label} · {bl[t].length}</div>
                  {bl[t].map((b, i) => (
                    <button key={i} className="bl-row" onClick={() => { if (t === "note") go("notes/" + b.id + "~k~" + node.id); else if (t === "learning_item") go("items/" + b.id); else if (t === "session") go("learning-sessions/" + b.id); else go(routeFor[t] || "knowledge"); }}>
                      <span className="bl-row-main"><span className="bl-row-t">{b.label}</span><span className="bl-row-m meta mono">{b.meta}</span></span>
                      <Icon name="arrow" size={12} className="thread-arrow" />
                    </button>
                  ))}
                </div>
              ));
            })()}
          </Card>

          {/* activity timeline */}
          <SectionLabel>活动</SectionLabel>
          <Card pad>
            {detail ? (
              <div className="event-chain">
                {detail.activity.map((a, i) => (
                  <div key={i} className="event-row">
                    <span className="event-rail"><span className={"event-dot tone-" + a.tone} style={{ background: `var(--${a.tone})` }} />{i < detail.activity.length - 1 && <span className="event-line" />}</span>
                    <div className="event-body">
                      <div className="event-head nowrap-meta"><span className="mono event-label">{a.label}</span><span className="meta">{a.t}</span></div>
                      <div className="event-note">{a.note}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : <div className="quiet-empty">无活动记录</div>}
          </Card>
        </div>
      </div>
    </div>
  );
}
window.ScreenKnowledgeDetail = ScreenKnowledgeDetail;
