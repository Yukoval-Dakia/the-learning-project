// Loom · /notes/[id] — first-class Notion-like NoteReader.
// A note is an independent entity. knowledge_id lives ONLY in note.labels;
// the SAME note id is reachable from many knowledge nodes and many learning items.
// param format: "noteId" or "noteId~k~k_xuci_zhi" / "noteId~i~li_xuci" (entry context)

const OUTLINE_META = {
  h:       { glyph: "H", kind: "标题" },
  wenyan:  { glyph: "文", kind: "文言段" },
  callout: { glyph: "✦", kind: "提示" },
  latex:   { glyph: "ƒ", kind: "公式" },
  code:    { glyph: "</>", kind: "代码" },
  quiz:    { glyph: "?", kind: "内嵌测验" },
};
function shortText(t, n = 14) { const s = (t || "").split("\n")[0].replace(/^[①②③④⑤\s]+/, ""); return s.length > n ? s.slice(0, n) + "…" : s; }

// A cross-link rendered as a Notion-style block link card (not just inline).
function BlockLinkCard({ link, go }) {
  const k = link.tag ? DATA.knowledge.find((n) => n.tag === link.tag || n.id === link.tag) : null;
  return (
    <button className="nb-linkcard" onClick={() => link.tag && go("knowledge/" + (k ? k.id : link.tag))}>
      <span className="nb-linkcard-ic"><Icon name="knowledge" size={16} /></span>
      <span className="nb-linkcard-body">
        <span className="nb-linkcard-t">{link.label}</span>
        <span className="nb-linkcard-s mono">{link.kind} · {k ? k.tag : link.tag}</span>
      </span>
      {k && <span className="nb-linkcard-pct mono">{k.mastery}%</span>}
      <Icon name="arrow" size={15} className="thread-arrow" />
    </button>
  );
}

