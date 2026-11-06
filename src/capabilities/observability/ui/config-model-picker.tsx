// Provider and model selects, with what the chosen model can do. Shared by the global default and a
// single task, so both read the same catalog the same way.
import type { ConfigModel, ConfigProvider } from './config-model';
import { modelFactsLine, providerUnavailable } from './config-model';

export function modelIssue(providers: ConfigProvider[], provider: string, model: string) {
  const selected = providers.find((p) => p.name === provider);
  if (!selected) return '尚未取得 provider 目录';
  const unavailable = providerUnavailable(selected);
  if (unavailable) return unavailable;
  const entry = selected.models?.find((m) => m.id === model);
  if (!entry) return '当前模型不在目录中，保留原选择；请明确选择后再保存。';
  return entry.runnable === false ? '目录标记此模型当前不可运行，原配置未更改。' : null;
}

export function findModel(
  providers: ConfigProvider[],
  provider: string,
  model: string,
): ConfigModel | undefined {
  return providers.find((p) => p.name === provider)?.models?.find((m) => m.id === model);
}

export function ModelPicker({
  id,
  providers,
  provider,
  model,
  onChange,
}: {
  id: string;
  providers: ConfigProvider[];
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
}) {
  const selected = providers.find((p) => p.name === provider);
  const models = selected?.models ?? [];
  const entry = models.find((m) => m.id === model);
  const issue = modelIssue(providers, provider, model);
  return (
    <>
      <div className="adm-field-row">
        <label htmlFor={`${id}-provider`} className="adm-field">
          <span className="adm-field-name">Provider</span>
          <select
            id={`${id}-provider`}
            className="adm-input"
            value={provider}
            onChange={(e) => onChange({ provider: e.target.value, model: '' })}
          >
            {!selected && <option value={provider}>{provider || '请选择'} · 目录不可用</option>}
            {providers.map((p) => {
              const unavailable = providerUnavailable(p);
              return (
                <option key={p.name} value={p.name} disabled={unavailable !== null}>
                  {p.name}
                  {unavailable ? ` · ${unavailable}` : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label htmlFor={`${id}-model`} className="adm-field">
          <span className="adm-field-name">模型</span>
          <select
            id={`${id}-model`}
            className="adm-input"
            value={model}
            disabled={!selected || providerUnavailable(selected) !== null}
            onChange={(e) => onChange({ provider, model: e.target.value })}
          >
            {!entry && (
              <option value={model}>
                {model ? `${model} · 目录未列出` : '请选择模型（不会自动选第一项）'}
              </option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={m.runnable === false}>
                {m.id}
                {m.runnable === false ? ' · 当前不可运行' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entry ? <p className="adm-note">{modelFactsLine(entry)}</p> : null}
      {issue ? (
        <p role="status" className="adm-warn-line">
          {issue}
        </p>
      ) : null}
    </>
  );
}
