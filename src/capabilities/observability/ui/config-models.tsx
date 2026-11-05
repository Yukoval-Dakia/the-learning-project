// AI 模型 (YUK-1808): the global default, then tasks by what they are for. Each row says what the
// task really runs on and why; a save shows what the server says took effect, not what was asked.
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { Button, Chip } from '@/ui-next/public';
import {
  type ConfigBinding,
  type ConfigData,
  type ConfigGlobal,
  type ConfigReceipt,
  type ConfigTask,
  type SaveConfig,
  bindingLine,
  bindingThinking,
  laneWords,
  matchesSearch,
  ruleWord,
  taskEditable,
} from './config-model';
import { ModelPicker, modelIssue } from './config-model-picker';
import { ConfigProviderCatalog } from './config-provider-catalog';
import { ConfigTaskEditor } from './config-task-editor';

function BindingFacts({ binding }: { binding: ConfigBinding | null }) {
  const thinking = bindingThinking(binding);
  return (
    <div className="adm-binding">
      <p className="adm-mono adm-break" data-error={binding?.error ? '' : undefined}>
        {bindingLine(binding)}
      </p>
      {binding && !binding.error ? (
        <p className="adm-binding-tags">
          <Chip tone={binding.selection_rule === 'env_pin' ? 'caution' : 'neutral'}>
            {ruleWord(binding.selection_rule)}
          </Chip>
          {thinking ? <span className="adm-cell-sub">{thinking}</span> : null}
        </p>
      ) : null}
      {binding?.also_on_lanes?.length ? (
        <p className="adm-cell-sub">也走{laneWords(binding.also_on_lanes)}</p>
      ) : null}
      {binding?.credential?.lane === 'conflict' ? (
        <p className="adm-cell-caution">同时设了 key 和登录文件，运行时会报错。</p>
      ) : null}
      {binding?.credential && binding.credential.lane !== 'conflict'
        ? !binding.credential.verified_in_process && (
            <p className="adm-cell-sub">凭据在后台进程里，这里看不到，以真实运行为准。</p>
          )
        : null}
    </div>
  );
}

