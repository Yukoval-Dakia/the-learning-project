// Loom · A4 读 vs 判 — inbox 三档 components.
// A 自动+撤销窗口 · B 逐条人审(复用 ProposalCard) · C 纯状态移出队列.

// ── A 档 · 一条已静默应用的卡(撤销窗口 + 熔断绕过人审 → 撤销必须始终可达) ──
function AutoAppliedCard({ item }) {
  const meta = KIND_META[item.kind] || { label: item.kind, icon: "check" };
  const [trace, setTrace] = React.useState(false);
  const [reverted, setReverted] = React.useState(false);
  const consumed = item.state === "consumed";
  return (
    <div className={"aa-card " + (reverted ? "reverted" : item.state)}>
      <span className="aa-ic"><Icon name={consumed ? "lock" : meta.icon} size={16} /></span>
      <div className="aa-body">
        <div className="aa-top">
          <span className="aa-kind">{meta.label}</span>
          <span className="aa-title">{item.title}</span>
        </div>
        <p className="aa-text">{item.body}</p>
        {trace && (
          <div className="aa-trace">
            来自 <b>{item.trace.posture}</b> · {item.reversible} · event：
            {item.trace.events.map((e) => <code key={e} className="evt">{e}</code>)}
            <br />{item.trace.note}
          </div>
        )}
        <div className="aa-foot">
          {reverted ? (
            <span className="aa-window"><Icon name="undo" size={13} />已撤销 · 恢复到应用前</span>
          ) : (
            <React.Fragment>
              <span className={"aa-window " + item.state}>
                <Icon name={consumed ? "alert" : "clock"} size={13} />{item.window}
              </span>
              <button className="aa-revert" disabled={consumed} onClick={() => setReverted(true)}>
                <Icon name="undo" size={13} />{consumed ? "已无法干净撤销" : "撤销"}
              </button>
            </React.Fragment>
          )}
          <button className="ho-linkbtn" onClick={() => setTrace((v) => !v)} style={{ marginLeft: "auto" }}>
            <Icon name="history" size={13} />追溯
          </button>
        </div>
      </div>
    </div>
  );
}

function TierABlock({ items }) {
  const b = INBOX_A4.breaker;
  return (
    <React.Fragment>
      <div className="aa-banner">
        <Icon name="bolt" size={18} />
        <div className="aa-banner-txt">
          <b>这些已经替你做了。</b>都是安全可逆的小操作，没占用你的裁决队列 —— 不放心的，窗口内一键撤回即可。
        </div>
      </div>
      <div className={"aa-breaker " + (b.tripped ? "tripped" : "ok")}>
        <Icon name={b.tripped ? "alert" : "check"} size={16} />
        <div className="aa-breaker-txt">
          {b.tripped
            ? <React.Fragment><b>自动应用已暂停。</b>{b.window}内自动操作触顶（{b.applied}/{b.cap}），为防失控已退回全人审 —— 下面的项需要你逐条确认。</React.Fragment>
            : <React.Fragment><b>自动通道正常。</b>{b.note}</React.Fragment>}
          <div className="aa-breaker-meter">
            <span className="aa-breaker-track"><span className="aa-breaker-fill" style={{ width: Math.min(100, b.applied / b.cap * 100) + "%" }} /></span>
            {b.applied} / {b.cap} · {b.window}
          </div>
        </div>
      </div>
      {items.map((it) => <AutoAppliedCard key={it.id} item={it} />)}
    </React.Fragment>
  );
}

// ── C 档 · 纯状态,移出裁决面(展示去向,可回看,不要求裁决) ──
function TierCBlock({ items, go, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={"co-fold" + (open ? " open" : "")}>
      <button className="co-bar" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="ec-ic"><Icon name="archive" size={16} /></span>
        <span>
          <span className="co-t">{items.length} 项纯状态变更已自动处理</span>
          <span className="co-s">{open ? "snooze / 软归档 / 移到旁观 —— 都没占你的裁决队列" : "展开看它们去哪了 · 不需要你裁决"}</span>
        </span>
        <Icon name="chevronDown" size={18} className="co-chev" />
      </button>
      {open && (
        <div className="co-body">
          {items.map((it) => {
            const meta = KIND_META[it.kind] || { label: it.kind, icon: "archive" };
            return (
              <div key={it.id} className="co-row">
                <span className="co-row-ic"><Icon name={it.kind === "defer" ? "clock" : it.kind === "judge_retraction" ? "eye" : "archive"} size={14} /></span>
                <div className="co-row-body">
                  <div className="co-row-top">
                    <span className="co-row-title">{it.title}</span>
                    <span className="co-row-act">{it.action}</span>
                  </div>
                  <div className="co-row-text">{it.body}</div>
                </div>
              </div>
            );
          })}
          <button className="ho-linkbtn" onClick={() => go("agent-notes")} style={{ alignSelf: "flex-start" }}>
            <Icon name="eye" size={14} />去 AI 观察面回看
          </button>
        </div>
      )}
    </div>
  );
}

function TierHead({ tier, count }) {
  const m = TIER_META[tier];
  return (
    <div className="tier-head">
      <span className={"tier-no tone-" + m.tone}>{tier}</span>
      <div className="tier-head-txt">
        <div className="tier-title">{m.label}<span className="tier-count">· {count} 项</span></div>
        <div className="tier-sub">{m.sub}</div>
      </div>
    </div>
  );
}

Object.assign(window, { AutoAppliedCard, TierABlock, TierCBlock, TierHead });
