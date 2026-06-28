// Loom · A3 单编排者对话 — PR/checkpoint · proactive · durable run · 故障态.
// 可否决性必须可达: keep(默认) / revert 整 PR / cherry-pick 单条.
// user_verified 改动: 强制高亮 + 默认不勾(要用户主动勾才包含).

// ── per-utterance checkpoint PR ─────────────────────────────
function PrCard({ pr }) {
  const [diffs, setDiffs] = React.useState(pr.diffs);
  const [resolved, setResolved] = React.useState(null);
  const toggle = (id) => setDiffs((ds) => ds.map((d) => d.id === id ? { ...d, checked: !d.checked } : d));
  const kept = diffs.filter((d) => d.checked).length;
  const hasVerified = diffs.some((d) => d.verified);

  if (resolved === "revert") {
    return <div className="pr-card"><div className="pr-resolved reverted"><Icon name="undo" size={15} />已撤销整个改动 —— 全部回到我开口之前。要我换个方向重做吗？</div></div>;
  }
  if (resolved === "keep") {
    return <div className="pr-card"><div className="pr-resolved kept"><Icon name="check" size={15} />已采纳 {kept} 条改动{kept < diffs.length ? `，留下 ${diffs.length - kept} 条没动` : ""}。写入事件链，可随时在事件面回滚。</div></div>;
  }

  return (
    <div className="pr-card">
      <div className="pr-head">
        <Icon name="merge" size={16} />
        <div className="pr-head-main">
          <span className="pr-badge">checkpoint · 一句话 = 一个可审的改动</span>
          <div className="pr-summary">{pr.summary}</div>
        </div>
      </div>
      <div className="pr-meta">
        <span>{pr.posture}</span><span className="dot">·</span>
        <span>{pr.steps} 步</span><span className="dot">·</span>
        <span>{pr.model}</span><span className="dot">·</span>
        <span>${pr.cost.toFixed(3)}</span>
      </div>
      <div className="pr-diffs">
        {diffs.map((d) => (
          <div key={d.id} className={"pr-diff" + (d.verified ? " verified" : "")}>
            <button className={"pr-check" + (d.checked ? " on" : "")} onClick={() => toggle(d.id)}
              aria-pressed={d.checked} aria-label={(d.checked ? "已选" : "未选") + "：" + d.text}>
              <Icon name="check" size={12} />
            </button>
            <span className={"pr-op " + d.op}>{d.op === "add" ? "+" : "~"}</span>
            <div className="pr-diff-body">
              <div className="pr-diff-text">{d.text}<span className="kindtag">{(KIND_META[d.kind] || {}).label || d.kind}</span></div>
              <div className="pr-diff-detail">{d.detail}</div>
              {d.verified && <span className="pr-verified-flag"><Icon name="lock" size={11} />碰到你已验证的内容 · 默认不动，要改请主动勾选</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="pr-foot">
        <span className="pr-foot-hint">{hasVerified ? "已验证项默认排除" : "默认全采纳"} · 取消勾选即 cherry-pick</span>
        <button className="pr-btn" onClick={() => setResolved("revert")}><Icon name="undo" size={13} />撤销整个</button>
        <button className="pr-btn primary" onClick={() => setResolved("keep")}><Icon name="check" size={13} />采纳 {kept} 条</button>
      </div>
    </div>
  );
}

// ── proactive nudge ─────────────────────────────────────────
function ProactiveNudge({ data, onAct, onDismiss }) {
  return (
    <div className="proactive">
      <Icon name="sparkle" size={15} />
      <div className="proactive-body">
        <span className="proactive-trigger">{data.trigger} · 主动开口</span>
        <div className="proactive-text">{data.text}</div>
        <div className="proactive-acts">
          <button className="pr-btn primary" onClick={onAct}><Icon name="check" size={13} />好，来吧</button>
          <button className="pr-btn" onClick={onDismiss}>先不用</button>
        </div>
      </div>
      <button className="proactive-dismiss" onClick={onDismiss} aria-label="忽略"><Icon name="close" size={14} /></button>
    </div>
  );
}

// ── durable run progress (reconnect/replay) ─────────────────
function RunCard({ run }) {
  return (
    <div className="run-card">
      <div className="run-head">
        <Icon name="refresh" size={15} />
        <span className="run-title">{run.title}</span>
        <span className="run-posture">{run.posture}</span>
      </div>
      <div className="run-steps">
        {run.steps.map((s, i) => (
          <div key={i} className={"run-step " + s.state}>
            <span className="run-step-dot">
              {s.state === "done" ? <Icon name="check" size={12} /> : s.state === "running" ? <span className="run-spin" /> : <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ink-5)" }} />}
            </span>
            <span className="run-step-label">{s.label}</span>
          </div>
        ))}
      </div>
      <div className="run-note"><Icon name="clock" size={13} />{run.note}</div>
    </div>
  );
}

// ── failure states ──────────────────────────────────────────
function CopFail({ kind, onRetry }) {
  if (kind === "partial") {
    return (
      <div className="cop-fail partial">
        <div className="cop-fail-partial-text">{COPILOT_A3.partial}</div>
        <div className="cop-fail-row">
          <span className="cop-fail-tag"><Icon name="alert" size={12} />回复没说完 · 连接中断</span>
          <span className="cop-fail-msg" style={{ color: "var(--ink-3)" }}>已出的内容给你留着了。</span>
          <button className="pr-btn primary" style={{ marginLeft: "auto" }} onClick={onRetry}><Icon name="refresh" size={13} />接着说完</button>
        </div>
      </div>
    );
  }
  if (kind === "toolfail") {
    return (
      <div className="cop-fail toolfail">
        <div className="cop-fail-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
          <span className="cop-fail-tag"><Icon name="alert" size={12} />工具没跑成</span>
          <span className="cop-fail-msg">出题工具这一步失败了 —— 我没能生成那 2 张卡。不是装作好了，是真没做成。</span>
        </div>
        <div className="cop-fail-row">
          <button className="pr-btn primary" onClick={onRetry}><Icon name="refresh" size={13} />重试这一步</button>
          <button className="pr-btn">换个方式</button>
        </div>
      </div>
    );
  }
  // empty reply
  return (
    <div className="cop-fail empty">
      <div className="cop-fail-msg"><Icon name="eye" size={15} />我没能给出有把握的回答 —— 这块证据不足，与其编一个，不如如实说我不确定。要不要我先去查一下？</div>
    </div>
  );
}

Object.assign(window, { PrCard, ProactiveNudge, RunCard, CopFail });
