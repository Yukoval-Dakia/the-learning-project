// AI 模型 (YUK-1808): the global default first, then a card per use. A card or row names a model only
// where it differs from the default, so what is different shows at a glance. A save shows what the
// server says took effect, not what was asked.
import {
  BookOpen,
  Brain,
  CheckCheck,
  ChevronDown,
  Compass,
  FileQuestion,
  type LucideIcon,
  MessageCircle,
  MoreHorizontal,
  Shapes,
  Upload,
} from 'lucide-react';
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
  taskWords,
  thinkingChoiceWord,
  thinkingLevels,
  thinkingWord,
} from './config-model';
import { ModelPicker, findModel, modelIssue } from './config-model-picker';
import { ConfigProviderCatalog } from './config-provider-catalog';
import { ConfigTaskEditor } from './config-task-editor';

const GROUP_ICON: Readonly<Record<string, LucideIcon>> = {
  companion: MessageCircle,
  coach: Compass,
  'question-prep': FileQuestion,
  grading: CheckCheck,
  ingestion: Upload,
  memory: Brain,
  'notes-knowledge': BookOpen,
};

/**
 * True only when the task really runs on the pair the hero names. The selection rule alone cannot
 * say so: it reports the provider's layer, and the model resolves separately, so a provider-only pin
 * can leave a task on a model of its own.
 */
const GLOBAL_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

function followsGlobal(binding: ConfigBinding | null, global: ConfigGlobal | null): boolean {
  return (
    binding !== null &&
    !binding.error &&
    (binding.selection_rule === 'env_pin' || binding.selection_rule === 'global_pin') &&
    Boolean(global?.model) &&
    binding.provider === global?.provider &&
    binding.model === global?.model
  );
}

