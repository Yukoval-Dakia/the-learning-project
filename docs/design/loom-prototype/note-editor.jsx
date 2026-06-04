// Loom · block-tree note editor (G). Readonly renderer + editable shell.
// Used readonly in /knowledge/[id] & item artifact; editable in /learning-items/[id].

// ---- inline render helpers -------------------------------------------------
function renderLatex(src) {
  // lightweight typeset: ^{..}/_{..} → sup/sub, \cdot·, \times×, e^{} etc.
  let s = src
    .replace(/\\cdot/g, "·").replace(/\\times/g, "×").replace(/\\le/g, "≤").replace(/\\ge/g, "≥")
    .replace(/\\text\{([^}]*)\}/g, "$1").replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1)/($2)");
  const parts = [];
  const re = /([_^])\{([^}]*)\}|([_^])(\w)/g; let last = 0, m, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const sup = (m[1] || m[3]) === "^"; const body = m[2] != null ? m[2] : m[4];
    parts.push(sup ? <sup key={k++}>{body}</sup> : <sub key={k++}>{body}</sub>);
    last = re.lastIndex;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

function QuizBlock({ b, editable }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="nb-quiz">
      <div className="nb-quiz-head"><Icon name="quiz" size={15} /><span className="nb-quiz-tag mono">embedded check</span>
        {b.verify && <span className={"verify-badge " + b.verify}><Icon name={b.verify === "verified" ? "check" : "sparkle"} size={11} />{b.verify === "verified" ? "已校验" : "草稿"}</span>}
      </div>
      <div className="nb-quiz-q wenyan">{b.text}</div>
      {open ? (
        <div className="nb-quiz-a fade-key"><span className="cmp-label">答</span>{b.answer}</div>
      ) : (
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}><Icon name="eye" size={14} />显示答案</button>
      )}
    </div>
  );
}

function NoteBlock({ b, editable, onLink }) {
  const link = b.link ? (
    <button className="xlink mono" onClick={() => onLink && onLink(b.link)}><Icon name="link" size={11} />{b.link.label}</button>
  ) : null;
  switch (b.type) {
    case "h": return <h3 className="nb-h">{b.text}</h3>;
    case "p": return <p className="nb-p">{b.text} {link}</p>;
    case "wenyan": return <div className="nb-wenyan wenyan">{b.text}{link && <div className="nb-link-row">{link}</div>}</div>;
    case "latex": return <div className="nb-latex">{renderLatex(b.text)}</div>;
    case "code": return <pre className="nb-code"><span className="nb-code-lang mono">{b.lang}</span><code>{b.text}</code></pre>;
    case "callout": return <div className={"nb-callout tone-" + (b.tone || "info")}><Icon name="sparkle" size={15} /><div>{b.text}{b.verify && <span className={"verify-badge " + b.verify} style={{ marginLeft: 8 }}><Icon name="check" size={11} />{b.verify === "verified" ? "已校验" : "草稿"}</span>}</div></div>;
    case "quiz": return <QuizBlock b={b} editable={editable} />;
    case "divider": return <hr className="nb-hr" />;
    default: return <p className="nb-p">{b.text}</p>;
  }
}

const SLASH_TYPES = [
  { type: "h", label: "标题", icon: "hash" },
  { type: "p", label: "正文", icon: "list" },
  { type: "wenyan", label: "文言段", icon: "doc" },
  { type: "latex", label: "公式 LaTeX", icon: "fx" },
  { type: "code", label: "代码", icon: "slash" },
  { type: "quiz", label: "内嵌测验", icon: "quiz" },
  { type: "callout", label: "提示块", icon: "sparkle" },
];
// nesting rule: callout/quiz are leaf containers — slash menu inside them is blocked.
const NEST_BLOCKED = new Set(["callout", "quiz", "latex", "code"]);
// only these block types expose a drag handle (text-flow blocks); structural ones don't.
const DRAGGABLE = new Set(["h", "p", "wenyan", "code", "callout", "quiz"]);

function NoteEditor({ doc, editable = false, onLink, title }) {
  const [blocks, setBlocks] = React.useState(doc);
  const [slashAt, setSlashAt] = React.useState(null);   // index where slash menu is open
  const [dragIdx, setDragIdx] = React.useState(null);
  const [overIdx, setOverIdx] = React.useState(null);

  const insert = (i, type) => {
    const nb = { id: "n" + Date.now(), type, text: type === "h" ? "新标题" : type === "quiz" ? "新的测验题？" : type === "latex" ? "a^2 + b^2 = c^2" : type === "code" ? "// code" : "新块内容", lang: "js", answer: "参考答案", verify: "draft" };
    setBlocks((bs) => [...bs.slice(0, i + 1), nb, ...bs.slice(i + 1)]); setSlashAt(null);
  };
  const onDrop = (i) => {
    if (dragIdx == null || dragIdx === i) { setDragIdx(null); setOverIdx(null); return; }
    setBlocks((bs) => { const a = [...bs]; const [m] = a.splice(dragIdx, 1); a.splice(i, 0, m); return a; });
    setDragIdx(null); setOverIdx(null);
  };

  if (!editable) {
    return <div className="note-doc">{blocks.map((b) => <NoteBlock key={b.id} b={b} onLink={onLink} />)}</div>;
  }

  return (
    <div className="note-editor">
      {blocks.map((b, i) => {
        const canDrag = DRAGGABLE.has(b.type);
        const canNest = !NEST_BLOCKED.has(b.type);
        return (
          <div key={b.id}
            className={"nb-wrap" + (overIdx === i ? " is-over" : "") + (dragIdx === i ? " is-dragging" : "")}
            onDragOver={(e) => { if (dragIdx != null) { e.preventDefault(); setOverIdx(i); } }}
            onDrop={() => onDrop(i)}>
            <div className="nb-gutter">
              {canDrag ? (
                <button className="nb-grip" draggable title="拖拽重排"
                  onDragStart={() => setDragIdx(i)} onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}>
                  <Icon name="grip" size={14} />
                </button>
              ) : <span className="nb-grip nb-grip-off" title="该块不可拖拽" />}
              <button className="nb-plus" title={canNest ? "插入块 (/)" : "此块内不可嵌套"}
                disabled={!canNest} onClick={() => canNest && setSlashAt(slashAt === i ? null : i)}>
                <Icon name="slash" size={13} />
              </button>
            </div>
            <div className="nb-content"><NoteBlock b={b} editable onLink={onLink} /></div>
            {slashAt === i && canNest && (
              <div className="slash-menu fade-key">
                <div className="slash-head meta">插入块</div>
                {SLASH_TYPES.map((t) => (
                  <button key={t.type} className="slash-item" onClick={() => insert(i, t.type)}>
                    <Icon name={t.icon} size={15} /><span>{t.label}</span><span className="mono slash-key">/{t.type}</span>
                  </button>
                ))}
                <div className="slash-foot meta"><Icon name="link" size={11} /> 交叉链：在正文输入 @ 唤出节点选择器</div>
              </div>
            )}
          </div>
        );
      })}
      <button className="nb-add" onClick={() => setSlashAt(blocks.length - 1)}><Icon name="plus" size={14} />添加块</button>
    </div>
  );
}

window.NoteEditor = NoteEditor; window.renderLatex = renderLatex;
