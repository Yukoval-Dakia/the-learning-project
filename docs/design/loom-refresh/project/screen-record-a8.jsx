// Loom · A8 录入出口叙事 + rescue 失败 + 边缘退化态.
// 原始素材可见留存 · 录入产物可追溯 · 诚实优先于隐藏.

// 原始素材留存条(任何降级/失败都能回到原图重来)
function OriginalChip() {
  const o = RECORD_A8.original;
  return (
    <div className="ing-original">
      <Icon name="doc" size={14} />
      <span><b>{o.name}</b> · {o.pages} 页 · {o.kind}</span>
      <span className="keep"><Icon name="check" size={12} />原件已留存 · 可重来</span>
    </div>
  );
}

// 边缘退化态 banner(诚实标记)
function DegradeBanner({ icon = "alert", children, action }) {
  return (
    <div className="ing-degrade warn">
      <Icon name={icon} size={15} />
      <div className="ing-degrade-txt">{children}</div>
      {action && <span className="ing-degrade-act">{action}</span>}
    </div>
  );
}

// 进行中 · 全程进度可见 · 可真取消 · 可重连重放
function IngestProgress({ steps, onCancel, cancelled, note }) {
  if (cancelled) {
    return (
      <div className="ing-progress">
        <div className="ing-cancelled">
          <Icon name="check" size={16} style={{ color: "var(--good-ink)", flex: "none", marginTop: 1 }} />
          <div className="ing-degrade-txt" style={{ color: "var(--ink-2)" }}>
            已真正取消 —— 后台任务已停，不是假装。原件还在，随时重来。
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ing-progress">
      <div className="ing-prog-head">
        <Icon name="refresh" size={14} className="spin" />
        <span className="ing-prog-title">{RECORD_A8.original.name} · 处理中</span>
        <button className="ing-prog-cancel" onClick={onCancel}><Icon name="close" size={12} />取消</button>
      </div>
      <div className="ing-steps">
        {steps.map((s, i) => (
          <div key={i} className={"ing-step " + s.state}>
            <span className="ing-step-dot">
              {s.state === "done" ? <Icon name="check" size={12} /> : s.state === "running" ? <span className="ing-spin" /> : <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--ink-5)" }} />}
            </span>
            <span className="ing-step-l">{s.label}</span>
            {s.meta && <span className="ing-step-meta">{s.meta}</span>}
          </div>
        ))}
      </div>
      <div className="ing-reconnect"><Icon name="history" size={13} />{note || "关页或刷新都不丢 —— 回来自动重连重放进度。"}</div>
    </div>
  );
}

// rescue 失败态 — 兜底救援也失败:诚实 + 你能做什么 + 不丢原件
function RescueFail({ onRetry, go }) {
  return (
    <div>
      <OriginalChip />
      <div className="ing-rescue">
        <div className="ing-rescue-top"><Icon name="alert" size={18} /><span className="ing-rescue-title">这份没处理成功</span></div>
        <p className="ing-rescue-why">
          OCR 与兜底的 VLM 救援都没能从这页扫描里抽出可用的题块 —— <b>大概率是页面太斜、字迹过淡</b>。
          不是装作好了，是真没成。
        </p>
        <p className="ing-rescue-why" style={{ marginBottom: 0 }}>你能做的：重试一次（换更清晰的图最好）、改为手动录入、或换个格式上传。<b>原件已留着</b>，怎么选都不丢。</p>
        <div className="ing-rescue-acts">
          <Btn variant="primary" size="sm" icon="refresh" onClick={onRetry}>重试</Btn>
          <Btn variant="secondary" size="sm" icon="mistakes" onClick={() => go && go("record")}>改手动录入</Btn>
          <Btn variant="ghost" size="sm" icon="upload">换格式上传</Btn>
        </div>
      </div>
    </div>
  );
}

// 成功出口叙事 — 材料去哪了 / 变成了什么 / 下一步能干什么
function IngestExit({ go, degrade }) {
  const x = RECORD_A8.exit;
  const [proposed, setProposed] = React.useState(false);
  return (
    <div className="ing-exit">
      <div className="ing-exit-hero">
        <div className="ing-exit-hero-top">
          <span className="ing-exit-hero-ic"><Icon name="check" size={18} /></span>
          <span className="ing-exit-title">收好了 —— 这是它变成的东西</span>
        </div>
        <p className="ing-exit-lede">《{x.title}》的 <b>{x.blocks} 个块</b>已纳入。下面是它的去向和你现在能做的事 —— 不会把你丢在空页面。</p>
      </div>

      {/* edge-degrade banners surface honestly even on success */}
      {degrade === "docx" && <DegradeBanner icon="alert">结构没解析出来，已<b>按纯文本处理</b> —— 没有静默降级，标号 / 表格层级可能丢失，可手动补。</DegradeBanner>}
      {degrade === "emptyblock" && (
        <div className="ing-emptyblock"><Icon name="alert" size={14} /><span className="ing-emptyblock-txt">第 2 块抽出来是<b>空的</b> —— 没渲染成「成功但空」的假象。</span><Btn size="sm" variant="ghost" icon="pencil">补内容</Btn></div>
      )}
      {degrade === "figurecrop" && (
        <div className="ing-figure">
          <span className="ing-figure-thumb"><Icon name="camera" size={22} /></span>
          <div className="ing-figure-body">
            <div className="ing-figure-l"><Icon name="check" size={12} />抽出 1 张图 · 请确认裁切</div>
            <div className="ing-figure-q">这是从原页裁出的插图 —— 回显给你确认，裁错了可重裁，绝不静默吞掉。</div>
            <div className="ing-figure-acts"><Btn size="sm" variant="secondary" icon="check">裁切正确</Btn><Btn size="sm" variant="ghost" icon="camera">重新裁切</Btn></div>
          </div>
        </div>
      )}

      <div className="ing-exit-grid">
        <div className="ing-exit-card">
          <div className="ing-exit-card-l"><Icon name="items" size={13} />进了哪棵树</div>
          <div className="ing-tree-path">
            {x.tree.path.split(" › ").map((seg, i, arr) => (
              <React.Fragment key={i}>
                <span className={i === arr.length - 1 ? "seg-cur" : ""}>{seg}</span>{i < arr.length - 1 && <span style={{ color: "var(--ink-5)", margin: "0 4px" }}>›</span>}
              </React.Fragment>
            ))}
          </div>
          <div className="ing-tree-go"><Btn size="sm" variant="ghost" iconEnd="arrow" onClick={() => go("knowledge")}>去图谱看这棵树</Btn></div>
        </div>
        <div className="ing-exit-card">
          <div className="ing-exit-card-l"><Icon name="knowledge" size={13} />挂到了哪些知识点</div>
          <div className="ing-node-list">
            {x.nodes.map((n) => (
              <button key={n.tag} className="ing-node" onClick={() => go("knowledge/" + n.tag)}>
                <span className="nm wenyan">{n.label}</span>
                {n.isNew && <span className="ing-node-new">新</span>}
                <span className="ing-node-tag mono">{n.tag}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* orchestrator proactive proposal — echoes A3 主动开口 */}
      {!proposed ? (
        <div className="ing-proposal">
          <Icon name="sparkle" size={15} />
          <div className="ing-proposal-body">
            <span className="ing-proposal-trigger">录入后 · 编排者主动开口</span>
            <div className="ing-proposal-text">{x.proposal}</div>
            <div className="ing-proposal-acts">
              <Btn size="sm" variant="primary" icon="layers" onClick={() => go("practice")}>好，出 {x.questions} 道题</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setProposed(true)}>先不用</Btn>
            </div>
          </div>
        </div>
      ) : (
        <div className="ing-original" style={{ marginBottom: 0 }}><Icon name="check" size={14} />好的，先不出题 —— 需要时在练习里随时叫我。</div>
      )}

      <div className="ing-exit-foot">
        <Btn variant="secondary" icon="record" onClick={() => go("record")}>再录一份</Btn>
        <Btn variant="ghost" icon="today" onClick={() => go("today")}>回今日</Btn>
      </div>
    </div>
  );
}

Object.assign(window, { OriginalChip, DegradeBanner, IngestProgress, RescueFail, IngestExit });
