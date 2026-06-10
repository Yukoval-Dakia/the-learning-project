// Loom · /admin/* (K) — separate observability shell. Tables, high density.
function AdminShell({ go, route, ui = {} }) {
  const ds = ui.dataState || "ok";
  const sub = route.split("/")[1] || "runs";
  const a = DATA.admin;
  const nav = [["runs", "Runs", "history"], ["cost", "Cost", "bolt"], ["failures", "Failures", "alert"]];
  const maxDay = Math.max(...a.costByDay.map((d) => d[1]));
  const maxTask = Math.max(...a.costByTask.map((t) => t[1]));

  return (
    <div className="admin">
      <header className="admin-bar">
        <div className="admin-brand mono"><span className="admin-dot" />loom · admin</div>
        <nav className="admin-nav">
          {nav.map(([id, label, icon]) => (
            <button key={id} className={"admin-nav-item" + (sub === id ? " on" : "")} onClick={() => go("admin/" + id)}>
              <Icon name={icon} size={15} />{label}
            </button>
          ))}
        </nav>
        <div className="topbar-spacer" />
        <Btn size="sm" variant="ghost" icon="arrowL" onClick={() => go("today")}>回到 app</Btn>
      </header>

      <div className="admin-body">
        <Stateful state={ds} onRetry={() => {}} errorText="observability 服务不可用。" skeleton={<SkLines rows={5} />}
          empty={<EmptyState icon="alert" title="无记录" text="该视图当前没有数据。" />}>

          {sub === "runs" && (
            <div>
              <div className="admin-h"><h2 className="serif">AI run 日志</h2><span className="meta mono">ai_run · {a.runs.length} rows</span></div>
              <table className="adm-table">
                <thead><tr><th>run</th><th>task</th><th>actor</th><th>status</th><th className="num">cost</th><th className="num">latency</th><th>when</th></tr></thead>
                <tbody>
                  {a.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.id}</td>
                      <td className="mono">{r.task}</td>
                      <td><span className="adm-actor mono"><Icon name={ACTOR_ICON[r.actor]} size={12} />{r.actor}</span></td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="num mono">${r.cost.toFixed(3)}</td>
                      <td className="num mono">{r.latency}</td>
                      <td className="meta">{r.when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {sub === "cost" && (
            <div>
              <div className="admin-h"><h2 className="serif">花费</h2><span className="meta mono">cost_ledger</span></div>
              <div className="coach-grid">
                <Card pad>
                  <div className="card-title" style={{ marginBottom: "var(--s-3)" }}>按天</div>
                  <div className="stack-chart">
                    {a.costByDay.map(([d, v]) => (
                      <div key={d} className="stack-col">
                        <div className="stack-bars" style={{ height: 120 }}><span className="stack-seg tone-coral" style={{ height: v / maxDay * 120 + "px", background: "var(--coral)" }} title={"$" + v} /></div>
                        <span className="stack-x meta">{d.slice(3)}</span><span className="stack-total mono">${v.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card pad>
                  <div className="card-title" style={{ marginBottom: "var(--s-3)" }}>按 task</div>
                  <div className="cause-list">
                    {a.costByTask.map(([t, v]) => (
                      <div key={t} className="cause-row"><span className="cause-name mono">{t}</span><div className="cause-track"><span style={{ width: v / maxTask * 100 + "%", background: "var(--coral)" }} /></div><span className="mono cause-n">${v.toFixed(2)}</span></div>
                    ))}
                  </div>
                </Card>
              </div>
            </div>
          )}

          {sub === "failures" && (
            <div>
              <div className="admin-h"><h2 className="serif">失败 job</h2><span className="meta mono">pg-boss · dead-letter</span></div>
              <table className="adm-table">
                <thead><tr><th>job</th><th>error</th><th className="num">retries</th><th>when</th><th></th></tr></thead>
                <tbody>
                  {a.failures.map((f) => (
                    <tr key={f.id}>
                      <td className="mono">{f.job}</td>
                      <td className="adm-error mono">{f.error}</td>
                      <td className="num mono">{f.retries}</td>
                      <td className="meta">{f.when}</td>
                      <td><Btn size="sm" variant="ghost" icon="refresh">重试</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Stateful>
      </div>
    </div>
  );
}
window.AdminShell = AdminShell;
