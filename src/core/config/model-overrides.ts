// 模型覆盖选择链的唯一实现（纯模块，YUK-1869 片 3）。
//
// 本模块只拥有「覆盖值的选择与来源」与全局任务默认 pair 的唯一定义：给定各层
// 已解析的结构化值，逐字段决定 provider/model 来自哪一层、六规则标签是哪一条、
// reasoning 请求的层级与来源，或返回结构化配置错误。它不读 DB / env / task catalog /
// SDK / 凭据；模型是否存在、能力与 reasoning wire 映射仍由 AI owner 的 resolver
// 执行，预算仍归 task-budget，版本身份仍归 pin owner。
//
// 调用方（providers 运行时、write 事务终态校验、admin 读面、scoped lane reader）
// 只负责把各自的事实投影成这里的输入并把结构化错误翻成自己的错误类型与文案。

/**
 * 全局任务默认模型：未显式绑定 provider/model 的任务继承这一对。
 * 任务装配（src/ai/owned-task-specs.ts）把它补进 definition；改这里会影响所有
 * 未显式绑定的任务。专用协议任务在各自 tasks/** 里保留显式绑定。
 */
export const DEFAULT_TASK_MODEL = Object.freeze({
  defaultProvider: 'opencode-go',
  defaultModel: 'deepseek-v4.1-flash',
} as const);

/** 选择链的六个来源标签（run 回执 selection_rule / 配置页 effective）。 */
export type TaskSelectionRule =
  | 'env_pin' // process env provider pin (AI_PROVIDER_OVERRIDE) replaced the binding
  | 'task_pair_priority' // task.<kind>.override_global_pin opt-in beat the global pin
  | 'call_override' // explicit per-call override/provider arg
  | 'global_pin' // DB lane.global.* (or its env pair) selected the provider
  | 'task_config' // DB task.<kind>.provider with no pin present
  | 'registry_default'; // task definition default

/** 结构化的 (provider, model) 覆盖；字段缺席 = 该层不表态。 */
export interface ModelPair {
  readonly provider?: string;
  readonly model?: string;
}

/** 选择链的一层：显式 call、全局 pin、task/scoped 配置或代码默认。 */
export type ModelPairLayer = 'call' | 'global' | 'task' | 'default';

/** 逐字段选中的值与来源层；value 缺席时 layer = null。 */
export interface PairFieldSelection {
  readonly value?: string;
  readonly layer: ModelPairLayer | null;
}

/** 分层输入；调用方按自己的读取面决定哪些层存在（缺席 = 不参与）。 */
export interface PairLayers {
  readonly call?: ModelPair;
  readonly global?: ModelPair;
  readonly task?: ModelPair;
  readonly defaults?: ModelPair;
}

const LAYER_ORDER: readonly (readonly [ModelPairLayer, keyof PairLayers])[] = [
  ['call', 'call'],
  ['global', 'global'],
  ['task', 'task'],
  ['default', 'defaults'],
];

function isExpressed(value: string | undefined): value is string {
  return value !== undefined;
}

function selectField(layers: PairLayers, field: 'provider' | 'model'): PairFieldSelection {
  for (const [layer, key] of LAYER_ORDER) {
    const value = layers[key]?.[field];
    if (isExpressed(value)) return { value, layer };
  }
  return { layer: null };
}

/**
 * provider 逐字段选择：call > global > task > default。
 * `''` 视为已表态（与 resolveTaskBinding 的 `??` 语义一致），由调用方的合法性
 * 门禁决定是否可执行。defaults 必填时结果必非 undefined。
 */
export function selectPairProvider(
  layers: PairLayers & { readonly defaults: { readonly provider: string } },
): PairFieldSelection & { readonly value: string };
export function selectPairProvider(layers: PairLayers): PairFieldSelection;
export function selectPairProvider(layers: PairLayers): PairFieldSelection {
  return selectField(layers, 'provider');
}

