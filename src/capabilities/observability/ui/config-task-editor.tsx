import { useId, useState } from 'react';
import { Button } from '@/ui-next/public';
import {
  BUDGET_FIELDS,
  type BudgetDraft,
  type ConfigGlobal,
  type ConfigProvider,
  type ConfigTask,
  type ModelDraft,
  type SaveConfig,
  budgetChanges,
  displayValue,
  initialBudget,
  initialModelDraft,
  modelChanges,
  resetTaskChanges,
  taskEditable,
  thinkingLevels,
  thinkingWord,
} from './config-model';
import { ModelPicker, findModel, modelIssue } from './config-model-picker';

type ConfirmKind = 'model' | 'budget' | 'reset-model' | 'reset-budget';

function modelSummary(task: ConfigTask, draft: ModelDraft): string {
  const initial = initialModelDraft(task);
  const parts: string[] = [];
  if (draft.provider !== initial.provider || draft.model !== initial.model) {
    parts.push(`模型：${initial.provider} / ${initial.model} → ${draft.provider} / ${draft.model}`);
  }
  if (draft.thinking !== initial.thinking) {
    parts.push(
      `思考强度：${initial.thinking ? thinkingWord(initial.thinking) : '默认'} → ${draft.thinking ? thinkingWord(draft.thinking) : '默认'}`,
    );
  }
  if (draft.ownModel !== initial.ownModel) {
    parts.push(draft.ownModel ? '不跟全局默认' : '跟全局默认');
  }
  return parts.join('；');
}

function confirmSummary(
  confirm: ConfirmKind,
  task: ConfigTask,
  draft: ModelDraft,
  budget: BudgetDraft,
): string {
  if (confirm === 'model') return modelSummary(task, draft);
  if (confirm === 'budget') {
    const next = budgetChanges(task, budget)[0];
    const value = next?.action === 'set' ? next.value : undefined;
    return `预算：${displayValue(task.override?.budget ?? task.default_budget)} → ${displayValue(value)}`;
  }
  if (confirm === 'reset-model') return '清除这个任务的模型和思考强度设置，回到默认。';
  return '清除这个任务的预算设置，回到代码默认。';
}

export function ConfigTaskEditor({
  task,
  providers,
  global,
  save,
  onSaved,
  onClose,
}: {
  task: ConfigTask;
  providers: ConfigProvider[];
  global: ConfigGlobal | null;
  save: SaveConfig;
  /** The server's receipt: the page shows what really took effect, not what was asked for. */
  onSaved: (receipt: Awaited<ReturnType<SaveConfig>>) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => initialModelDraft(task));
  const [budget, setBudget] = useState(() => initialBudget(task));
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!taskEditable(task)) return <p className="adm-note">此任务使用专用执行通道，当前只读。</p>;
  const issue = modelIssue(providers, draft.provider, draft.model);
  const levels = thinkingLevels(findModel(providers, draft.provider, draft.model));
  const hasGlobal = Boolean(global?.provider);
  const noModelChange = modelChanges(task, draft).length === 0;
  const globalWins = hasGlobal && !draft.ownModel;

  async function commit() {
    if (!confirm || pending) return;
    setError(null);
    setPending(true);
    try {
      if (confirm === 'model' && issue) throw new Error(issue);
      const changes =
        confirm === 'model'
          ? modelChanges(task, draft)
          : confirm === 'budget'
            ? budgetChanges(task, budget)
            : resetTaskChanges(task, confirm === 'reset-model' ? 'model' : 'budget');
      onSaved(await save(changes));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label={`${task.kind} 配置编辑`} className="adm-editor">
      <div className="adm-editor-head">
        <h3 className="adm-editor-title adm-mono">{task.kind}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          取消编辑
        </Button>
      </div>
      <fieldset disabled={pending || confirm !== null} className="adm-fieldset">
        <legend className="adm-legend">模型和思考强度</legend>
        <ModelPicker
          id={id}
          providers={providers}
          provider={draft.provider}
          model={draft.model}
          onChange={(next) => {
            setError(null);
            // Picking a model only counts if it wins over the global default, so say so by default.
            setDraft({
              ...draft,
              ...next,
              ownModel: hasGlobal ? true : draft.ownModel,
              thinking: thinkingLevels(findModel(providers, next.provider, next.model)).includes(
                draft.thinking,
              )
                ? draft.thinking
                : '',
            });
          }}
        />
        {levels.length > 0 ? (
          <label htmlFor={`${id}-thinking`} className="adm-inline-field">
            <span className="adm-field-name">思考强度</span>
            <select
              id={`${id}-thinking`}
              className="adm-input"
              value={draft.thinking}
              onChange={(e) => setDraft({ ...draft, thinking: e.target.value })}
            >
              <option value="">默认</option>
              {levels.map((level) => (
                <option key={level} value={level}>
                  {thinkingWord(level)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="adm-note">这个模型没有可选的思考强度。</p>
        )}
        {hasGlobal ? (
          <label className="adm-check">
            <input
              type="checkbox"
              checked={draft.ownModel}
              onChange={(e) => setDraft({ ...draft, ownModel: e.target.checked })}
            />
            这个任务用自己的模型，不跟全局默认
          </label>
        ) : null}
        {globalWins ? (
          <p className="adm-note">
            全局默认现在优先（{global?.provider} / {global?.model}），上面选的模型先存着，不会生效。
          </p>
        ) : null}
        <div className="adm-acts">
          <Button disabled={Boolean(issue) || noModelChange} onClick={() => setConfirm('model')}>
            保存
          </Button>
          <Button variant="secondary" onClick={() => setConfirm('reset-model')}>
            恢复默认
          </Button>
        </div>
      </fieldset>
      <details className="adm-disclosure">
        <summary className="adm-summary">调用预算</summary>
        <fieldset disabled={pending || confirm !== null} className="adm-fieldset">
          <legend className="adm-legend">调用预算</legend>
          <div className="adm-field-row">
            {BUDGET_FIELDS.map(({ key, label, min, step }) => (
              <label key={key} htmlFor={`${id}-${key}`} className="adm-field">
                <span className="adm-field-name">{label}</span>
                {task.budget_wiring[key] ? (
                  <input
                    id={`${id}-${key}`}
                    className="adm-input adm-input-num"
                    type="number"
                    min={min}
                    max={key === 'timeout' ? 3599.999 : undefined}
                    step={step}
                    value={budget[key]}
                    onChange={(e) => setBudget({ ...budget, [key]: e.target.value })}
                  />
                ) : (
                  <span id={`${id}-${key}`} className="adm-unwired">
                    未接线 · 不生效
                  </span>
                )}
              </label>
            ))}
          </div>
          <p className="adm-note">{task.budget_note}</p>
          <div className="adm-acts">
            <Button
              onClick={() => {
                try {
                  budgetChanges(task, budget);
                  setError(null);
                  setConfirm('budget');
                } catch (err) {
                  setError(String(err));
                }
              }}
            >
              保存预算
            </Button>
            <Button variant="secondary" onClick={() => setConfirm('reset-budget')}>
              恢复默认预算
            </Button>
          </div>
        </fieldset>
      </details>
      {confirm && (
        <fieldset className="adm-confirm" aria-label="确认配置变更">
          <p>{confirmSummary(confirm, task, draft, budget)}</p>
          <div className="adm-acts">
            <Button disabled={pending} onClick={() => void commit()}>
              {pending ? '保存中…' : '确认变更'}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
              返回修改
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
