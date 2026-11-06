import type { ApiOperationJsonResponse, ApiOperationRequestBody } from '@/ui/lib/api';

export type ConfigData = ApiOperationJsonResponse<'getAdminConfig'>;
export type ConfigTask = ConfigData['tasks'][number];
export type ConfigProvider = ConfigData['providers'][number];
export type ConfigKey = ConfigData['keys'][number];
export type ConfigWrite = ApiOperationRequestBody<'writeAdminConfig'>;
export type ConfigReceipt = ApiOperationJsonResponse<'writeAdminConfig'>;
export type SaveConfig = (changes: ConfigWrite['changes']) => Promise<ConfigReceipt>;
export type ConfigGlobal = NonNullable<ConfigData['global']>;
export type ConfigBinding = NonNullable<ConfigTask['effective_binding']>;
export type ConfigModel = NonNullable<ConfigProvider['models']>[number];
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
  if (provider.auth?.status === 'auth_failed') return '认证失败，请先检查服务端凭据';
  if (provider.auth?.status === 'unconfigured') return '服务端尚未配置凭据';
  if (!provider.implemented || !provider.pi_provider || !provider.models?.length)
    return '未开放原生 chat 通道';
  return provider.key_present ? null : '服务端尚未配置凭据';
}
/** Authentication is a server fact, not an inference from key presence or model count. */
export function providerStatus(provider: ConfigProvider): string {
  switch (provider.auth?.status) {
    case 'auth_failed':
      return '认证失败';
    case 'configured':
      return '已配置';
    case 'unconfigured':
      return '未配置';
    default:
      return '认证状态未知';
  }
}
/** A task's plain name and one line on what it does; the code name until it has one. */
export function taskWords(task: ConfigTask): { name: string; detail: string | null } {
  const [name, ...rest] = (task.label ?? '').split('：');
  return name ? { name, detail: rest.join('：') || null } : { name: task.kind, detail: null };
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
export interface ModelDraft {
  provider: string;
  model: string;
  /** Empty string: no level of its own. */
  thinking: string;
  ownModel: boolean;
}
export function storedThinking(task: ConfigTask): string {
  const level = task.override?.reasoning?.level;
  return typeof level === 'string' ? level : '';
}
export function initialModelDraft(task: ConfigTask): ModelDraft {
  return {
    provider: task.override?.provider ?? task.default_provider,
    model: task.override?.model ?? task.default_model,
    thinking: storedThinking(task),
    ownModel: task.override?.override_global_pin === true,
  };
}
/** Only what actually changed is written, so an untouched field never becomes an override. */
export function modelChanges(task: ConfigTask, draft: ModelDraft): ConfigWrite['changes'] {
  const initial = initialModelDraft(task);
  const key = (field: string) => `task.${task.kind}.${field}`;
  const changes: ConfigWrite['changes'] = [];
  // A task that keeps its own model needs a stored pair: the server refuses the flag alone.
  const pairMissing = !task.override?.provider || !task.override?.model;
  if (
    draft.provider !== initial.provider ||
    draft.model !== initial.model ||
    (draft.ownModel && pairMissing)
  ) {
    changes.push(
      { action: 'set', key: key('provider'), value: draft.provider },
      { action: 'set', key: key('model'), value: draft.model },
    );
  }
  if (draft.thinking !== initial.thinking) {
    changes.push(
      draft.thinking
        ? { action: 'set', key: key('reasoning'), value: { level: draft.thinking } }
        : { action: 'clear', key: key('reasoning') },
    );
  }
  if (draft.ownModel !== initial.ownModel) {
    changes.push(
      draft.ownModel
        ? { action: 'set', key: key('override_global_pin'), value: true }
        : { action: 'clear', key: key('override_global_pin') },
    );
  }
  return changes;
}
const THINKING_WORDS: Readonly<Record<string, string>> = {
  off: '关闭',
  none: '关闭',
  on: '开启',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};
export function thinkingWord(level: string | null | undefined): string {
  if (!level) return '未设置';
  return THINKING_WORDS[level] ?? level;
}
const RULE_WORDS: Readonly<Record<NonNullable<ConfigBinding['selection_rule']>, string>> = {
  env_pin: '紧急开关',
  global_pin: '全局默认',
  task_pair_priority: '这个任务自己选的',
  task_config: '这个任务自己选的',
  call_override: '专用通道',
  registry_default: '代码默认',
};
export function ruleWord(rule: ConfigBinding['selection_rule']): string {
  return rule ? RULE_WORDS[rule] : '来源未知';
}
const LANE_WORDS: Readonly<Record<string, string>> = {
  vision_judge: '判图通道',
  verify_solve: '解题核对通道',
};
export function laneWords(lanes: readonly string[]): string {
  return lanes.map((lane) => LANE_WORDS[lane] ?? lane).join('、');
}
/** One line for what a task really runs on, or why it cannot be told. */
export function bindingLine(binding: ConfigBinding | null): string {
  if (!binding) return '运行时事实尚未就绪';
  if (binding.error) return binding.error;
  return `${binding.provider} / ${binding.model}`;
}
export function bindingThinking(binding: ConfigBinding | null): string | null {
  const reasoning = binding?.reasoning;
  if (!reasoning) return null;
  if (reasoning.error) return reasoning.error;
  if (!reasoning.applied) return null;
  const applied = thinkingWord(reasoning.applied);
  return reasoning.requested && reasoning.requested !== reasoning.applied
    ? `思考 ${applied}（选的是${thinkingWord(reasoning.requested)}，这个模型取到${applied}）`
    : `思考 ${applied}`;
}
/** The model's own facts, in the words the picker shows. */
export function modelFactsLine(model: ConfigModel): string {
  const size = (n: number | null) => (n === null ? '未知' : `${Math.round(n / 1000)}k`);
  const yes = (v: boolean | 'unknown') => (v === 'unknown' ? '未知' : v ? '能' : '不能');
  const price = model.cost
    ? `每百万 token 输入 $${model.cost.input} / 输出 $${model.cost.output}`
    : '单价未知';
  return [
    `上下文 ${size(model.context_window_tokens)}`,
    `输出 ${size(model.max_output_tokens)}`,
    `用工具：${yes(model.tool_call)}`,
    `看图：${yes(model.vision)}`,
    price,
  ].join(' · ');
}
export function thinkingLevels(model: ConfigModel | undefined): string[] {
  const options = model?.reasoning_options;
  return options && options.mode !== 'unknown' ? options.values : [];
}
export function resetTaskChanges(
  task: ConfigTask,
  group: 'model' | 'budget',
): ConfigWrite['changes'] {
  const fields =
    group === 'model' ? ['provider', 'model', 'reasoning', 'override_global_pin'] : ['budget'];
  return fields.map((field) => ({
    action: 'clear',
    key: `task.${task.kind}.${field}`,
  }));
}
export const inputClass =
  'rounded-[var(--r-2)] border border-[var(--line)] bg-[var(--paper-raised)] p-2 text-[var(--ink)] max-w-full';
export const tableClass =
  'w-full min-w-[640px] text-left text-[length:var(--fs-meta)] [&_th]:p-3 [&_td]:p-3 [&_td]:align-top [&_tr]:border-b [&_tr]:border-[var(--line)]';