function GlobalDefault({ data, save }: { data: ConfigData; save: SaveConfig }) {
  const id = useId();
  const current: ConfigGlobal | null = data.global;
  const pinned = current?.source === 'env' || current?.model_source === 'env';
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState({
    provider: current?.provider ?? '',
    model: current?.model ?? '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const issue = modelIssue(data.providers, pick.provider, pick.model);
  const run = async (changes: Parameters<SaveConfig>[0]) => {
    setPending(true);
    setError(null);
    try {
      const receipt = await save(changes);
      const after = receipt.effective?.global ?? null;
      setSaved(
        after?.provider ? `现在生效：${after.provider} / ${after.model}` : '已清除全局默认。',
      );
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="adm-panel adm-form" aria-labelledby={`${id}-title`}>
      <div className="adm-global-head">
        <div>
          <h2 id={`${id}-title`} className="adm-panel-title">
            全局默认
          </h2>
          <p className="adm-note">没有单独设置的任务都用它。</p>
        </div>
        {!pinned && !editing ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!data.facts_injected}
            onClick={() => {
              setSaved(null);
              setEditing(true);
            }}
          >
            修改
          </Button>
        ) : null}
      </div>
      {current?.provider ? (
        <p className="adm-mono adm-break">
          {current.provider} / {current.model}
        </p>
      ) : (
        <p className="adm-note">没有全局默认，各任务用自己的模型。</p>
      )}
      {current?.error ? (
        <p role="alert" className="adm-field-error">
          {current.error}
        </p>
      ) : null}
      {pinned ? (
        <p className="adm-warn-line">
          紧急开关开着（部署环境变量），它压过这里和所有任务的设置，这里改不了。
          {current?.source !== current?.model_source
            ? ` Provider 来自${current?.source === 'env' ? '环境变量' : '这里的设置'}，模型来自${current?.model_source === 'env' ? '环境变量' : '这里的设置'}。`
            : ''}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="adm-saved">
          {saved}
        </p>
      ) : null}
      {editing ? (
        <fieldset disabled={pending} className="adm-fieldset">
          <legend className="adm-legend">全局默认</legend>
          <ModelPicker
            id={id}
            providers={data.providers}
            provider={pick.provider}
            model={pick.model}
            onChange={setPick}
          />
          <div className="adm-acts">
            <Button
              disabled={Boolean(issue)}
              onClick={() =>
                void run([
                  { action: 'set', key: 'lane.global.provider', value: pick.provider },
                  { action: 'set', key: 'lane.global.model', value: pick.model },
                ])
              }
            >
              {pending ? '保存中…' : '保存'}
            </Button>
            {current?.provider ? (
              <Button
                variant="secondary"
                onClick={() =>
                  void run([
                    { action: 'clear', key: 'lane.global.provider' },
                    { action: 'clear', key: 'lane.global.model' },
                  ])
                }
              >
                清除全局默认
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="adm-field-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** What a whole group runs on, in one phrase. */
function groupSummary(tasks: readonly ConfigTask[]): string {
  const pairs = new Set(tasks.map((task) => bindingLine(task.effective_binding)));
  return pairs.size === 1 ? [...pairs][0] : `${pairs.size} 种模型`;
}

function TaskRow({
  task,
  data,
  save,
  editing,
  editorLocked,
  onEdit,
}: {
  task: ConfigTask;
  data: ConfigData;
  save: SaveConfig;
  editing: boolean;
  editorLocked: boolean;
  onEdit: (open: boolean) => void;
}) {
  const [receipt, setReceipt] = useState<ConfigReceipt | null>(null);
  const after = receipt?.effective?.tasks?.[task.kind];
  return (
    <li className="adm-task" data-open={editing ? '' : undefined}>
      <div className="adm-task-main">
        <p className="adm-mono adm-break">{task.kind}</p>
        <BindingFacts binding={task.effective_binding} />
        {taskEditable(task) ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={`编辑 ${task.kind}`}
            aria-expanded={editing}
            disabled={editorLocked || !data.facts_injected}
            onClick={() => {
              setReceipt(null);
              onEdit(!editing);
            }}
          >
            编辑
          </Button>
        ) : (
          <Chip>专用通道 · 只读</Chip>
        )}
      </div>
      {after && !editing ? (
        <div className="adm-saved adm-task-saved" role="status">
          <p>下一次运行会用：</p>
          <BindingFacts binding={after} />
        </div>
      ) : null}
      {editing ? (
        <ConfigTaskEditor
          task={task}
          providers={data.providers}
          global={data.global}
          save={save}
          onSaved={setReceipt}
          onClose={() => onEdit(false)}
        />
      ) : null}
    </li>
  );
}

export function ConfigModels({
  data,
  query,
  save,
}: {
  data: ConfigData;
  query: string;
  save: SaveConfig;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const searching = query.trim().length > 0;
  const byKind = new Map(data.tasks.map((task) => [task.kind, task]));
  const groups = data.task_groups
    .map((group) => ({
      ...group,
      tasks: group.kinds
        .map((kind) => byKind.get(kind))
        .filter((task): task is ConfigTask => task !== undefined)
        .filter((task) =>
          matchesSearch(
            query,
            task.kind,
            group.label,
            task.default_provider,
            task.default_model,
            task.override,
            task.effective_binding,
          ),
        ),
    }))
    .filter((group) => group.tasks.length > 0);
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="adm-stack">
      <GlobalDefault data={data} save={save} />
      <section className="adm-stack" aria-label="按用途的任务">
        {groups.length === 0 ? (
          <div className="adm-panel">
            <p className="adm-empty adm-pad">没有匹配项，请调整搜索条件。</p>
          </div>
        ) : (
          groups.map((group) => {
            const expanded = searching || open.has(group.id);
            const panelId = `adm-group-${group.id}`;
            return (
              <div key={group.id} className="adm-panel adm-group">
                <button
                  type="button"
                  className="adm-group-head un-hit"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggle(group.id)}
                >
                  <span className="adm-group-label">{group.label}</span>
                  <span className="adm-cell-sub">{group.tasks.length} 个任务</span>
                  <span className="adm-group-summary adm-mono">{groupSummary(group.tasks)}</span>
                  <ChevronDown size={16} aria-hidden="true" className="adm-group-chev" />
                </button>
                {expanded ? (
                  <ul id={panelId} className="adm-task-list">
                    {group.tasks.map((task) => (
                      <TaskRow
                        key={task.kind}
                        task={task}
                        data={data}
                        save={save}
                        editing={editing === task.kind}
                        editorLocked={editing !== null && editing !== task.kind}
                        onEdit={(next) => setEditing(next ? task.kind : null)}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })
        )}
      </section>
      <ConfigProviderCatalog providers={data.providers} query={query} />
    </div>
  );
}
