import { useId, useState } from 'react';
import { Button } from '@/ui/primitives/Button';
import {
  BUDGET_FIELDS,
  type ConfigProvider,
  type ConfigTask,
  type SaveConfig,
  budgetChanges,
  displayValue,
  initialBudget,
  inputClass,
  modelChanges,
  providerUnavailable,
  resetTaskChanges,
  taskEditable,
} from './config-model';

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
  if (!taskEditable(task)) return <p>此任务使用专用执行通道，当前只读。</p>;
  async function commit() {
    if (!confirm || pending) return;
    setError(null);
    setPending(true);
    try {
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
    <section aria-label={`${task.kind} 配置编辑`} className="space-y-4 bg-[var(--paper-tint)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">编辑 {task.kind}</h3>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          取消编辑
        </Button>
      </div>
      {task.global_pin && (
        <p>
          全局固定优先：{displayValue(task.global_pin)}。任务配置会保留；运行时仍以全局固定为准。
        </p>
      )}
      <fieldset disabled={pending || confirm !== null} className="space-y-3">
        <legend className="font-medium">原生 provider 与模型</legend>
        <div className="flex flex-wrap gap-4">
          <label htmlFor={`${id}-provider`}>
            Provider
            <br />
            <select
              id={`${id}-provider`}
              className={inputClass}
              value={provider}
              onChange={(e) => {
                const next = providers.find((p) => p.name === e.target.value);
                setProvider(e.target.value);
                setModel(next?.models?.[0]?.id ?? '');
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
          <label htmlFor={`${id}-model`}>
            模型
            <br />
            <select
              id={`${id}-model`}
              className={inputClass}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={Boolean(disabledReason)}
            >
              {!models.some((m) => m.id === model) && <option value={model}>请选择原生模型</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} · {m.api}
                  {m.input.includes('image') ? ' · 图像' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-[var(--ink-3)]">
          pi provider：{selected?.pi_provider ?? '不可用'} · 凭据只在服务端管理。
        </p>
        {disabledReason && <p>{disabledReason}</p>}
        <div className="flex gap-2">
          <Button
            disabled={Boolean(disabledReason) || !models.some((m) => m.id === model)}
            onClick={() => setConfirm('model')}
          >
            保存模型组合
          </Button>
          <Button variant="secondary" onClick={() => setConfirm('reset-model')}>
            恢复默认模型
          </Button>
        </div>
      </fieldset>
      <fieldset disabled={pending || confirm !== null} className="space-y-3">
        <legend className="font-medium">调用预算</legend>
        <div className="flex flex-wrap gap-4">
          {BUDGET_FIELDS.map(({ key, label, min, step }) => (
            <label key={key} htmlFor={`${id}-${key}`}>
              {label}
              <br />
              {task.budget_wiring[key] ? (
                <input
                  id={`${id}-${key}`}
                  className={`${inputClass} w-40`}
                  type="number"
                  min={min}
                  max={key === 'timeout' ? 3599.999 : undefined}
                  step={step}
                  value={budget[key]}
                  onChange={(e) => setBudget({ ...budget, [key]: e.target.value })}
                />
              ) : (
                <span id={`${id}-${key}`}>未接线 · 不生效</span>
              )}
            </label>
          ))}
        </div>
        <p className="text-[var(--ink-3)]">{task.budget_note}</p>
        <div className="flex gap-2">
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
        <fieldset
          className="space-y-2 border-l-2 border-[var(--coral)] pl-3"
          aria-label="确认配置变更"
        >
          <p>
            {confirm === 'model'
              ? `模型组合：${task.override?.provider ?? task.default_provider} / ${task.override?.model ?? task.default_model} → ${provider} / ${model}`
              : confirm === 'budget'
                ? `预算：${displayValue(task.override?.budget ?? task.default_budget)} → ${displayValue(budgetChanges(task, budget)[0])}`
                : confirm === 'reset-model'
                  ? '清除该任务的 provider 与 model 覆盖，恢复默认解析；全局固定仍优先。'
                  : '清除该任务的预算覆盖，恢复代码默认预算。'}
          </p>
          <Button disabled={pending} onClick={() => void commit()}>
            {pending ? '保存中…' : '确认变更'}
          </Button>{' '}
          <Button variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
            返回修改
          </Button>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-[var(--again-ink)]">
          {error}
        </p>
      )}
    </section>
  );
}