/** model 逐字段选择：call > global > task > default。defaults 必填时结果必非 undefined。 */
export function selectPairModel(
  layers: PairLayers & { readonly defaults: { readonly model: string } },
): PairFieldSelection & { readonly value: string };
export function selectPairModel(layers: PairLayers): PairFieldSelection;
export function selectPairModel(layers: PairLayers): PairFieldSelection {
  return selectField(layers, 'model');
}

// ─── 全局 pin ────────────────────────────────────────────────────────────────

/** 单层已解析值 + 来源（与 core/config store 的 ConfigSource 同构）。 */
export interface ResolvedLayerValue {
  readonly value?: string;
  readonly source: 'db' | 'env' | 'code-default' | 'compose-forced';
}

export interface GlobalPinSelection {
  readonly provider: string;
  readonly model?: string;
  /** provider 来自 env pin 还是 DB 全局行。 */
  readonly source: 'env' | 'db';
  /** 实际生效的 model 层；无 model 时 null。 */
  readonly modelSource: 'env' | 'db' | null;
}

/**
 * 全局 pin 的合并门（YUK-1007）：env provider pin 整体替换 DB 对——DB 的
 * provider 与 model 都不再被消费，model 只认 AI_PROVIDER_MODEL；env 缺席时
 * DB/global 层以 provider 在场为门，只有 model 的行 runtime 不消费（惰性）。
 * provider 名合法性由调用方（AI adapter）在选中后校验。
 */
export function selectGlobalPin(
  provider: ResolvedLayerValue,
  model: ResolvedLayerValue,
): GlobalPinSelection | undefined {
  if (provider.source === 'env' && isExpressed(provider.value)) {
    const envModel = model.source === 'env' ? model.value : undefined;
    return {
      provider: provider.value,
      ...(envModel !== undefined ? { model: envModel } : {}),
      source: 'env',
      modelSource: envModel !== undefined ? 'env' : null,
    };
  }
  if (!isExpressed(provider.value)) return undefined;
  return {
    provider: provider.value,
    ...(model.value !== undefined ? { model: model.value } : {}),
    source: 'db',
    modelSource: model.value === undefined ? null : model.source === 'env' ? 'env' : 'db',
  };
}

// ─── 任务选择计划 ────────────────────────────────────────────────────────────

export interface TaskOverrideValues {
  readonly provider?: string;
  readonly model?: string;
  readonly overrideGlobalPin?: boolean;
}

export type TaskSelectionPlan =
  | {
      readonly mode: 'typed';
      readonly provider: string;
      readonly model: string;
      readonly selectionRule: 'call_override' | 'registry_default';
    }
  | {
      readonly mode: 'chat';
      /** task pair 压过全局 pin（YUK-1547 opt-in）。 */
      readonly taskPairBeatsGlobalPin: boolean;
      /** env/DB 全局 pin 这两层都不参与本任务的选择。 */
      readonly skipsPins: boolean;
    }
  | {
      readonly mode: 'error';
      readonly error: { readonly kind: 'typed_override_flag'; readonly taskKind: string };
    };

/**
 * 选择计划：决定 typed 短路 / opt-in 例外 / 是否跳过全局 pin，必须在读取
 * env/DB 全局 pin 之前执行——opt-in pair 的合法性错误先于非法 env pin 抛出，
 * 与既有顺序一致。
 */
export function planTaskSelection(input: {
  readonly taskKind: string;
  readonly typed: boolean;
  readonly ignoreGlobalPin: boolean;
  readonly task?: TaskOverrideValues;
  readonly call?: ModelPair;
  readonly defaults: { readonly provider: string; readonly model: string };
}): TaskSelectionPlan {
  const optIn = input.task?.overrideGlobalPin === true;
  if (input.typed) {
    if (optIn || input.ignoreGlobalPin) {
      return {
        mode: 'error',
        error: { kind: 'typed_override_flag', taskKind: input.taskKind },
      };
    }
    return {
      mode: 'typed',
      provider: input.call?.provider ?? input.defaults.provider,
      model: input.call?.model ?? input.defaults.model,
      selectionRule:
        input.call?.provider !== undefined || input.call?.model !== undefined
          ? 'call_override'
          : 'registry_default',
    };
  }
  return {
    mode: 'chat',
    taskPairBeatsGlobalPin: optIn,
    skipsPins: optIn || input.ignoreGlobalPin,
  };
}

