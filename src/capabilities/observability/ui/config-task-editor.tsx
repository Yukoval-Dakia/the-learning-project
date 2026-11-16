import { useId, useState } from 'react';
import { Button } from '@/ui-next/public';
import {
  BUDGET_FIELDS,
  type BudgetDraft,
  type ConfigProvider,
  type ConfigTask,
  type SaveConfig,
  budgetChanges,
  displayValue,
  initialBudget,
  modelChanges,
  providerUnavailable,
  resetTaskChanges,
  taskEditable,
} from './config-model';

type ConfirmKind = 'model' | 'budget' | 'reset-model' | 'reset-budget';

/** The confirmation line for each pending change (same four texts, same order as before). */
function confirmSummary(
  confirm: ConfirmKind,
  task: ConfigTask,
  provider: string,
  model: string,
  budget: BudgetDraft,
): string {
  if (confirm === 'model') {
    return `模型组合：${task.override?.provider ?? task.default_provider} / ${task.override?.model ?? task.default_model} → ${provider} / ${model}`;
  }
  if (confirm === 'budget') {
    return `预算：${displayValue(task.override?.budget ?? task.default_budget)} → ${displayValue(budgetChanges(task, budget)[0])}`;
  }
  if (confirm === 'reset-model') {
    return '清除该任务的 provider 与 model 覆盖，恢复默认解析；全局固定仍优先。';
  }
  return '清除该任务的预算覆盖，恢复代码默认预算。';
}

export function ConfigTaskEditor({
  task,
  providers,
  save,
  onClose,
}: {
  task: ConfigTask;
  providers: ConfigProvider[];
  save: SaveConfig;
  onClose: () => void;
}) {
  const id = useId();
  const [provider, setProvider] = useState(task.override?.provider ?? task.default_provider);
  const [model, setModel] = useState(task.override?.model ?? task.default_model);
  const [budget, setBudget] = useState(() => initialBudget(task));
  const [confirm, setConfirm] = useState<
    'model' | 'budget' | 'reset-model' | 'reset-budget' | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = providers.find((p) => p.name === provider);
  const models = selected?.models ?? [];
  const disabledReason = !selected ? '尚未取得 provider 目录' : providerUnavailable(selected);
  const selectedModel = models.find((entry) => entry.id === model);
  const modelIssue =
    disabledReason ??
    (!selectedModel
      ? '当前模型不在目录中，保留原选择；请明确选择后再保存。'
      : selectedModel.runnable === false
        ? '目录标记此模型当前不可运行，原配置未更改。'
        : null);
  if (!taskEditable(task)) return <p className="adm-note">此任务使用专用执行通道，当前只读。</p>;
  async function commit() {
    if (!confirm || pending) return;
    setError(null);
    setPending(true);
    try {
      if (confirm === 'model' && modelIssue) throw new Error(modelIssue);
      const changes =
        confirm === 'model'
          ? modelChanges(task, provider, model)
          : confirm === 'budget'
            ? budgetChanges(task, budget)
            : resetTaskChanges(task, confirm === 'reset-model' ? 'model' : 'budget');
      await save(changes);
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
        <h3 className="adm-editor-title">编辑 {task.kind}</h3>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          取消编辑
        </Button>
      </div>
      {task.global_pin && (
        <p className="adm-warn-line">
          全局固定优先：{displayValue(task.global_pin)}。任务配置会保留；运行时仍以全局固定为准。
        </p>
      )}
      <fieldset disabled={pending || confirm !== null} className="adm-fieldset">
        <legend className="adm-legend">原生 provider 与模型</legend>
        <div className="adm-field-row">
          <label htmlFor={`${id}-provider`} className="adm-field">
            <span className="adm-field-name">Provider</span>
            <select
              id={`${id}-provider`}
              className="adm-input"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel('');
                setError(null);
              }}
            >
              {!selected && <option value={provider}>{provider} · 目录不可用</option>}
              {providers.map((p) => (
                <option key={p.name} value={p.name} disabled={providerUnavailable(p) !== null}>
                  {p.name}
                  {providerUnavailable(p) ? ` · ${providerUnavailable(p)}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-model`} className="adm-field">
            <span className="adm-field-name">模型</span>
            <select
              id={`${id}-model`}
              className="adm-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={Boolean(disabledReason)}
            >
              {!models.some((m) => m.id === model) && (
                <option value={model}>
                  {model ? `${model} · 已选值，当前目录未列出` : '请选择模型（不会自动选第一项）'}
                </option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id} disabled={m.runnable === false}>
                  {m.id} · {m.api ?? '协议未知'}
                  {m.runnable === false ? ' · 当前不可运行' : ''}
                  {m.input.includes('image') ? ' · 图像' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="adm-note">
          pi provider：{selected?.pi_provider ?? '不可用'} · 凭据只在服务端管理。
        </p>
        {modelIssue && (
          <p role="status" className="adm-warn-line">
            {modelIssue}
          </p>
        )}
        <p className="adm-note">
          目录刷新不会替换已选模型；更改 provider 后需明确选择模型并确认保存。
        </p>
        <div className="adm-acts">
          <Button disabled={Boolean(modelIssue)} onClick={() => setConfirm('model')}>
            保存模型组合
          </Button>
          <Button variant="secondary" onClick={() => setConfirm('reset-model')}>
            恢复默认模型
          </Button>
        </div>
      </fieldset>
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
      {confirm && (
        <fieldset className="adm-confirm" aria-label="确认配置变更">
          <p>{confirmSummary(confirm, task, provider, model, budget)}</p>
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
