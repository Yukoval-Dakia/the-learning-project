// Loom · /questions/[id] — full question detail + inline editor.
// Edit stem / options / answer / difficulty / knowledge; variant family;
// composite subquestions; association state; constraint-aware delete.

function QFigure({ figure }) {
  return (
    <div className="qd-figure">
      <div className="qd-figure-ico"><Icon name="image" size={24} /></div>
      <div>
        <div className="qd-figure-cap">{figure.caption}</div>
        <div className="qd-figure-sub">figure · 拖入图片替换 · OCR 可提取</div>
      </div>
    </div>
  );
}

function DeleteModal({ q, onClose, onConfirm }) {
  const a = qAssoc(q);
  const deletable = qDeletable(q);
  const [typed, setTyped] = React.useState("");
  const ref = React.useRef(null);
  useFocusTrap(true, onClose, ref);
  const constraints = [
    a.attempts && { n: a.attempts, label: "条作答记录（attempt 事件）" },
    a.review && { n: a.review, label: "张 FSRS 复习卡" },
    a.papers && { n: a.papers, label: "份试卷引用此题" },
    a.mistakes && { n: a.mistakes, label: "条错题归因记录" },
    a.children && { n: a.children, label: "道小题挂在此大题下" },
  ].filter(Boolean);
  const canDelete = deletable || typed.trim() === "删除";

  return ReactDOM.createPortal((
    <div className="qb-modal-wrap">
      <div className="scrim open" onClick={onClose} style={{ zIndex: 0 }} />
      <div className="qb-modal" ref={ref} role="dialog" aria-modal="true" aria-label="删除题目确认">
        <div className="qb-modal-head">
          <span className="qb-modal-ic"><Icon name="trash" size={18} /></span>
          <span className="qb-modal-title">删除此题？</span>
        </div>
        <div className="qb-modal-body">
          <div className="qb-modal-q"><QInline text={q.stem} /></div>
          {deletable ? (
            <>
              <p>此题没有任何关联记录，可以安全删除。</p>
              <div className="qb-modal-safe"><Icon name="check" size={15} />无 attempt / 复习卡 / 卷引用 / 错题 / 小题</div>
            </>
          ) : (
            <>
              <p>此题已被系统其他部分引用，删除会一并影响下列记录。事件日志为只读，删除将<strong>软删除题目并保留历史事件</strong>。</p>
              <div className="qb-constraints">
                {constraints.map((c, i) => (
                  <div key={i} className="qb-constraint"><Icon name="alert" size={14} /><span className="qb-c-n">{c.n}</span> {c.label}</div>
                ))}
              </div>
              <div className="qb-confirm-field">
                <div className="field-label">请输入「<strong>删除</strong>」以确认</div>
                <input className="qb-confirm-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="删除" autoFocus />
              </div>
            </>
          )}
        </div>
        <div className="qb-modal-foot">
          <Btn variant="ghost" onClick={onClose}>取消</Btn>
          <button className="btn btn-danger" disabled={!canDelete} onClick={onConfirm}>
            <Icon name="trash" size={15} />{deletable ? "删除" : "软删除并保留事件"}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}

function VariantFamily({ q, go }) {
  const fam = qFamily(q);
  if (!fam || (fam.variants.length === 0 && q.lineage !== "variant")) {
    return (
      <Card pad>
        <EmptyState icon="sparkle" title="尚无变体" text="让 AI 基于此题或它的错因生成同型变体，形成变体家族。"
          action={<Btn size="sm" variant="primary" icon="sparkle">生成变体</Btn>} />
      </Card>
    );
  }
  const Node = ({ node, variant }) => (
    <div className={"qd-fam-node" + (variant ? " variant" : "") + (node.id === q.id ? " is-current" : "")}>
      <span className="qd-fam-dot" />
      <button className="qd-fam-link" onClick={() => node.id !== q.id && go("questions/" + node.id)}>
        <div className="qd-fam-t"><QInline text={node.stem} /></div>
      </button>
      <span className="badge tone-neutral" style={{ flex: "none" }}>{QKIND[node.kind].label}</span>
      {node.id === q.id && <span className="qd-fam-cur">当前</span>}
    </div>
  );
  return (
    <Card pad>
      <Node node={fam.root} />
      {fam.variants.map((v) => <Node key={v.id} node={v} variant />)}
      <div style={{ marginTop: "var(--s-3)", display: "flex", justifyContent: "center" }}>
        <Btn size="sm" variant="ghost" icon="sparkle">再生成一个变体</Btn>
      </div>
    </Card>
  );
}

function ScreenQuestionDetail({ go, param, ui = {} }) {
  const base = qById(param) || DATA.questions[0];
  const [q, setQ] = React.useState(base);
  const [dirty, setDirty] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [del, setDel] = React.useState(false);
  const [editOptIdx, setEditOptIdx] = React.useState(-1);
  React.useEffect(() => { const f = qById(param) || base; setQ(f); setDirty(false); setSaved(false); setEditOptIdx(-1); }, [param]);

  const edit = (patch) => { setQ((x) => ({ ...x, ...patch })); setDirty(true); setSaved(false); };
  const editOpt = (i, text) => edit({ options: q.options.map((o, j) => j === i ? { ...o, text } : o) });
  const save = () => { const idx = DATA.questions.findIndex((x) => x.id === q.id); if (idx >= 0) DATA.questions[idx] = q; setDirty(false); setSaved(true); };
  const doDelete = () => { const i = DATA.questions.findIndex((x) => x.id === q.id); if (i >= 0) DATA.questions.splice(i, 1); setDel(false); go(q.parentId ? "questions/" + q.parentId : "questions"); };

  const a = qAssoc(q);
  const parent = q.parentId ? qById(q.parentId) : null;
  const kids = q.composite ? qChildren(q) : [];
  const created = q.created.replace(/-/g, " / ");

  return (
    <div className="page view">
      <button className="back-link" onClick={() => go("questions")}><Icon name="arrowL" size={14} />题库</button>

      <div className="page-head">
        <div className="eyebrow">QUESTION · {q.id} · {QKIND[q.kind].label} · {QSOURCE[q.source].label}</div>
        <div className="page-head-row">
          <div className="qd-head-meta">
            <Badge tone={QSTATUS[q.status].tone}>{QSTATUS[q.status].label}</Badge>
            {q.composite && <Badge tone="info"><Icon name="layers" size={12} />大题 · {kids.length} 小题</Badge>}
            {q.lineage === "variant" && <Badge tone="info"><Icon name="sparkle" size={12} />AI 变体 · 深度 {q.depth}</Badge>}
            {q.lineage === "root" && (q.variants || []).length > 0 && <Badge tone="coral"><Icon name="sparkle" size={12} />母题 · {q.variants.length} 变体</Badge>}
            <QDiffPips d={q.difficulty} />
          </div>
          <div className="hero-cta">
            {saved && <span className="meta" style={{ color: "var(--good-ink)", display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="check" size={14} />已保存</span>}
            <Btn variant={dirty ? "primary" : "secondary"} icon="check" onClick={save} disabled={!dirty}>保存修改</Btn>
          </div>
        </div>
      </div>

      {parent && (
        <button className="qd-sub" style={{ marginBottom: "var(--s-4)" }} onClick={() => go("questions/" + parent.id)}>
          <span className="qd-sub-idx"><Icon name="arrowL" size={13} /></span>
          <span className="qd-sub-body"><span className="meta">所属大题 · 第 {q.subIndex} 小题</span><div className="qd-sub-stem"><QInline text={parent.stem} /></div></span>
          <Icon name="arrow" size={14} className="thread-arrow" />
        </button>
      )}

      <div className="kd-grid">
        <div className="kd-main">
          {/* passage (composite) */}
          {q.composite && (
            <div className="qd-sec">
              <div className="qd-sec-h"><Icon name="book" size={14} />阅读材料 passage</div>
              <textarea className="qd-textarea" value={q.passage} onChange={(e) => edit({ passage: e.target.value })} rows={4} />
              {qHasMarkup(q.passage) && <div className="qd-passage" style={{ marginTop: "var(--s-3)" }}><QMarkdown text={q.passage} /></div>}
            </div>
          )}

          {/* stem */}
          <div className="qd-sec">
            <div className="qd-sec-h"><Icon name="quiz" size={14} />题面 stem · Markdown + LaTeX</div>
            <div className="qd-edit">
              <textarea className="qd-textarea" value={q.stem} onChange={(e) => edit({ stem: e.target.value })} rows={q.composite ? 2 : 4} />
              {qHasMarkup(q.stem) && (
                <div className="qd-preview">
                  <div className="qd-preview-tag"><Icon name="eye" size={12} />预览 · 含公式 / 格式</div>
                  <QMarkdown text={q.stem} className="wenyan" />
                </div>
              )}
            </div>
            {q.image && <div style={{ marginTop: "var(--s-3)" }}><QFigure figure={q.image} /></div>}
          </div>

          {/* options (mcq) */}
          {q.kind === "mcq" && q.options.length > 0 && (
            <div className="qd-sec">
              <div className="qd-sec-h"><Icon name="list" size={14} />选项 · 点击字母设为正确答案
                <Btn size="sm" variant="ghost" icon="plus" className="qd-sec-act">添加选项</Btn></div>
              <div className="qd-opts">
                {q.options.map((o, i) => (
                  <div key={o.key} className={"qd-opt" + (q.answer === o.key ? " correct" : "")}>
                    <button className="qd-opt-key" onClick={() => edit({ answer: o.key })} title="设为正确答案">{o.key}</button>
                    {editOptIdx === i ? (
                      <input className="qd-opt-text" autoFocus value={o.text} onChange={(e) => editOpt(i, e.target.value)}
                        onBlur={() => setEditOptIdx(-1)} onKeyDown={(e) => { if (e.key === "Enter") setEditOptIdx(-1); }}
                        style={{ borderBottom: "1px solid var(--coral-line)" }} />
                    ) : (
                      <div className="qd-opt-text" onClick={() => setEditOptIdx(i)} title="点击编辑" style={{ cursor: "text" }}>
                        <QInline text={o.text} />
                      </div>
                    )}
                    {q.answer === o.key && <span className="qd-opt-correct-tag"><Icon name="check" size={12} />正确</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* answer */}
          {!q.composite && (
          <div className="qd-sec">
            <div className="qd-sec-h"><Icon name="checkCircle" size={14} />参考答案</div>
            <textarea className="qd-textarea" value={q.answer} onChange={(e) => edit({ answer: e.target.value })} rows={2} style={{ marginBottom: "var(--s-3)" }} />
            {(qHasMarkup(q.answer) || q.answerNote) && (
              <div className="qd-answer">
                {qHasMarkup(q.answer) && <QMarkdown text={q.answer} />}
                {q.answerNote && <div className={"qd-note" + (qHasMarkup(q.answer) ? "" : " qd-note-bare")}><Icon name="sparkle" size={12} style={{ verticalAlign: -2, marginRight: 4, color: "var(--coral)" }} /><QInline text={q.answerNote} /></div>}
              </div>
            )}
          </div>
          )}

          {/* composite subquestions */}
          {q.composite && (
            <div className="qd-sec">
              <div className="qd-sec-h"><Icon name="layers" size={14} />小题 · {kids.length} 道
                <Btn size="sm" variant="ghost" icon="plus" className="qd-sec-act">添加小题</Btn></div>
              <div className="qd-subs">
                {kids.map((c) => (
                  <button key={c.id} className="qd-sub" onClick={() => go("questions/" + c.id)}>
                    <span className="qd-sub-idx">{c.subIndex}</span>
                    <span className="qd-sub-body">
                      <div className="qd-sub-stem"><QInline text={c.stem} /></div>
                      <div className="qd-sub-meta"><span className="badge tone-neutral">{QKIND[c.kind].label}</span><Badge tone={QSTATUS[c.status].tone}>{QSTATUS[c.status].label}</Badge>{c.attempts > 0 && <span className="meta mono">做过 {c.attempts}</span>}</div>
                    </span>
                    <Icon name="arrow" size={14} className="thread-arrow" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* variant family */}
          {!q.parentId && (
            <div className="qd-sec">
              <div className="qd-sec-h"><Icon name="sparkle" size={14} />变体家族 lineage</div>
              {q.origin && (
                <div className="qd-note" style={{ border: 0, marginBottom: "var(--s-2)", paddingTop: 0, color: "var(--ink-3)" }}>
                  <span className="ai-tag" style={{ marginRight: 6 }}><Icon name="sparkle" size={11} />AI</span>
                  {q.origin.reason} · 置信度 {Math.round(q.origin.confidence * 100)}% · {q.origin.when}
                </div>
              )}
              <VariantFamily q={q} go={go} />
            </div>
          )}
        </div>

        {/* side rail */}
        <div className="kd-side qd-side">
          <div className="qd-sec-h"><Icon name="settings" size={14} />属性</div>
          <Card pad>
            <div className="qd-prop">
              <div className="qd-prop-l">题型</div>
              <select className="field-input" value={q.kind} onChange={(e) => edit({ kind: e.target.value })} style={{ width: "100%" }}>
                {Object.entries(QKIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">状态</div>
              <div className="seg seg-sm">
                {[["active", "正式"], ["draft", "草稿"]].map(([s, l]) => (
                  <button key={s} className={q.status === s ? "on" : ""} onClick={() => edit({ status: s })}>{l}</button>
                ))}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">难度 1–5</div>
              <div className="qd-diffset">
                {[1, 2, 3, 4, 5].map((d) => <button key={d} className={q.difficulty === d ? "on" : ""} onClick={() => edit({ difficulty: d })}>{d}</button>)}
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">知识点 <span className="meta">· 关联知识图谱</span></div>
              <div className="qd-chipset">
                {q.knowledge.map((k) => (
                  <button key={k} className="qd-chip" onClick={() => go("knowledge/" + k)}>{qkLabel(k)}<Icon name="close" size={11} onClick={(e) => { e.stopPropagation(); edit({ knowledge: q.knowledge.filter((x) => x !== k) }); }} /></button>
                ))}
                <button className="qd-chip qd-chip-add"><Icon name="plus" size={11} />添加</button>
              </div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">来源</div>
              <div className="qd-prop-val"><Icon name={QSOURCE[q.source].icon} size={15} />{QSOURCE[q.source].label}</div>
            </div>
            <div className="qd-prop">
              <div className="qd-prop-l">创建时间</div>
              <div className="qd-prop-time">{created}</div>
            </div>
          </Card>

          <div className="qd-sec-h" style={{ marginTop: "var(--s-4)" }}><Icon name="link" size={14} />关联状态</div>
          <Card pad>
            <div className="qd-assoc">
              <div className="qd-assoc-cell"><span className={"qd-assoc-n" + (a.attempts ? " hot" : "")}>{a.attempts}</span><span className="qd-assoc-l">作答次数</span></div>
              <div className="qd-assoc-cell"><span className="qd-assoc-n">{a.review}</span><span className="qd-assoc-l">复习卡</span></div>
              <div className="qd-assoc-cell"><span className={"qd-assoc-n" + (a.mistakes ? " hot" : "")}>{a.mistakes}</span><span className="qd-assoc-l">错题记录</span></div>
              <div className="qd-assoc-cell"><span className="qd-assoc-n">{a.papers}</span><span className="qd-assoc-l">卷引用</span></div>
            </div>
            {(q.papers || []).length > 0 && (
              <div className="qd-paperlist">
                {q.papers.map((p) => (
                  <div key={p.id} className="qd-paperrow"><Icon name="doc" size={13} />{p.name}</div>
                ))}
              </div>
            )}
            {a.review > 0 && <Btn size="sm" variant="ghost" icon="review" block onClick={() => go("review")} style={{ marginTop: "var(--s-3)" }}>去复习此题</Btn>}
          </Card>

          <div className="qd-sec-h" style={{ marginTop: "var(--s-4)", color: "var(--again-ink)" }}><Icon name="trash" size={14} />删除</div>
          <Card pad className="qd-danger">
            <div className="meta" style={{ marginBottom: "var(--s-3)", lineHeight: "var(--lh-prose)" }}>
              {qDeletable(q) ? "此题无关联记录，可直接删除。" : `此题有 ${a.attempts + a.review + a.papers + a.mistakes + a.children} 条关联记录，删除需确认。`}
            </div>
            <Btn size="sm" variant="secondary" icon="trash" block onClick={() => setDel(true)}>删除题目…</Btn>
          </Card>
        </div>
      </div>

      {del && <DeleteModal q={q} onClose={() => setDel(false)} onConfirm={doDelete} />}
    </div>
  );
}
window.ScreenQuestionDetail = ScreenQuestionDetail;