// ─── chat 路由 ───────────────────────────────────────────────────────────────

/** 已解析（但未必合法）的 DB task provider：raw 供错误文案，known 供选择。 */
export interface TaskProviderProjection {
  readonly raw?: string;
  readonly known?: string;
}

export type ChatProviderRoute =
  | { readonly provider: string; readonly selectionRule: TaskSelectionRule }
  | {
      readonly error: {
        readonly kind: 'task_provider_unknown';
        readonly rawProvider: string;
      };
    };

/**
 * chat provider 选择：env pin（整体替换显式 call）> 显式 call > DB global >
 * DB task > registry default；opt-in 时 pin 层被跳过、call 仍最高。
 * DB task provider 在场但无法解析、且没有任何更高层 provider 时返回结构化错误
 * （读端绝不静默回落）。
 */
export function selectChatProviderRoute(input: {
  readonly call?: ModelPair;
  readonly envPin?: ModelPair;
  readonly globalSwitch?: ModelPair;
  readonly taskProvider?: TaskProviderProjection;
  readonly defaultProvider: string;
  readonly taskPairBeatsGlobalPin: boolean;
}): ChatProviderRoute {
  const effectiveCall = input.envPin ?? input.call;
  const rawTaskProvider = input.taskProvider?.raw;
  const knownTaskProvider = input.taskProvider?.known;
  if (
    !effectiveCall?.provider &&
    !input.globalSwitch?.provider &&
    rawTaskProvider &&
    !knownTaskProvider
  ) {
    return { error: { kind: 'task_provider_unknown', rawProvider: rawTaskProvider } };
  }
  const provider =
    effectiveCall?.provider ??
    input.globalSwitch?.provider ??
    knownTaskProvider ??
    input.defaultProvider;
  const selectionRule: TaskSelectionRule = input.envPin
    ? 'env_pin'
    : input.taskPairBeatsGlobalPin && !input.call?.provider
      ? 'task_pair_priority'
      : input.call?.provider !== undefined || input.call?.model !== undefined
        ? 'call_override'
        : input.globalSwitch?.provider
          ? 'global_pin'
          : knownTaskProvider
            ? 'task_config'
            : 'registry_default';
  return { provider, selectionRule };
}

export type ChatModelRoute =
  | { readonly model: string }
  | {
      readonly error: {
        readonly kind: 'explicit_model_required';
        /** 触发 provider 的来源（错误文案用）。 */
        readonly source: 'env' | 'db';
      };
    };

/**
 * chat model 选择：env/call 模型 > global model > DB task model > 默认。
 * 「provider 来自全局 switch 但该 provider 必须显式给 model」时返回结构化错误；
 * 判定用 truthiness（空串按缺席处理），与既有写/读契约一致。
 */
export function selectChatModelRoute(input: {
  readonly call?: ModelPair;
  readonly envPinActive: boolean;
  readonly globalSwitch?: ModelPair;
  readonly taskModel?: string;
  readonly defaultModel: string;
  readonly providerRequiresExplicitModel: boolean;
}): ChatModelRoute {
  const cameFromGlobalSwitch =
    input.envPinActive || (!input.call?.provider && input.globalSwitch?.provider !== undefined);
  if (
    cameFromGlobalSwitch &&
    input.providerRequiresExplicitModel &&
    !input.call?.model &&
    !input.globalSwitch?.model &&
    !input.taskModel
  ) {
    return {
      error: {
        kind: 'explicit_model_required',
        source: input.envPinActive ? 'env' : 'db',
      },
    };
  }
  const selection = selectPairModel({
    call: input.call,
    global: input.globalSwitch,
    task: { model: input.taskModel },
    defaults: { model: input.defaultModel },
  });
  return { model: selection.value };
}

