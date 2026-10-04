import type { ApiOperationJsonResponse, ApiOperationRequestBody } from '@/ui/lib/api';

export type ConfigData = ApiOperationJsonResponse<'getAdminConfig'>;
export type ConfigTask = ConfigData['tasks'][number];
export type ConfigProvider = ConfigData['providers'][number];
export type ConfigKey = ConfigData['keys'][number];
export type ConfigWrite = ApiOperationRequestBody<'writeAdminConfig'>;
export type ConfigReceipt = ApiOperationJsonResponse<'writeAdminConfig'>;
export type SaveConfig = (changes: ConfigWrite['changes']) => Promise<void>;
export const CONFIG_QUERY_KEY = ['admin-config'] as const;
export const SECTIONS = [
  { id: 'overview', label: '总览' },
  { id: 'flags', label: '功能开关' },
  { id: 'ai-models', label: 'AI 模型' },
  { id: 'thresholds', label: '阈值与旋钮' },
  { id: 'locale', label: '语言' },
  { id: 'runtime', label: '调度与运行' },
];
export function configSection(value: string | null): string {
  return value !== null && SECTIONS.some((s) => s.id === value) ? value : 'overview';
}
export function displayValue(value: unknown): string {
  if (value == null) return '未设置';
  if (typeof value === 'string') return value || '空值';
  return JSON.stringify(value);
}
export function matchesSearch(query: string, ...values: unknown[]): boolean {
  return values.map(displayValue).join(' ').toLowerCase().includes(query.trim().toLowerCase());
}
export function configOwner(row: ConfigKey): string {
  return row.consumer?.match(/capabilities\/([^/]+)\//)?.[1] ?? 'server';
}
export function providerUnavailable(provider: ConfigProvider): string | null {
  if (!provider.implemented || !provider.pi_provider || !provider.models?.length)
    return '未开放原生 chat 通道';
  return provider.key_present ? null : '服务端尚未配置凭据';
}
export function taskEditable(task: ConfigTask): boolean {
  return task.override_wired.provider && task.override_wired.model;
}
export const BUDGET_FIELDS = [
  { key: 'maxIterations', label: '最大轮数', min: 1, step: 1 },
  { key: 'timeout', label: '超时（秒）', min: 0.001, step: 0.001 },
  { key: 'transientRetries', label: '瞬时错误重试次数', min: 0, step: 1 },
  { key: 'maxCost', label: '费用上限（美元）', min: 0, step: 0.001 },
] as const;
export type BudgetDraft = Record<(typeof BUDGET_FIELDS)[number]['key'], string>;
export function initialBudget(task: ConfigTask): BudgetDraft {
  return Object.fromEntries(
    BUDGET_FIELDS.map(({ key }) => {
      const value = task.override?.budget?.[key] ?? task.default_budget[key];
      return [key, String(key === 'timeout' && typeof value === 'number' ? value / 1000 : value)];
    }),
  ) as BudgetDraft;
}
export function budgetChanges(task: ConfigTask, draft: BudgetDraft): ConfigWrite['changes'] {
  const budget = { ...task.override?.budget };
  for (const { key, label, min } of BUDGET_FIELDS) {
    if (!task.budget_wiring[key]) continue;
    const value = Number(draft[key]);
    if (
      !draft[key].trim() ||
      !Number.isFinite(value) ||
      value < min ||
      (key === 'timeout' && value >= 3600) ||
      ((key === 'maxIterations' || key === 'transientRetries') && !Number.isInteger(value))
    ) {
      throw new Error(`${label}无效${key === 'timeout' ? '，必须大于 0 且小于 3600 秒' : ''}`);
    }
    budget[key] = key === 'timeout' ? value * 1000 : value;
  }
  return [{ action: 'set', key: `task.${task.kind}.budget`, value: budget }];
}
export function modelChanges(
  task: ConfigTask,
  provider: string,
  model: string,
): ConfigWrite['changes'] {
  return [
    { action: 'set', key: `task.${task.kind}.provider`, value: provider },
    { action: 'set', key: `task.${task.kind}.model`, value: model },
  ];
}
export function resetTaskChanges(
  task: ConfigTask,
  group: 'model' | 'budget',
): ConfigWrite['changes'] {
  return (group === 'model' ? ['provider', 'model'] : ['budget']).map((field) => ({
    action: 'clear',
    key: `task.${task.kind}.${field}`,
  }));
}
export const inputClass =
  'rounded-[var(--r-2)] border border-[var(--line)] bg-[var(--paper-raised)] p-2 text-[var(--ink)] max-w-full';
export const tableClass =
  'w-full min-w-[640px] text-left text-[length:var(--fs-meta)] [&_th]:p-3 [&_td]:p-3 [&_td]:align-top [&_tr]:border-b [&_tr]:border-[var(--line)]';
