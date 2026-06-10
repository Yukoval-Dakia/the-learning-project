// Loom · Copilot tool_use card (self-contained; React.useState; Cop-prefixed
// to avoid global collisions with the drawer's simpler ToolCard).
// header · args · structured result · cost/confidence ribbon · approval.

const COP_STATUS = {
  run:     { cls: "run",     icon: "refresh", label: "运行中", spin: true },
  done:    { cls: "done",    icon: "check",   label: "完成" },
  empty:   { cls: "empty",   icon: "minus",   label: "无结果" },
  error:   { cls: "error",   icon: "alert",   label: "失败" },
  waiting: { cls: "waiting", icon: "clock",   label: "待你批准" },
};
function CopStatusPill({ status }) {
  const s = COP_STATUS[status] || COP_STATUS.done;
  return <span className={"pill " + s.cls}><Icon name={s.icon} size={13} className={s.spin ? "spin" : ""} />{s.label}</span>;
}

function CopConf({ value }) {
  const lvl = value >= 0.8 ? "" : value >= 0.6 ? "mid" : "low";
  return (
    <span className="conf" title={"confidence " + Math.round(value * 100) + "%"}>
      <span className="bar"><i className={lvl} style={{ width: Math.round(value * 100) + "%" }} /></span>
      <span className="pct">{Math.round(value * 100)}%</span>
    </span>
  );
}

function CopArgs({ args }) {
  const [open, setOpen] = React.useState(false);
  const keys = Object.keys(args);
  const cls = (v) => (typeof v === "number" ? "num" : typeof v === "string" ? "str" : "");
  return (
    <div className="tc-args">
      <div className="sig">
        <span className="fn">arguments</span>
        <button className={"toggle" + (open ? " open" : "")} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "收起" : "raw json"} <Icon name="chevronDown" size={12} />
        </button>
      </div>
      {!open ? (
        <div className="tc-arglist">
          {keys.map((k) => <div className="row" key={k}><span className="k">{k}</span><span className={"v " + cls(args[k])}>{String(args[k])}</span></div>)}
        </div>
      ) : (
        <pre className="tc-raw">{"{\n" + keys.map((k) => {
          const v = args[k]; const val = typeof v === "string" ? '"' + v + '"' : String(v);
          return '  "' + k + '": ' + val;
        }).join(",\n") + "\n}"}</pre>
      )}
    </div>
  );
}

function CopMeta({ model, cost, latency, conf, caused }) {
  const free = cost === 0;
  return (
    <div className="tc-meta">
      <span className="m model">{model}</span>
      <span className="dotsep">·</span>
      <span className={"m cost" + (free ? " free" : "")}>{free ? "$0.000" : "$" + cost.toFixed(cost < 0.01 ? 4 : 3)}</span>
      <span className="dotsep">·</span>
      <span className="m">{latency}</span>
      {conf != null && <><span className="dotsep">·</span><CopConf value={conf} /></>}
      {caused && <span className="caused"><b>caused_by</b> {caused}</span>}
    </div>
  );
}

function CopSkeleton() {
  return <div className="r-skel"><div className="ln" style={{ width: "92%" }} /><div className="ln" style={{ width: "70%" }} /><div className="ln" style={{ width: "80%" }} /></div>;
}

function CopilotToolCard({ spec }) {
  const [status, setStatus] = React.useState(spec.status);
  const [resolved, setResolved] = React.useState(null);
  const replay = () => { setStatus("run"); setTimeout(() => setStatus(spec.status === "run" ? "done" : spec.status), 1400); };
  const tone = spec.tone ? "tone-" + spec.tone : "";
  const showActions = spec.actions && status === "waiting" && !resolved;

  return (
    <div className={"tcard " + tone + (resolved ? (resolved.kind === "dismiss" ? " is-dismissed" : " is-resolved") : "")}>
      <div className="tc-head">
        <span className="tc-ico"><Icon name={spec.icon} size={16} /></span>
        <span className="tc-name"><b>{spec.fn}</b></span>
        <span className="tc-actor"><Icon name="copilot" size={11} /> agent</span>
        <span className="tc-status">
          {spec.replayable
            ? <button className="cop-replay" onClick={replay} title="重放调用"><Icon name="refresh" size={13} className={status === "run" ? "spin" : ""} /> {status === "run" ? "运行中" : "重放"}</button>
            : <CopStatusPill status={status} />}
        </span>
      </div>

      <CopArgs args={spec.args} />

      <div className="tc-result" key={status}>
        {status === "run" && (spec.running || <CopSkeleton />)}
        {status === "done" && spec.result}
        {status === "empty" && spec.emptyView}
        {status === "error" && spec.errorView}
        {status === "waiting" && spec.result}
      </div>

      {status !== "error" && status !== "empty" && spec.meta && <CopMeta {...spec.meta} />}

      {showActions && (
        <div className="tc-actions">
          <span className="hint">{spec.actionHint || "你来定夺"}</span>
          {spec.actions.map((a, i) => (
            <Btn key={i} size="sm" variant={a.variant} icon={a.icon}
              onClick={() => setResolved({ kind: a.kind, ev: a.ev, text: a.done })}>{a.label}</Btn>
          ))}
        </div>
      )}
      {resolved && (
        <div className={"resolved-line" + (resolved.kind === "dismiss" ? " dismissed" : "")}>
          <Icon name={resolved.kind === "dismiss" ? "close" : "checkCircle"} size={15} />
          <span>{resolved.text}</span>
          <span className="ev" style={{ marginLeft: "auto" }}>{resolved.ev}</span>
        </div>
      )}
    </div>
  );
}
window.CopilotToolCard = CopilotToolCard;