function BindingFacts({
  binding,
  terseAgainst,
}: {
  binding: ConfigBinding | null;
  /** In a list under the default: say 「跟全局默认」 instead of repeating the same name. */
  terseAgainst?: ConfigGlobal | null;
}) {
  const thinking = bindingThinking(binding);
  const follows = terseAgainst !== undefined && followsGlobal(binding, terseAgainst);
  return (
    <div className="adm-binding">
      {follows ? (
        <p className="adm-follows">跟全局默认</p>
      ) : (
        <p className="adm-mono adm-break" data-error={binding?.error ? '' : undefined}>
          {bindingLine(binding)}
        </p>
      )}
      {binding && !binding.error && (!follows || thinking) ? (
        <p className="adm-binding-tags">
          {follows ? null : (
            <Chip tone={binding.selection_rule === 'env_pin' ? 'caution' : 'neutral'}>
              {ruleWord(binding.selection_rule)}
            </Chip>
          )}
          {thinking ? (
            <span className={binding.reasoning?.error ? 'adm-cell-caution' : 'adm-cell-sub'}>
              {thinking}
            </span>
          ) : null}
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
  const [saved, setSaved] = useState<{ text: string; epoch: number } | null>(null);
  const stored = current?.reasoning?.level ?? '';
  const [thinking, setThinking] = useState(stored);
  // Every task without its own choice moves with this, so a change says so and asks first.
  const [confirm, setConfirm] = useState<{
    text: string;
    changes: Parameters<SaveConfig>[0];
  } | null>(null);
  const issue = pinned ? null : modelIssue(data.providers, pick.provider, pick.model);
  const currentPair = current?.provider
    ? current.model
      ? `${current.provider} / ${current.model}`
      : current.provider
    : null;
  const pairChanged =
    !pinned && (pick.provider !== current?.provider || pick.model !== current?.model);
  const thinkingChanged = thinking !== stored;
  const pickedModel = pinned
    ? findModel(data.providers, current?.provider ?? '', current?.model ?? '')
    : findModel(data.providers, pick.provider, pick.model);
  const catalogLevels = thinkingLevels(pickedModel);
  // With no single model to read it from, the level still applies to whatever each task runs.
  const levels = catalogLevels.length > 0 ? catalogLevels : GLOBAL_THINKING_LEVELS;
  const run = async (changes: Parameters<SaveConfig>[0]) => {
    setPending(true);
    setError(null);
    try {
      const receipt = await save(changes);
      const after = receipt.effective?.global ?? null;
      setSaved({
        text: after?.provider ? `现在生效：${after.provider} / ${after.model}` : '已清除全局默认。',
        epoch: receipt.committed_epoch,
      });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirm(null);
      setPending(false);
    }
  };
  const askToSave = () => {
    const parts = [
      pairChanged ? `全局默认：${currentPair ?? '没有'} → ${pick.provider} / ${pick.model}` : null,
      thinkingChanged
        ? `思考强度：${stored ? thinkingWord(stored) : '没有'} → ${thinkingChoiceWord(pickedModel, thinking)}`
        : null,
    ].filter(Boolean);
    setConfirm({
      text: `${parts.join('；')}。没有单独设置的任务都会跟着变。`,
      changes: [
        ...(pairChanged
          ? ([
              { action: 'set', key: 'lane.global.provider', value: pick.provider },
              { action: 'set', key: 'lane.global.model', value: pick.model },
            ] as const)
          : []),
        ...(thinkingChanged
          ? ([{ action: 'set', key: 'lane.global.reasoning', value: { level: thinking } }] as const)
          : []),
      ],
    });
  };
  return (
    <section className="adm-global adm-form" aria-labelledby={`${id}-title`}>
      <div className="adm-global-head">
        <div>
          <h2 id={`${id}-title`} className="adm-panel-title">
            全局默认
          </h2>
          <p className="adm-note">没有单独设置的任务都用它。</p>
        </div>
        {!editing ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!data.facts_injected}
            onClick={() => {
              setSaved(null);
              // Start from what is in effect now: another session may have changed it, and saving an
              // older pair would move every task that follows the default back.
              setPick({ provider: current?.provider ?? '', model: current?.model ?? '' });
              setThinking(stored);
              setEditing(true);
            }}
          >
            修改
          </Button>
        ) : null}
      </div>
      {current?.provider ? (
        <p className="adm-global-model">
          {current.model ?? current.provider}
          <span className="adm-global-provider">
            {current.model ? current.provider : '只定了 provider，模型由各任务决定'}
          </span>
        </p>
      ) : (
        <p className="adm-note">没有全局默认，各任务用自己的模型。</p>
      )}
      {stored ? (
        <p className="adm-cell-sub">
          思考强度 {thinkingWord(stored)}
          {current?.reasoning?.source === 'code-default' ? '（系统默认）' : ''}
          ，每个模型取它能用的最接近一档。
        </p>
      ) : null}
      {current?.error ? (
        <p role="alert" className="adm-field-error">
          {current.error}
        </p>
      ) : null}
      {pinned ? (
        <p className="adm-warn-line">
          紧急开关开着（部署环境变量），它压过这里的设置，这里改不了。勾了「不跟全局默认」的任务不受影响。
          {current?.model && current.source !== current.model_source
            ? ` Provider 来自${current?.source === 'env' ? '环境变量' : '这里的设置'}，模型来自${current?.model_source === 'env' ? '环境变量' : '这里的设置'}。`
            : ''}
        </p>
      ) : null}
      {saved && data.snapshot.epoch <= saved.epoch ? (
        <p role="status" className="adm-saved">
          {saved.text}
        </p>
      ) : null}
      {editing ? (
        <fieldset disabled={pending || confirm !== null} className="adm-fieldset">
          <legend className="adm-legend">全局默认</legend>
          {pinned ? null : (
            <ModelPicker
              id={id}
              providers={data.providers}
              provider={pick.provider}
              model={pick.model}
              onChange={setPick}
            />
          )}
          <label htmlFor={`${id}-thinking`} className="adm-inline-field">
            <span className="adm-field-name">思考强度</span>
            <select
              id={`${id}-thinking`}
              className="adm-input"
              value={levels.includes(thinking) ? thinking : ''}
              onChange={(e) => setThinking(e.target.value)}
            >
              {levels.includes(thinking) ? null : (
                <option value="">{thinking ? thinkingWord(thinking) : '没有'}</option>
              )}
              {levels.map((level) => (
                <option key={level} value={level}>
                  {thinkingChoiceWord(pickedModel, level)}
                </option>
              ))}
            </select>
          </label>
          <div className="adm-acts">
            <Button
              disabled={Boolean(issue) || !(pairChanged || thinkingChanged)}
              onClick={askToSave}
            >
              保存
            </Button>
            {!pinned && current?.provider ? (
              <Button
                variant="secondary"
                onClick={() =>
                  setConfirm({
                    text: `清除全局默认（${currentPair}）。没有单独设置的任务回到各自的模型。`,
                    changes: [
                      { action: 'clear', key: 'lane.global.provider' },
                      { action: 'clear', key: 'lane.global.model' },
                    ],
                  })
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
      {confirm ? (
        <fieldset className="adm-confirm" aria-label="确认全局默认变更">
          <p>{confirm.text}</p>
          <div className="adm-acts">
            <Button disabled={pending} onClick={() => void run(confirm.changes)}>
              {pending ? '保存中…' : '确认变更'}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
              返回修改
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

/** What a whole group runs on: only a difference from the default gets a tag. */
function GroupSummary({
  tasks,
  global,
}: {
  tasks: readonly ConfigTask[];
  global: ConfigGlobal | null;
}) {
  const bindings = tasks.map((task) => task.effective_binding);
  const broken = bindings.filter((binding) => binding === null || binding.error).length;
  if (broken > 0) {
    return <span className="adm-tag-caution">{broken} 个任务读不出模型</span>;
  }
  if (bindings.every((binding) => followsGlobal(binding, global))) {
    return <span className="adm-follows">跟全局默认</span>;
  }
  // The same model id from two providers is two different things: compare the whole pair.
  const pairs = new Set(bindings.map(bindingLine));
  return (
    <span className="adm-tag-differs">
      {pairs.size === 1 ? [...pairs][0] : `${pairs.size} 种模型`}
    </span>
  );
}

// A dedicated-channel task has no model to choose and the server now refuses this flag on it. A row
// from before that refusal breaks reads of the task, and clearing it is all this page can offer.
function LeftoverOwnModel({
  task,
  save,
  onSaved,
}: {
  task: ConfigTask;
  save: SaveConfig;
  onSaved: (receipt: ConfigReceipt) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function clear() {
    setError(null);
    setPending(true);
    try {
      onSaved(await save([{ action: 'clear', key: `task.${task.kind}.override_global_pin` }]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="adm-saved adm-task-saved">
      <p className="adm-field-error">
        这个任务留着一条「用自己的模型」的设置。它用不上，留着可能让相关功能出错。
      </p>
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => void clear()}>
        {pending ? '清除中…' : '清除这条设置'}
      </Button>
      {error ? (
        <p role="alert" className="adm-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
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
  const words = taskWords(task);
  // Only until the next config snapshot: after that the row above is the truth, and a later write
  // anywhere could have changed this task.
  const fresh = receipt !== null && data.snapshot.epoch <= receipt.committed_epoch;
  const after = fresh ? receipt.effective?.tasks?.[task.kind] : undefined;
  // Provider and model resolve separately, so only say it when the task's own model really lost.
  const binding = task.effective_binding;
  const dormant =
    binding !== null &&
    task.override?.provider &&
    task.override.model &&
    binding.selection_rule !== 'task_config' &&
    binding.selection_rule !== 'task_pair_priority' &&
    binding.model !== task.override.model;
  return (
    <li className="adm-task" data-open={editing ? '' : undefined}>
      <div className="adm-task-main">
        <div className="adm-task-name">
          <p>{words.name}</p>
          {words.detail ? <p className="adm-task-detail">{words.detail}</p> : null}
        </div>
        <div className="adm-task-binding">
          <BindingFacts binding={task.effective_binding} terseAgainst={data.global} />
          {dormant ? (
            <p className="adm-cell-sub">
              自己设了 {task.override?.provider} / {task.override?.model}，现在不生效。
            </p>
          ) : null}
        </div>
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
      {!taskEditable(task) && task.override?.override_global_pin === true ? (
        <LeftoverOwnModel task={task} save={save} onSaved={setReceipt} />
      ) : null}
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
            task.label,
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
      <section className="adm-groups" aria-label="按用途的任务">
        {groups.length === 0 ? (
          <div className="adm-panel">
            <p className="adm-empty adm-pad">没有匹配项，请调整搜索条件。</p>
          </div>
        ) : (
          groups.map((group) => {
            const expanded = searching || open.has(group.id);
            const panelId = `adm-group-${group.id}`;
            const Icon = GROUP_ICON[group.id] ?? Shapes;
            return (
              <div
                key={group.id}
                className="adm-panel adm-group"
                data-open={expanded ? '' : undefined}
              >
                <button
                  type="button"
                  className="adm-group-head un-hit"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggle(group.id)}
                >
                  <span className="adm-group-label">
                    <span className="adm-group-icon">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    {group.label}
                  </span>
                  <span className="adm-group-count">{group.tasks.length} 个任务</span>
                  <span className="adm-group-summary">
                    <GroupSummary tasks={group.tasks} global={data.global} />
                  </span>
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
      <details className="adm-catalog-fold" open={searching || undefined}>
        <summary className="adm-summary">
          <MoreHorizontal size={16} aria-hidden="true" />
          模型目录：{data.providers.length} 家，
          {data.providers.filter((p) => p.auth?.status === 'configured').length} 家已配置
        </summary>
        <ConfigProviderCatalog providers={data.providers} query={query} />
      </details>
    </div>
  );
}
