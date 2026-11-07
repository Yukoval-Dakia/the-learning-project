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
/** A dedicated-channel task has its model fixed by its wire contract; the server refuses a stored one. */
export function modelEditable(task: ConfigTask): boolean {
  return task.override_wired.provider && task.override_wired.model;
}
export function budgetEditable(task: ConfigTask): boolean {
  return Object.values(task.budget_wiring).some(Boolean);
}
export const BUDGET_FIELDS = [
  { key: 'maxIterations', label: '最大轮数', min: 1, step: 1 },
  { key: 'timeout', label: '超时（秒）', min: 0.001, step: 0.001 },
  { key: 'transientRetries', label: '瞬时错误重试次数', min: 0, step: 1 },
  { key: 'maxCost', label: '费用上限（美元）', min: 0, step: 0.001 },
] as const;
export type BudgetKey = (typeof BUDGET_FIELDS)[number]['key'];
export type BudgetDraft = Record<BudgetKey, string>;
/**
 * The value a run's caller always passes for this field, which beats a stored one. A caller's
 * maxCost is not listed: the runtime takes the lower of the two, so the stored one still counts.
 */
export function callerBudgetValue(task: ConfigTask, key: BudgetKey): string | null {
  const caller = task.caller_budget_override;
  if (!caller) return null;
  if (key === 'maxIterations') {
    return caller.maxIterations === 'unbounded' ? '不限' : `${caller.maxIterations} 轮`;
  }
  return key === 'timeout' ? `${Math.round(caller.timeoutMs / 60_000)} 分钟` : null;
}
function budgetFieldEditable(task: ConfigTask, key: BudgetKey): boolean {
  return task.budget_wiring[key] && callerBudgetValue(task, key) === null;
}
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
    if (!budgetFieldEditable(task, key)) continue;
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
/** In the field's own units and only what changed, not the stored object. */
export function budgetSummary(task: ConfigTask, draft: BudgetDraft): string {
  const before = initialBudget(task);
  const parts = BUDGET_FIELDS.filter(
    ({ key }) => budgetFieldEditable(task, key) && Number(before[key]) !== Number(draft[key]),
  ).map(({ key, label }) => `${label}：${before[key]} → ${draft[key]}`);
  return parts.length > 0 ? `预算：${parts.join('；')}` : '预算没有改动。';
}
export interface ModelDraft {
  provider: string;
  model: string;
  /** Empty string: no level of its own. */
  thinking: string;
  ownModel: boolean;
}
export function storedThinking(task: ConfigTask): string {
  const reasoning = task.override?.reasoning;
  // Same precedence as the runtime; a legacy stored 'none' means off there too.
  const level = reasoning?.level ?? reasoning?.reasoning_effort;
  if (typeof level !== 'string') return '';
  return level === 'none' ? 'off' : level;
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
  // 'none' is no parameter on the wire: the model's own default, which may not be off.
  if (reasoning.applied === 'none') {
    return reasoning.requested
      ? `思考由模型决定（选的是${thinkingWord(reasoning.requested)}，这个模型调不了）`
      : '思考由模型决定';
  }
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
    `输入上限 ${size(model.max_input_tokens)}`,
    `输出上限 ${size(model.max_output_tokens)}`,
    `用工具：${yes(model.tool_call)}`,
    `看图：${yes(model.vision)}`,
    price,
  ].join(' · ');
}
const RUNTIME_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/**
 * The levels a task can ask for, in the runtime's names (it refuses anything else). A toggle model
 * lists off/on but takes any non-off level as on; a budget model lists nothing but takes the levels
 * up to high. Off is always offered: the save receipt says if a model cannot express it.
 */
export function thinkingLevels(model: ConfigModel | undefined): string[] {
  const options = model?.reasoning_options;
  if (!options || options.mode === 'unknown') return [];
  if (options.mode === 'toggle') return ['off', 'high'];
  if (options.mode === 'budget_tokens') return ['off', 'low', 'medium', 'high'];
  return ['off', ...options.values.filter((level) => RUNTIME_LEVELS.has(level))];
}
/** A toggle model has only off and on, so its non-off level reads as on. */
export function thinkingChoiceWord(model: ConfigModel | undefined, level: string): string {
  return model?.reasoning_options?.mode === 'toggle' && level !== 'off'
    ? '开启'
    : thinkingWord(level);
}
const SLICE_PENDING = '判分变成待定，直到重新跑判分准入。';
export const SLICE_MODEL_NOTICE = `换模型后，已准入的判分切片会失配，${SLICE_PENDING}`;
// A slice is admitted for what is sent: a level joins its identity only when it changes the wire.
export const SLICE_THINKING_NOTICE = `思考强度如果真的改变了发出去的档位，已准入的判分切片也会失配，${SLICE_PENDING}同一档的不同叫法不受影响。`;
/** What a global default change does to grading tasks that move with it. */
export function globalSliceNotice(
  tasks: readonly ConfigTask[],
  pairChanged: boolean,
  thinkingChanged: boolean,
): string | null {
  const judged = tasks.filter((task) => task.slice_admission && modelEditable(task));
  const names = (list: readonly ConfigTask[]) =>
    list.map((task) => taskWords(task).name).join('、');
  const byPair = pairChanged
    ? judged.filter((task) => task.override?.override_global_pin !== true)
    : [];
  const byThinking = thinkingChanged
    ? judged.filter((task) => !task.override?.reasoning && !byPair.includes(task))
    : [];
  return (
    [
      byPair.length > 0 ? `「${names(byPair)}」跟着动。${SLICE_MODEL_NOTICE}` : null,
      byThinking.length > 0 ? `「${names(byThinking)}」跟着动。${SLICE_THINKING_NOTICE}` : null,
    ]
      .filter(Boolean)
      .join('') || null
  );
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