// Read-mode body: collapsible sections, hover anchor actions, link cards.
function NoteReaderBody({ note, go }) {
  const blocks = note.blocks;
  const [collapsed, setCollapsed] = React.useState({});
  const anchor = (id) => {
    const el = document.getElementById("nb-anchor-" + id);
    if (el) { const y = el.getBoundingClientRect().top + window.scrollY - 84; document.documentElement.scrollTop = y; document.body.scrollTop = y; }
  };
  window.__noteAnchor = anchor;

  // skip a leading heading that merely repeats the page title
  let body = blocks;
  if (body[0] && body[0].type === "h" && body[0].text === note.title) body = body.slice(1);

  return (
    <div className="note-reader-body">
      {body.map((b) => {
        const isSection = b.type === "h";
        const sc = collapsed[b.id];
        return (
          <div key={b.id} id={"nb-anchor-" + b.id} className={"nrb-block nrb-" + b.type}>
            <div className="nrb-gutter">
              {isSection ? (
                <button className="nrb-collapse" aria-label="折叠" onClick={() => setCollapsed((c) => ({ ...c, [b.id]: !c[b.id] }))}>
                  <Icon name="arrow" size={13} style={{ transform: sc ? "rotate(0deg)" : "rotate(90deg)", transition: "transform var(--dur-fast)" }} />
                </button>
              ) : (
                <button className="nrb-anchor-btn" title="复制锚点" onClick={() => anchor(b.id)}><Icon name="link" size={12} /></button>
              )}
            </div>
            <div className="nrb-content">
              {isSection ? <h2 className="nrb-h">{b.text}</h2> : !sc && <NoteBlock b={b} onLink={(l) => l.tag && go("knowledge/" + l.tag)} />}
              {!isSection && b.link && !sc && <div className="nrb-linkrow"><BlockLinkCard link={b.link} go={go} /></div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScreenNoteReader({ go, param, ui = {} }) {
  const ds = ui.dataState || "ok";
  const [noteId, fromKind, fromId] = (param || "note_zhi").split("~");
  const note = noteById(noteId) || DATA.notes[0];
  const [mode, setMode] = React.useState("read");
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [ctxOpen, setCtxOpen] = React.useState(false);

  if (ds !== "ok") {
    return (
      <div className="page view page-narrow">
        <button className="back-link" onClick={() => go("knowledge")}><Icon name="arrowL" size={14} />知识</button>
        <Stateful state={ds} onRetry={() => {}} errorText="笔记加载失败。"
          skeleton={<Card pad><SkLines rows={6} /></Card>}
          empty={<EmptyState icon="note" title="笔记不存在" text="该笔记可能已被删除或合并。" />}>
          <div />
        </Stateful>
      </div>
    );
  }

  const labels = note.labels.map((kid) => ({ kid, title: knowledgeTitle(kid) }));
  const relItems = itemsForNote(note.id);
  const entryCount = labels.length + relItems.length;
  const fromLabel = fromKind === "k" ? knowledgeTitle(fromId) : fromKind === "i" ? (DATA.items.find((i) => i.id === fromId) || {}).title : null;

  // outline entries (block tree)
  let ob = note.blocks;
  if (ob[0] && ob[0].type === "h" && ob[0].text === note.title) ob = ob.slice(1);
  const outline = ob.filter((b) => b.type !== "p" || b.link).map((b) => ({
    id: b.id, type: b.type,
    meta: OUTLINE_META[b.type] || { glyph: "·", kind: "块" },
    label: b.type === "h" ? b.text : b.type === "code" ? b.lang : b.type === "callout" ? shortText(b.text, 16) : b.link ? b.link.label : shortText(b.text),
  }));

  const Outline = (
    <nav className="note-outline">
      <div className="note-rail-h"><Icon name="panelLeft" size={14} />大纲 · block tree</div>
      <button className="nol-item nol-top" onClick={() => { document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }}><span className="nol-glyph">⌂</span>文档顶部</button>
      {outline.map((o) => (
        <button key={o.id} className={"nol-item nol-" + o.type} onClick={() => { window.__noteAnchor && window.__noteAnchor(o.id); setOutlineOpen(false); }}>
          <span className="nol-glyph mono">{o.meta.glyph}</span>
          <span className="nol-label">{o.label}</span>
        </button>
      ))}
    </nav>
  );

  const Context = (
    <aside className="note-context">
      <div className="drawer-sec">
        <div className="drawer-sec-h"><Icon name="doc" size={13} />属性</div>
        <div className="note-prop-row"><span className="meta">状态</span><span className={"verify-badge " + note.verify}><Icon name={note.verify === "verified" ? "check" : "sparkle"} size={11} />{note.verify === "verified" ? "已校验" : "草稿"}</span></div>
        <div className="note-prop-row"><span className="meta">更新</span><span>{note.updated}</span></div>
        <div className="note-prop-row"><span className="meta">作者</span><span className="adm-actor mono"><Icon name={ACTOR_ICON[note.from] || "today"} size={12} />{note.from}</span></div>
        <div className="note-prop-row"><span className="meta">块数</span><span className="mono tnum">{note.blocks.length}</span></div>
      </div>

      <div className="drawer-sec">
        <div className="drawer-sec-h"><Icon name="link" size={13} />被这些 knowledge 标签命中 · {labels.length}</div>
        <div className="note-label-list">
          {labels.map((l) => (
            <button key={l.kid} className={"note-label-row" + (fromKind === "k" && fromId === l.kid ? " is-entry" : "")} onClick={() => go("knowledge/" + l.kid)}>
              <span className="chip chip-k mono">{l.kid}</span>
              <span className="wenyan">{l.title}</span>
              {fromKind === "k" && fromId === l.kid && <span className="entry-tag mono">入口</span>}
              <Icon name="arrow" size={13} className="thread-arrow" />
            </button>
          ))}
        </div>
      </div>

      <div className="drawer-sec">
        <div className="drawer-sec-h"><Icon name="items" size={13} />相关学习项 · {relItems.length}</div>
        {relItems.length === 0 ? <div className="meta">暂无共享标签的学习项</div> : (
          <div className="note-label-list">
            {relItems.map((it) => (
              <button key={it.id} className={"note-label-row" + (fromKind === "i" && fromId === it.id ? " is-entry" : "")} onClick={() => go("items/" + it.id)}>
                <span className={"sess-type-ic tone-" + (it.color === "coral" ? "coral" : "info")} style={{ width: 24, height: 24 }}><Icon name={it.icon} size={13} /></span>
                <span className="wenyan">{it.title}</span>
                {fromKind === "i" && fromId === it.id && <span className="entry-tag mono">入口</span>}
                <Icon name="arrow" size={13} className="thread-arrow" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="drawer-sec">
        <div className="drawer-sec-h"><Icon name="history" size={13} />活动 · 版本</div>
        <div className="note-versions">
          {note.versions.map((v, i) => (
            <div key={v.v} className={"note-ver" + (i === 0 ? " is-current" : "")}>
              <span className="note-ver-dot" />
              <div className="note-ver-body">
                <div className="note-ver-top"><span className="mono note-ver-v">{v.v}</span><span className="adm-actor mono"><Icon name={ACTOR_ICON[v.actor] || "today"} size={11} />{v.actor}</span><span className="meta" style={{ marginLeft: "auto" }}>{v.t}</span></div>
                <div className="note-ver-note">{v.note}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );

  return (
    <div className="note-reader-page">
      {/* top sub-bar */}
      <div className="note-topbar">
        <button className="back-link" style={{ margin: 0 }} onClick={() => fromKind === "k" ? go("knowledge/" + fromId) : fromKind === "i" ? go("items/" + fromId) : go("knowledge")}>
          <Icon name="arrowL" size={14} />{fromKind === "k" ? "返回知识点" : fromKind === "i" ? "返回学习项" : "知识"}
        </button>
        <span className="meta mono note-id-pill">/notes/{note.id}</span>
        <div className="topbar-spacer" />
        <button className="icon-btn note-rail-toggle" title="大纲" onClick={() => setOutlineOpen((o) => !o)}><Icon name="panelLeft" size={16} /></button>
        <div className="seg seg-sm note-mode">
          <button className={mode === "read" ? "on" : ""} onClick={() => setMode("read")}><Icon name="eye" size={14} />阅读</button>
          <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}><Icon name="pencil" size={14} />编辑</button>
        </div>
        <button className="icon-btn note-rail-toggle" title="上下文" onClick={() => setCtxOpen((o) => !o)}><Icon name="panelRight" size={16} /></button>
      </div>

      <div className="note-reader-grid">
        <div className="note-rail-left">{Outline}</div>

        <main className="note-doc-col">
          {/* one-note-many-entries banner */}
          {fromLabel && (
            <div className="note-entry-banner">
              <Icon name="link" size={15} />
              <span>你经由 <b>{fromKind === "k" ? "知识点" : "学习项"} {fromLabel}</b> 打开这篇笔记 · 同一篇笔记另有 <b>{entryCount - 1}</b> 个入口</span>
            </div>
          )}

          {/* in-page title (NOT inside a card) */}
          <header className="note-doc-head">
            <div className="eyebrow">NOTE · note_id={note.id} · labels[]=knowledge_id</div>
            <h1 className="note-doc-title serif">{note.title}</h1>
            <div className="note-doc-meta">
              {labels.map((l) => (
                <button key={l.kid} className="chip chip-k mono" onClick={() => go("knowledge/" + l.kid)}><Icon name="link" size={11} />{l.kid}</button>
              ))}
              <span className={"verify-badge " + note.verify}><Icon name={note.verify === "verified" ? "check" : "sparkle"} size={11} />{note.verify === "verified" ? "已校验" : "草稿"}</span>
              <span className="meta">更新 {note.updated} · {note.from}</span>
            </div>
          </header>

          {/* entry-points strip — makes "same note, many doors" explicit */}
          <div className="note-entries-strip">
            <span className="meta">入口 · {entryCount}</span>
            {labels.map((l) => (
              <button key={l.kid} className={"entry-pill" + (fromKind === "k" && fromId === l.kid ? " is-here" : "")} onClick={() => go("knowledge/" + l.kid)}>
                <Icon name="knowledge" size={12} />{l.title}
              </button>
            ))}
            {relItems.map((it) => (
              <button key={it.id} className={"entry-pill" + (fromKind === "i" && fromId === it.id ? " is-here" : "")} onClick={() => go("items/" + it.id)}>
                <Icon name="items" size={12} />{it.title}
              </button>
            ))}
          </div>

          {mode === "read"
            ? <NoteReaderBody note={note} go={go} />
            : <div className="note-edit-shell"><div className="meta" style={{ marginBottom: "var(--s-3)" }}><Icon name="pencil" size={12} /> 编辑模式 · 悬停块显示拖拽手柄与 / 插入</div><NoteEditor doc={note.blocks} editable onLink={(l) => l.tag && go("knowledge/" + l.tag)} /></div>}
        </main>

        <div className="note-rail-right">{Context}</div>
      </div>

      {/* mobile drawers */}
      {outlineOpen && <div className="scrim open" onClick={() => setOutlineOpen(false)} />}
      <div className={"note-mobile-drawer left" + (outlineOpen ? " open" : "")}>{Outline}</div>
      {ctxOpen && <div className="scrim open" onClick={() => setCtxOpen(false)} />}
      <div className={"note-mobile-drawer right" + (ctxOpen ? " open" : "")}>{Context}</div>
    </div>
  );
}
window.ScreenNoteReader = ScreenNoteReader;