// ─── reasoning 请求 ──────────────────────────────────────────────────────────

/** pi thinking 层级词汇（存储值；wire 映射仍归 AI adapter）。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** 存储层兼容：早期 catalog 写的 'none' 与 'off' 同意图。 */
const LEGACY_DISABLE_ALIAS = 'none';
const DISABLE_LEVEL: ThinkingLevelName = 'off';

export interface TaskReasoningValues {
  readonly level?: string;
  /** legacy key：值按同一 level 词汇读。 */
  readonly reasoning_effort?: string;
}

export interface ReasoningRequest {
  /** 命中的配置层。 */
  readonly source: 'task' | 'global';
  /** 报错/回执用的 key 名。 */
  readonly sourceKey: string;
  /** 存储原值（legacy 'none' 保留给回执）。 */
  readonly requested: string;
  readonly level: ThinkingLevelName;
}

export type ReasoningRequestSelection =
  | { readonly kind: 'none' }
  | { readonly kind: 'request'; readonly request: ReasoningRequest }
  | {
      readonly kind: 'error';
      readonly error: {
        readonly kind: 'invalid_level';
        readonly sourceKey: string;
        readonly level: string;
      };
    };

/**
 * reasoning 请求选择：task level > global level > 无请求（catalog 默认）。
 * 只有「层级名不在词汇表」是配置错误；有效但模型不支持的档位留给 AI adapter
 * 的 wire 决议（向上取整/toggle/none）。
 */
export function selectReasoningRequest(input: {
  readonly taskKind: string;
  readonly task?: TaskReasoningValues;
  readonly global?: TaskReasoningValues;
}): ReasoningRequestSelection {
  const taskLevel = input.task?.level ?? input.task?.reasoning_effort;
  const globalLevel = input.global?.level ?? input.global?.reasoning_effort;
  const rawRequested = taskLevel ?? globalLevel;
  if (rawRequested === undefined) return { kind: 'none' };
  const fromTask = taskLevel !== undefined;
  const sourceKey = fromTask ? `task.${input.taskKind}.reasoning` : 'lane.global.reasoning';
  const requested = rawRequested === LEGACY_DISABLE_ALIAS ? DISABLE_LEVEL : rawRequested;
  if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
    return {
      kind: 'error',
      error: { kind: 'invalid_level', sourceKey, level: requested },
    };
  }
  return {
    kind: 'request',
    request: {
      source: fromTask ? 'task' : 'global',
      sourceKey,
      requested: rawRequested,
      level: requested as ThinkingLevelName,
    },
  };
}

// ─── scoped lane（verify_solve / vision_judge） ──────────────────────────────

/**
 * scoped lane 覆盖值的激活规则：
 * - `provider`（vision_judge）：必须有 provider 才激活；只有 model 的行保持
 *   惰性。env provider pin 在场时 scoped lane 在调用路径上不执行。
 * - `model`（verify_solve）：合法 model-only 同源换模；provider 在场时整对生效。
 */
export function selectScopedLaneOverride(input: {
  readonly lane: ModelPair;
  readonly envPinActive?: boolean;
  readonly activation: 'provider' | 'model';
}): ModelPair | undefined {
  if (input.activation === 'provider' && input.envPinActive === true) return undefined;
  if (input.lane.provider) {
    return {
      provider: input.lane.provider,
      ...(input.lane.model ? { model: input.lane.model } : {}),
    };
  }
  if (input.activation === 'model' && input.lane.model) {
    return { model: input.lane.model };
  }
  return undefined;
}
