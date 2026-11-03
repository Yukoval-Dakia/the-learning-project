import { Fragment, useState } from 'react';
import { Button, Chip } from '@/ui-next/public';
import { AdminKpi, AdminKpis } from './admin-frame';
import {
  type ConfigData,
  type ConfigKey,
  type SaveConfig,
  configOwner,
  displayValue,
  matchesSearch,
  taskEditable,
} from './config-model';
import { ConfigProviderCatalog } from './config-provider-catalog';
import { ConfigTaskEditor } from './config-task-editor';

function NoMatches() {
  return <p className="adm-empty adm-pad">没有匹配项，请调整搜索条件。</p>;
}

/** Where a key's value comes from (same mapping and order as the old inline chain). */
function sourceLabel(source: ConfigKey['source']): string {
  if (source === 'compose-forced') return '部署固定';
  if (source === 'db') return '数据库覆盖';
  if (source === 'env') return '环境配置';
  return '代码默认';
}

/** How a key takes effect (same mapping and order as the old inline chain). */
function envModeLabel(envMode: ConfigKey['env_mode']): string {
  if (envMode === 'priority') return '环境固定优先';
  if (envMode === 'pinned') return '需修改部署配置';
  return '按读取时机生效';
}
export function ConfigKeys({ rows, query }: { rows: ConfigKey[]; query: string }) {
  const [owner, setOwner] = useState('all');
  const owners = [...new Set(rows.map(configOwner))].sort();
  const visible = rows.filter(
    (r) =>
      (owner === 'all' || configOwner(r) === owner) &&
      matchesSearch(query, r.key, r.note, r.consumer),
  );
  return (
    <div className="adm-panel">
      <div className="adm-panel-tools">
        <label className="adm-inline-field">
          <span className="adm-field-name">所属模块</span>
          <select className="adm-input" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="all">全部</option>
            {owners.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      </div>
      {!visible.length ? (
        <NoMatches />
      ) : (
        <div className="adm-table-scroll">
          <table className="adm-table adm-table-wide">
            <caption className="adm-caption">{visible.length} 项 · 本区只读</caption>
            <thead>
              <tr>
                <th scope="col">配置项</th>
                <th scope="col">配置值 / 默认值</th>
                <th scope="col">实际消费</th>
                <th scope="col">来源 / 生效说明</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className="adm-row-head adm-mono adm-break">
                    {row.key}
                    <div className="adm-cell-sub">{configOwner(row)}</div>
                  </th>
                  <td className="adm-mono adm-break">
                    {displayValue(row.value)}
                    <div className="adm-cell-sub">默认：{displayValue(row.default)}</div>
                  </td>
                  <td className="adm-break">
                    {row.wired
                      ? displayValue(row.effective === undefined ? row.value : row.effective)
                      : '未接线'}
                    <p className="adm-cell-sub">{row.effective_note}</p>
                  </td>
                  <td>
                    {sourceLabel(row.source)}
                    <p className="adm-cell-sub">{envModeLabel(row.env_mode)}</p>
                    <p className="adm-cell-sub">{row.note}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Models({ data, query, save }: { data: ConfigData; query: string; save: SaveConfig }) {
  const [editing, setEditing] = useState<string | null>(null);
  const rows = data.tasks.filter((t) =>
    matchesSearch(
      query,
      t.kind,
      t.default_provider,
      t.default_model,
      t.override,
      t.effective_binding,
    ),
  );
  return (
    <div className="adm-stack">
      <p className="adm-note">
        当前选择是下一次调用的解析基线；调用参数或专用通道可进一步覆盖。运行中的调用继续使用其固定快照。
      </p>
      {!rows.length ? (
        <div className="adm-panel">
          <NoMatches />
        </div>
      ) : (
        <div className="adm-panel adm-table-scroll">
          <table className="adm-table adm-table-wide">
            <caption className="adm-caption">{rows.length} 个 AI 任务</caption>
            <thead>
              <tr>
                <th scope="col">任务</th>
                <th scope="col">任务配置</th>
                <th scope="col">当前选择</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => (
                <Fragment key={task.kind}>
                  <tr data-open={editing === task.kind ? '' : undefined}>
                    <th scope="row" className="adm-row-head adm-mono">
                      {task.kind}
                      {!taskEditable(task) && (
                        <p className="adm-cell-chip">
                          <Chip>专用通道 · 只读</Chip>
                        </p>
                      )}
                    </th>
                    <td className="adm-mono adm-break">
                      {task.override?.provider ?? task.default_provider}
                      <br />
                      {task.override?.model ?? task.default_model}
                      <p className="adm-cell-sub">
                        {task.override?.provider || task.override?.model
                          ? '含数据库覆盖'
                          : '代码默认'}
                      </p>
                    </td>
                    <td className="adm-mono adm-break">
                      {task.effective_binding?.error ??
                        (task.effective_binding
                          ? `${task.effective_binding.provider} / ${task.effective_binding.model}`
                          : '运行时事实尚未就绪')}
                      {task.global_pin && (
                        <p className="adm-cell-caution">
                          全局固定：{displayValue(task.global_pin)}
                        </p>
                      )}
                      <p className="adm-cell-sub">
                        预算：{task.effective_budget.maxIterations ?? '—'} 轮 ·{' '}
                        {task.effective_budget.timeout / 1000} 秒 ·{' '}
                        {task.effective_budget.transientRetries} 次重试
                      </p>
                    </td>
                    <td className="adm-num">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={editing !== null || !taskEditable(task) || !data.facts_injected}
                        onClick={() => setEditing(editing === task.kind ? null : task.kind)}
                        aria-expanded={editing === task.kind}
                      >
                        编辑 {task.kind}
                      </Button>
                    </td>
                  </tr>
                  {editing === task.kind && (
                    <tr className="adm-editor-row">
                      <td colSpan={4}>
                        <ConfigTaskEditor
                          task={task}
                          providers={data.providers}
                          save={save}
                          onClose={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfigProviderCatalog providers={data.providers} query={query} />
    </div>
  );
}

function Locale({ data, save }: { data: ConfigData; save: SaveConfig }) {
  const row = data.keys.find((k) => k.key === 'locale.learner');
  const [value, setValue] = useState(String(row?.value ?? 'zh-CN'));
  const [confirm, setConfirm] = useState<'set' | 'clear' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!row) return <p className="adm-note">语言配置尚未就绪，请刷新重试。</p>;
  async function commit() {
    if (!confirm || pending) return;
    setPending(true);
    setError(null);
    try {
      await save(
        confirm === 'clear'
          ? [{ action: 'clear', key: 'locale.learner' }]
          : [{ action: 'set', key: 'locale.learner', value }],
      );
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="adm-panel adm-form" aria-labelledby="adm-locale-title">
      <h2 id="adm-locale-title" className="adm-panel-title">
        AI 输出语言
      </h2>
      <p className="adm-mono adm-form-facts">
        当前配置：{displayValue(row.value)} · 当前消费：
        {displayValue(row.effective === undefined ? row.value : row.effective)}
      </p>
      <p className="adm-note">
        从下一次 AI 调用开始影响回复、解释和提案文案；界面语言、代码与字段名保持原样。
      </p>
      <label className="adm-inline-field">
        <span className="adm-field-name">输出语言</span>
        <select
          className="adm-input"
          value={value}
          disabled={pending || confirm !== null || row.read_only || !row.wired}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <div className="adm-acts">
        <Button
          disabled={pending || confirm !== null || row.read_only || !row.wired}
          onClick={() => setConfirm('set')}
        >
          保存语言
        </Button>
        <Button
          variant="secondary"
          disabled={pending || confirm !== null || row.read_only || !row.wired}
          onClick={() => setConfirm('clear')}
        >
          恢复默认语言
        </Button>
      </div>
      {confirm && (
        <fieldset className="adm-confirm" aria-label="确认语言变更">
          <p>
            {confirm === 'set'
              ? `${displayValue(row.value)} → ${value}`
              : '清除语言覆盖，恢复简体中文。'}
          </p>
          <div className="adm-acts">
            <Button disabled={pending} onClick={() => void commit()}>
              {pending ? '保存中…' : '确认变更'}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
              取消
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="adm-field-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function ConfigSections({
  section,
  data,
  query,
  save,
  navigate,
}: {
  section: string;
  data: ConfigData;
  query: string;
  save: SaveConfig;
  navigate: (to: string) => void;
}) {
  const flags = data.keys.filter(
    (r) => typeof r.default === 'boolean' || typeof r.value === 'boolean',
  );
  if (section === 'ai-models') return <Models data={data} query={query} save={save} />;
  if (section === 'locale') return <Locale data={data} save={save} />;
  if (section === 'flags') return <ConfigKeys rows={flags} query={query} />;
  if (section === 'thresholds')
    return (
      <ConfigKeys
        rows={data.keys.filter(
          (r) => !flags.includes(r) && !r.key.startsWith('lane.') && r.key !== 'locale.learner',
        )}
        query={query}
      />
    );
  if (section === 'runtime')
    return (
      <div className="adm-stack">
        <section className="adm-panel" aria-labelledby="adm-schedules-title">
          <div className="adm-panel-head">
            <div className="adm-panel-heading">
              <h2 id="adm-schedules-title" className="adm-panel-title">
                调度声明
              </h2>
              <p className="adm-panel-sub">{data.schedules.read_only_note}</p>
            </div>
          </div>
          <div className="adm-table-scroll">
            <table className="adm-table adm-table-wide">
              <thead>
                <tr>
                  <th scope="col">任务 / 模块</th>
                  <th scope="col">Cron / 时区</th>
                  <th scope="col">队列 / 说明</th>
                </tr>
              </thead>
              <tbody>
                {data.schedules.rows
                  .filter((r) => matchesSearch(query, r.name, r.owner, r.note))
                  .map((r) => (
                    <tr key={`${r.owner}:${r.name}:${r.queue}`}>
                      <th scope="row" className="adm-row-head">
                        {r.name}
                        <p className="adm-cell-sub">{r.owner}</p>
                      </th>
                      <td className="adm-mono">
                        {r.cron}
                        <p className="adm-cell-sub">{r.tz}</p>
                      </td>
                      <td>
                        {r.queue}
                        <p className="adm-cell-sub">{r.note}</p>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="adm-panel adm-form" aria-labelledby="adm-runtime-title">
          <h2 id="adm-runtime-title" className="adm-panel-title">
            当前进程运行参数
          </h2>
          {data.runtime ? (
            <dl className="adm-facts">
              <dt>API 端口</dt>
              <dd>{data.runtime.port ?? '未知'}</dd>
              <dt>数据库连接池上限</dt>
              <dd>{data.runtime.db_pool_max}</dd>
              <dt>队列时限（秒）</dt>
              <dd>{displayValue(data.runtime.queue_tiers.expire_seconds)}</dd>
              <dt>调度锚点</dt>
              <dd>
                {data.runtime.orchestration.anchor_cron} · {data.runtime.orchestration.tz}
              </dd>
              <dt>调度成员</dt>
              <dd>{data.runtime.orchestration.dag_members.join('、') || '无'}</dd>
            </dl>
          ) : (
            <p className="adm-note">运行时事实尚未就绪。</p>
          )}
        </section>
      </div>
    );
  return (
    <div className="adm-stack">
      <AdminKpis>
        {[
          ['配置项', data.keys.length],
          ['AI 任务', data.tasks.length],
          ['凭据已配置', data.providers.filter((p) => p.key_present).length],
          ['任务有覆盖', data.tasks.filter((t) => t.override !== null).length],
        ].map(([label, value]) => (
          <AdminKpi key={label} label={String(label)} value={value} />
        ))}
      </AdminKpis>
      <div className="adm-snapshot">
        <p className="adm-mono">
          配置快照 #{data.snapshot.epoch} · 最近读取：{data.snapshot.hydrated_at ?? '尚未加载'}
        </p>
        <p className="adm-note">
          本页显示当前 API 进程的快照。后台通常每 15 秒刷新，失败时可能延后；此处没有 worker
          确认信息。
        </p>
      </div>
      <h2 className="adm-section-title">部署固定项</h2>
      <ConfigKeys rows={data.keys.filter((k) => k.read_only)} query={query} />
      <div>
        <Button variant="secondary" onClick={() => navigate('/admin/subjects')}>
          查看学科配置
        </Button>
      </div>
    </div>
  );
}
