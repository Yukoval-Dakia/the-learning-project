// Loom · 练习面 — 散题作答态.
// 即时反馈（§6.4 着色即判定）· 评级建议可改 · 不服判（异步重判，不阻塞流）·
// 解题会话（苏格拉底分级提示，永不直接给答案，可提交手写图）.

function PfaceSolo({ item, q, pos, total, appeal, onAppeal, onDone, onBack, addToast }) {
  const [phase, setPhase] = React.useState("answering");
  const [sel, setSel] = React.useState(null);
  const [text, setText] = React.useState("");
  const [attach, setAttach] = React.useState(false);
  const [verdict, setVerdict] = React.useState(null);
  const [rating, setRating] = React.useState(null);
  const [appealOpen, setAppealOpen] = React.useState(false);
  const [appealText, setAppealText] = React.useState("");
  const [coach, setCoach] = React.useState(false);

  // 不服判改判后：判定与建议联动上调
  const resolved = appeal === "resolved" && q.appealReply;
  const effVerdict = resolved ? "good" : verdict;

  React.useEffect(() => {
    // 改判回来时，若用户尚未确认评级，把建议同步上调
    if (resolved && phase === "feedback") setRating((r) => (r === "hard" ? "good" : r));
  }, [resolved]);

  const canSubmit = q.type === "choice" ? sel != null : (text.trim().length > 0 || attach);
  const submit = () => {
    if (!canSubmit || phase !== "answering") return;
    const v = q.type === "choice" ? (sel === q.correct ? "good" : "again") : (q.cannedVerdict || "good");
    setVerdict(v);
    setRating(q.advice && q.advice[v] || v);
    setPhase("feedback");
  };

  // 键盘：1-4 选项 · ⌘/Ctrl+Enter 提交
  React.useEffect(() => {
    const onKey = (e) => {
      if (phase !== "answering" || coach) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); return; }
      if (q.type === "choice" && /^[1-4]$/.test(e.key) && e.target.tagName !== "TEXTAREA") {
        setSel(Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, q, sel, text, attach, coach]);

  const fbText = verdict && q.fb && (q.fb[verdict] || q.fb.good || q.fb.again);

  return (
    <div className="pfs view" data-screen-label={"散题作答 · " + item.ref}>
      <div className="pfs-top">
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={onBack}>返回流</Btn>
        <span className="pfs-pos">流 · 第 {pos} / {total} 项</span>
        <PfSrcBadge source={item.source} />
        <span className="topbar-spacer" />
        <Btn size="sm" variant="secondary" icon="teach" onClick={() => setCoach(true)}>卡住了？解题会话</Btn>
      </div>

      <Card pad padLg>
        <div className="nowrap-meta" style={{ marginBottom: "var(--s-2)" }}>
          <span className="chip chip-k">{q.kp}</span>
          <span className="meta mono">{item.ref}</span>
        </div>

        <div className="pfs-stem">{q.stem}</div>
        {q.passage && (
          <div className="pfs-passage wenyan">{q.passage}
            {q.passageSrc && <span className="pfs-passage-src">{q.passageSrc}</span>}
          </div>
        )}

        {q.type === "choice" ? (
          <div className="pfs-opts" role="radiogroup" aria-label="选项">
            {q.options.map((o, i) => {
              const graded = phase === "feedback";
              const cls = ["pfs-opt",
                !graded && sel === i ? "is-sel" : "",
                graded && i === q.correct ? "is-right" : "",
                graded && sel === i && i !== q.correct ? "is-wrong" : ""].join(" ");
              return (
                <button key={o.k} className={cls} disabled={graded} role="radio" aria-checked={sel === i}
                  onClick={() => setSel(i)}>
                  <span className="k mono">{o.k}</span>
                  <span className="t">{o.text}</span>
                  {o.note && <span className="n">{o.note}</span>}
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ marginTop: "var(--s-5)" }}>
            <div className="composer answer-composer">
              <textarea rows={3} value={text} disabled={phase === "feedback"}
                placeholder="写下你的译文——也可以拍手写稿上传。"
                onChange={(e) => setText(e.target.value)} aria-label="作答" />
            </div>
          </div>
        )}

        {phase === "answering" && (
          <div className="pfs-actions">
            <Btn variant="primary" icon="check" onClick={submit} disabled={!canSubmit}>提交 · 即时判分</Btn>
            {q.type === "text" && (attach
              ? <span className="pfs-attach"><img src="uploads/draw-7cafddab-274d-4a3a-b03e-a722036e1a59.png" alt="手写稿" /><Icon name="check" size={13} />手写稿已附</span>
              : <Btn variant="ghost" icon="camera" onClick={() => setAttach(true)}>拍照上传手写</Btn>)}
            <span className="key-hints mono" style={{ marginLeft: "auto" }}>{q.type === "choice" ? "1-4 选 · ⌘Enter 提交" : "⌘Enter 提交"}</span>
          </div>
        )}

        {/* ── 即时反馈 ── */}
        {phase === "feedback" && (
          <div className={"pfs-fb v-" + effVerdict}>
            <div className="pfs-fb-head">
              <span className={"badge tone-" + PF_VERDICT[effVerdict].tone}><Icon name={effVerdict === "good" ? "check" : effVerdict === "again" ? "close" : "minus"} size={12} />{PF_VERDICT[effVerdict].label}</span>
              {resolved && <span className="badge tone-info"><Icon name="review" size={11} />已改判</span>}
              <span className="ai-tag"><Icon name="sparkle" size={12} />AI 判定</span>
              <span className="pfs-fb-meta">judge · Haiku · $0.004 · 1.2s</span>
            </div>
            <p className="pfs-fb-text">{fbText}</p>
            {q.reference && (
              <div className="pfs-fb-ref"><span className="cmp-label">参考</span>{q.reference}</div>
            )}

            {/* 评级建议 — 用户可改 */}
            <div className="pfs-rate">
              <span className="pfs-rate-label">评级</span>
              {[["again", "再练"], ["hard", "模糊"], ["good", "掌握"]].map(([g, label]) => (
                <button key={g} className={"pfs-rate-btn t-" + g + (rating === g ? " on" : "")} onClick={() => setRating(g)}>{label}</button>
              ))}
              <span className="pfs-rate-advised">建议：{{ again: "再练", hard: "模糊", good: "掌握" }[(q.advice && q.advice[effVerdict]) || effVerdict]}{resolved ? " · 重判后上调" : ""}</span>
            </div>

            {/* 改判回执 */}
            {resolved && (
              <div className="pfs-appeal-reply"><Icon name="review" size={14} /><span>{q.appealReply}<span className="pfs-fb-meta" style={{ display: "block", marginTop: 4, marginLeft: 0 }}>re-judge · Sonnet · $0.021 · 6.2s</span></span></div>
            )}

            <div className="pfs-fb-foot">
              <Btn variant="primary" icon="arrow" onClick={() => onDone(effVerdict)}>确认评级 · 下一项</Btn>

              {appeal === "pending" ? (
                <span className="badge tone-info"><span className="dot pulse" />重判中 · 不阻塞，先继续</span>
              ) : !resolved && (
                appealOpen ? null : <button className="pfs-appeal-link" onClick={() => setAppealOpen(true)}>不服判？附理由重判</button>
              )}
            </div>

            {/* 不服判表单 */}
            {appealOpen && appeal == null && !resolved && (
              <div className="pfs-appeal">
                <div className="composer">
                  <textarea rows={2} value={appealText}
                    placeholder="说说为什么——比如「我写的『觉得我美』就是意动」"
                    onChange={(e) => setAppealText(e.target.value)} aria-label="不服判理由" />
                </div>
                <div className="pfs-actions" style={{ marginTop: "var(--s-3)" }}>
                  <Btn size="sm" variant="secondary" icon="send" disabled={!appealText.trim()}
                    onClick={() => { onAppeal(); setAppealOpen(false); addToast("已提交重判——异步跑，结果回来我会提醒你。", "info", "clock"); }}>
                    提交重判
                  </Btn>
                  <Btn size="sm" variant="ghost" onClick={() => setAppealOpen(false)}>算了</Btn>
                  <span className="key-hints mono" style={{ marginLeft: "auto" }}>re-judge · Sonnet · ~$0.02</span>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <PfaceCoach open={coach} onClose={() => setCoach(false)} q={q} />
    </div>
  );
}

/* ── 解题会话 — 苏格拉底分级提示 ── */
function PfaceCoach({ open, onClose, q }) {
  const [shown, setShown] = React.useState(1);
  const [msgs, setMsgs] = React.useState([]); // {who:'user'|'ai', text, img}
  const [draft, setDraft] = React.useState("");
  const [replied, setReplied] = React.useState(false);
  const panelRef = React.useRef(null);
  useFocusTrap(open, onClose, panelRef);

  React.useEffect(() => { if (!open) { setShown(1); setMsgs([]); setDraft(""); setReplied(false); } }, [open, q]);

  const hints = q.hints || [];
  const send = (img) => {
    const t = draft.trim();
    if (!t && !img) return;
    setMsgs((m) => [...m, { who: "user", text: img ? (t || "（手写演算）") : t, img }]);
    setDraft("");
    setTimeout(() => {
      setMsgs((m) => [...m, { who: "ai", text: img
        ? "看到了。你列的语序还原到第二步都对——卡在第三步：先别动那个动词，把句子里的代词圈出来，再想它该站哪。"
        : "先不直接回答。换个问法：把这句话的主语和谓语各自指出来，你卡的地方就会自己松动。" }]);
      setReplied(true);
    }, 900);
  };

  return ReactDOM.createPortal(
    <React.Fragment>
      {open && <div className="scrim open" style={{ zIndex: 35 }} onClick={onClose} />}
      <aside className={"pfs-coach" + (open ? " open" : "")} ref={panelRef} role="dialog" aria-label="解题会话" aria-hidden={!open}>
        <div className="pfs-coach-head">
          <span className="ai-tag"><Icon name="teach" size={13} />解题会话</span>
          <span className="meta mono">socratic · 不给答案</span>
          <span className="topbar-spacer" />
          <IconBtn icon="close" size={16} title="关闭" onClick={onClose} />
        </div>
        <div className="pfs-coach-body">
          <p className="pfs-coach-note">我不会直接给答案——一级一级来，每级提示更近一步。会话不计入判分。</p>
          {hints.slice(0, shown).map((h, i) => (
            <div key={i} className="pfs-hint">
              <span className="pfs-hint-k">提示 {i + 1} / {hints.length}</span>
              {h}
            </div>
          ))}
          {shown < hints.length && (
            <Btn size="sm" variant="secondary" icon="chevronDown" onClick={() => setShown((s) => s + 1)}>
              再提示一点 · {shown + 1}/{hints.length}
            </Btn>
          )}
          {shown >= hints.length && msgs.length === 0 && (
            <p className="pfs-coach-note">提示用完了。再卡的话，把你的演算写下来或拍给我——我看了再说。</p>
          )}
          {msgs.map((m, i) => m.who === "user" ? (
            <div key={i} className="pfs-user-msg">{m.text}{m.img && <img src={m.img} alt="手写演算" />}</div>
          ) : (
            <div key={i} className="pfs-hint"><span className="pfs-hint-k">coach · Haiku · $0.003</span>{m.text}</div>
          ))}
        </div>
        <div className="pfs-coach-foot">
          <div className="composer">
            <textarea rows={1} value={draft} disabled={replied}
              placeholder={replied ? "原型演示到这一级。" : "说说你卡在哪…"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              aria-label="解题会话输入" />
            <IconBtn icon="camera" size={16} title="拍手写稿" onClick={() => !replied && send("uploads/draw-de300814-8921-42c5-b531-f52e26531fe8.png")} />
            <IconBtn icon="send" size={16} title="发送" onClick={() => send()} />
          </div>
        </div>
      </aside>
    </React.Fragment>,
    document.body
  );
}

window.PfaceSolo = PfaceSolo;
window.PfaceCoach = PfaceCoach;
