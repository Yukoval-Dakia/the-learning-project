import { Fragment, useState } from 'react';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import {
  type ConfigData,
  type ConfigKey,
  type SaveConfig,
  configOwner,
  displayValue,
  inputClass,
  matchesSearch,
  providerStatus,
  tableClass,
  taskEditable,
} from './config-model';
import { ConfigTaskEditor } from './config-task-editor';

function NoMatches() {
  return <p className="p-4 text-[var(--ink-3)]">没有匹配项，请调整搜索条件。</p>;
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
    <div className="space-y-3">
      <label>
        所属模块{' '}
        <select className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">全部</option>
          {owners.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      </label>
      {!visible.length ? (
        <NoMatches />
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <caption className="text-left p-3">{visible.length} 项 · 本区只读</caption>
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
                  <th scope="row" className="font-mono font-normal break-all">
                    {row.key}
                    <div className="text-[var(--ink-3)]">{configOwner(row)}</div>
                  </th>
                  <td className="font-mono break-all">
                    {displayValue(row.value)}
                    <div className="text-[var(--ink-3)]">默认：{displayValue(row.default)}</div>
                  </td>
                  <td className="break-all">
                    {row.wired
                      ? displayValue(row.effective === undefined ? row.value : row.effective)
                      : '未接线'}
                    <p>{row.effective_note}</p>
                  </td>
                  <td>
                    {row.source === 'compose-forced'
                      ? '部署固定'
                      : row.source === 'db'
                        ? '数据库覆盖'
                        : row.source === 'env'
                          ? '环境配置'
                          : '代码默认'}
                    <p>
                      {row.env_mode === 'priority'
                        ? '环境固定优先'
                        : row.env_mode === 'pinned'
                          ? '需修改部署配置'
                          : '按读取时机生效'}
                    </p>
                    <p>{row.note}</p>
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
    <div className="space-y-5">
      <p className="text-[var(--ink-3)]">
        当前选择是下一次调用的解析基线；调用参数或专用通道可进一步覆盖。运行中的调用继续使用其固定快照。
      </p>
      {!rows.length ? (
        <NoMatches />
      ) : (
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <caption className="text-left p-3">{rows.length} 个 AI 任务</caption>
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
                  <tr>
                    <th scope="row" className="font-mono font-normal">
                      {task.kind}
                      {!taskEditable(task) && (
                        <p>
                          <Badge>专用通道 · 只读</Badge>
                        </p>
                      )}
                    </th>
                    <td className="font-mono break-all">
                      {task.override?.provider ?? task.default_provider}
                      <br />
                      {task.override?.model ?? task.default_model}
                      <p className="text-[var(--ink-3)]">
                        {task.override?.provider || task.override?.model
                          ? '含数据库覆盖'
                          : '代码默认'}
                      </p>
                    </td>
                    <td className="font-mono break-all">
                      {task.effective_binding?.error ??
                        (task.effective_binding
                          ? `${task.effective_binding.provider} / ${task.effective_binding.model}`
                          : '运行时事实尚未就绪')}
                      {task.global_pin && (
                        <p className="text-[var(--hard-ink)]">
                          全局固定：{displayValue(task.global_pin)}
                        </p>
                      )}
                      <p className="text-[var(--ink-3)]">
                        预算：{task.effective_budget.maxIterations ?? '—'} 轮 ·{' '}
                        {task.effective_budget.timeout / 1000} 秒 ·{' '}
                        {task.effective_budget.transientRetries} 次重试
                      </p>
                    </td>
                    <td>
                      <Button
                        variant="secondary"
                        disabled={editing !== null || !taskEditable(task) || !data.facts_injected}
                        onClick={() => setEditing(editing === task.kind ? null : task.kind)}
                        aria-expanded={editing === task.kind}
                      >
                        编辑 {task.kind}
                      </Button>
                    </td>
                  </tr>
                  {editing === task.kind && (
                    <tr>
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
      <h3 className="font-medium">Provider 目录</h3>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">pi 原生身份</th>
              <th scope="col">状态</th>
              <th scope="col">pi 模型数</th>
            </tr>
          </thead>
          <tbody>
            {data.providers
              .filter((p) => matchesSearch(query, p.name, p.pi_provider))
              .map((p) => (
                <tr key={p.name}>
                  <th scope="row">{p.name}</th>
                  <td>
                    {p.pi_provider ?? (p.implemented_for?.typed ? 'typed 专用通道' : '未接线')}
                  </td>
                  <td>{providerStatus(p)}</td>
                  <td>{p.models?.length ?? 0}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <h3 className="font-medium">全局与专用通道（只读）</h3>
      <ConfigKeys
        rows={data.keys.filter(
          (k) =>
            k.key.startsWith('lane.') ||
            k.key.startsWith('JUDGE_CALIBRATION_REJUDGE') ||
            k.key === 'JUDGE_FALLBACK_PROVIDER',
        )}
        query={query}
      />
    </div>
  );
}

function Locale({ data, save }: { data: ConfigData; save: SaveConfig }) {
  const row = data.keys.find((k) => k.key === 'locale.learner');
  const [value, setValue] = useState(String(row?.value ?? 'zh-CN'));
  const [confirm, setConfirm] = useState<'set' | 'clear' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!row) return <p>语言配置尚未就绪，请刷新重试。</p>;
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
    <section className="space-y-4">
      <h2 className="font-medium">AI 输出语言</h2>
      <p>
        当前配置：{displayValue(row.value)} · 当前消费：
        {displayValue(row.effective === undefined ? row.value : row.effective)}
      </p>
      <p>从下一次 AI 调用开始影响回复、解释和提案文案；界面语言、代码与字段名保持原样。</p>
      <label>
        输出语言{' '}
        <select
          className={inputClass}
          value={value}
          disabled={pending || confirm !== null || row.read_only || !row.wired}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
      <div className="flex gap-2">
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
        <fieldset aria-label="确认语言变更">
          <p>
            {confirm === 'set'
              ? `${displayValue(row.value)} → ${value}`
              : '清除语言覆盖，恢复简体中文。'}
          </p>
          <Button disabled={pending} onClick={() => void commit()}>
            {pending ? '保存中…' : '确认变更'}
          </Button>{' '}
          <Button variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
            取消
          </Button>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
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
      <div className="space-y-4">
        <h2 className="font-medium">调度声明</h2>
        <p>{data.schedules.read_only_note}</p>
        <div className="overflow-x-auto">
          <table className={tableClass}>
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
                    <th scope="row">
                      {r.name}
                      <p>{r.owner}</p>
                    </th>
                    <td className="font-mono">
                      {r.cron}
                      <p>{r.tz}</p>
                    </td>
                    <td>
                      {r.queue}
                      <p>{r.note}</p>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <h2 className="font-medium">当前进程运行参数</h2>
        {data.runtime ? (
          <dl className="grid grid-cols-2 gap-3">
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
          <p>运行时事实尚未就绪。</p>
        )}
      </div>
    );
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['配置项', data.keys.length],
          ['AI 任务', data.tasks.length],
          ['凭据已配置', data.providers.filter((p) => p.key_present).length],
          ['任务有覆盖', data.tasks.filter((t) => t.override !== null).length],
        ].map(([label, value]) => (
          <Card key={label} pad="default">
            <p className="text-[var(--ink-3)]">{label}</p>
            <p className="text-2xl font-mono">{value}</p>
          </Card>
        ))}
      </div>
      <p>
        配置快照 #{data.snapshot.epoch} · 最近读取：{data.snapshot.hydrated_at ?? '尚未加载'}
      </p>
      <p>
        本页显示当前 API 进程的快照。后台通常每 15 秒刷新，失败时可能延后；此处没有 worker
        确认信息。
      </p>
      <h2 className="font-medium">部署固定项</h2>
      <ConfigKeys rows={data.keys.filter((k) => k.read_only)} query={query} />
      <Button variant="secondary" onClick={() => navigate('/admin/subjects')}>
        查看学科配置
      </Button>
    </div>
  );
}
