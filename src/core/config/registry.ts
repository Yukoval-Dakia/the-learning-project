// 热加载配置 key 注册表（canonical keyspace）。分层裁决（每个 env-migratable key）：
//   envMode='fallback' — DB 行 > env 值 > codeDefault（env 是迁移期回退层 + 逃生通道）
//   envMode='priority' — env 显式值 > DB 行 > codeDefault（operator pin 钉死进程）
//   envMode='pinned'   — env 值 > codeDefault，DB 层整层跳过（面板写端返回 409，
//                        不得让 DB 行静默输给 deploy pin）
// 本文件在 `src/core/`：capability reader 只能 import `@/core/*`，故 keyspace 与读面
// 保持 DB-free。详见 docs/planning/2026-09-26-yuk1007-hot-reload-config.md §1.4/§1.5。

import { z } from 'zod';
import { STUCK_RUN_THRESHOLD_MS } from '@/core/ai-run-limits';
import { PedagogyMethodId } from '@/core/pedagogy/method-library';

/** DB 层值的运行时形状（jsonb 载荷）。 */
export type ConfigValue =
  | boolean
  | number
  | string
  | string[]
  | ConfigOverride
  | Record<string, unknown>;

/** task.<kind> / lane.<lane> / lane.global 的 override 载荷形状。 */
export interface ConfigOverride {
  provider?: string;
  model?: string;
  /** TaskSpec budget 覆盖。 */
  budget?: {
    maxIterations?: number;
    maxCost?: number;
    transientRetries?: number;
    timeout?: number;
  };
  /** task.<kind>.reasoning：模型原生推理参数（键 = wire 参数名）。 */
  reasoning?: {
    reasoning_effort?: string;
  };
  /** task.<kind>.override_global_pin：显式 opt-in，task pair 优先于全局 pin。 */
  override_global_pin?: boolean;
}

export type EnvMode = 'fallback' | 'priority' | 'pinned';

export type EnvParseFn = (raw: string) => ConfigValue | undefined;

/**
 * 语义消费方（capability.operation / owner 名）。只声明「谁依赖这个事实」，
 * 不维护 reader 文件路径——读点位置由 audit:flags 从源码推导。
 */
export type ConfigConsumer = string;

/**
 * boolean env 开关的真实字面量域。必须与 envParse 逐字一致；audit:flags 用探针
 * 逐字面量核验，声明与 parser 任何分叉都失败。
 */
export interface ConfigFlagGrammar {
  trueLiterals: readonly string[];
  falseLiterals: readonly string[];
  caseInsensitive: boolean;
  /** opt-in = 默认关、字面量显式开；opt-out = 默认开、字面量显式关。 */
  polarity: 'opt-in' | 'opt-out';
}

/** 预算类键的事务读语义由片 2 引入；本片不预建。 */
export interface ConfigKeyDef {
  /** key → DB 值 zod schema（setConfig 写时校验 + hydrate 逐行 parse）。 */
  schema: z.ZodTypeAny;
  /** registry 声明的代码默认值（env/DB 都缺席时生效）。 */
  codeDefault: ConfigValue | undefined;
  /** 对应 env 名（无 env fallback 层时省略，如 locale.learner）。 */
  envName?: string;
  /** env 层语义（默认 'fallback'）。 */
  envMode?: EnvMode;
  /** env 原文 → DB 同型值；undefined = env 未表达。缺省 = 原样 string。 */
  envParse?: EnvParseFn;
  /** migration tier（A=per-call 读点已换 getConfig，B=结构改造后，C=不可热）。 */
  tier: 'A' | 'B' | 'C';
  /** 备注（面板文案提示 / 风险标注）。 */
  note?: string;
  /** 面向运营的一句话说明；flags family 必填（audit:flags 强制）。 */
  description?: string;
  /** 语义消费方；flags family 必填。 */
  consumers?: readonly ConfigConsumer[];
  /** 生效时机；flags family 必填。 */
  reload?: 'per-call' | 'snapshot' | 'restart';
  /** 暴露面；flags family 必填。credential-reference 不出现在公共读面。 */
  exposure?: 'browser-safe' | 'operator' | 'credential-reference';
  /** 仅 boolean env 开关：字面量域与默认侧。 */
  flag?: ConfigFlagGrammar;
}

// ─── env 翻译器（每个 reader 的现 parse 语义） ──────────────────────────────

/** 全仓统一 flag grammar：trim + 小写后 'true'/'1' 开、'false'/'0' 关，其余 → undefined。 */
const OPT_IN_FLAG = {
  trueLiterals: ['true', '1'],
  falseLiterals: ['false', '0'],
  caseInsensitive: true,
  polarity: 'opt-in',
} as const satisfies ConfigFlagGrammar;

const OPT_OUT_FLAG = {
  trueLiterals: ['true', '1'],
  falseLiterals: ['false', '0'],
  caseInsensitive: true,
  polarity: 'opt-out',
} as const satisfies ConfigFlagGrammar;

/** 精确字面量开关：只认 '1'，其余（含 '0'）都交给 codeDefault。 */
const EXACT_ONE_FLAG = {
  trueLiterals: ['1'],
  falseLiterals: [],
  caseInsensitive: false,
  polarity: 'opt-in',
} as const satisfies ConfigFlagGrammar;

/** parseFlag 语义：'true'/'1'→true，'false'/'0'→false，其余/空 → undefined(=落到 codeDefault)。 */
const flagEnv: EnvParseFn = (raw) => {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
};

/** 数字 env：trim → Number；非有限 = env 未表达（fallback）。 */
const numberEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 正整数 env：parseInt 直通 NaN 时 = env 未表达。 */
const posIntEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/** 非负整数 env（0 是合法值，如 JYEOO_DAILY_FETCH_BUDGET=0 kill-switch）。 */
const nonNegIntEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/**
 * 原 readPositiveInt 语义（rate-limit 组）：Number(raw) 后 floor，有限且 >0 才表达。
 * 与 posIntEnv 的差别在 '1e2'（100 vs 1）和 '0.9'（floor 后判正 vs parseInt 截断）。
 */
const posNumFloorEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};

/**
 * 原 resolvePositiveInt 语义（KC dedup int 组）：trunc(Number(raw))，'1e2'→100，
 * '0.5'→0 → fallback，'12.9'→12。
 */
const posNumTruncEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const t = Math.trunc(n);
  return t >= 1 ? t : undefined;
};

/**
 * 原 readIntInRange 的 env 段（judge-calibration 组）：parseInt，NaN → 未表达。
 * reader 侧 clamp 到 [min,max] 是公开语义，故 '0' 必须产出 0 交给 clamp，不是 fallback。
 */
const intEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
};

/**
 * jyeoo 组语义：parseInt 直通，NaN 交给 spawn 边界 fail-closed。'' 不算 unset
 * （parseInt('')=NaN），不能纠成「未表达」回落 codeDefault。
 */
const rawParseIntEnv: EnvParseFn = (raw) => Number.parseInt(raw, 10);

/**
 * JYEOO_BACKFILL_TIMEOUT_MS 语义（迁移前 `env.BACKFILL || env.SPAWN` 链）：'' 是
 * falsy = 未设置，继续下探 SPAWN 层；非数字 parseInt 直通 NaN（fail-closed）。
 */
const backfillTimeoutEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  return Number.parseInt(v, 10); // NaN 直通
};

/** 正有限数 env（可小数；≤0/NaN → 未表达）。dedup DISTANCE_MAX 这类连续旋钮。 */
const posNumEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** CSV env → string[]（去空白；空 = undefined）。 */
const csvEnv: EnvParseFn = (raw) => {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
};

/** 原样 string env（provider 名等）。trim 后空 = undefined。 */
const stringEnv: EnvParseFn = (raw) => {
  const v = raw.trim();
  return v === '' ? undefined : v;
};

// ─── override 载荷 schema（task.<kind>.* / lane.<lane>.* 共用） ──────────────

const budgetOverrideSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    maxCost: z.number().positive().optional(),
    transientRetries: z.number().int().min(0).optional(),
    timeout: z.number().positive().lt(STUCK_RUN_THRESHOLD_MS).optional(),
  })
  .strict();

/**
 * per-task 模型原生推理参数。键是模型自己的 wire 参数名，取值在解析期按该模型声明的
 * 档位校验（providers.ts assertTaskNativeReasoningParams），不用 loom 全局档位枚举。
 * 当前只接入 DeepSeek `reasoning_effort`；schema 保持 strict，避免把拼写错误发给 wire。
 */
const taskReasoningSchema = z
  .object({
    level: z.string().min(1).optional(),
    reasoning_effort: z.string().min(1).optional(),
  })
  .strict();

/** lane override 是两个独立 env（*_PROVIDER / *_MODEL）：getLaneOverride 每 key 各读各的 envName。 */

// ─── 注册表 ────────────────────────────────────────────────────────────────

export const CONFIG_REGISTRY: Record<string, ConfigKeyDef> = {
  // ── flags（z.boolean；env fallback 走 flagEnv） ────────────────────────────
  JUDGE_DURABLE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'JUDGE_DURABLE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '判分走异步 judge_run 队列；关闭时保持同步判分（回滚位）',
    consumers: ['practice.judge-durable-dispatch'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  // 提议自动应用总开关（默认关，所有环境）。关着时 writeAiProposal 不盖
  // auto_apply marker（不追溯），sweep 直接返回；开启后只应用开启之后写入的提议。
  PROPOSAL_AUTO_APPLY_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'PROPOSAL_AUTO_APPLY_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    note: '默认关：关着时新提议不盖 marker（开启后也不追溯），sweep 不应用',
    description: '创建提议时盖 auto_apply marker，并允许 sweep 自动应用',
    consumers: ['kernel.proposal-auto-apply'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  JUDGE_FALLBACK_PROVIDER: {
    // '' = 显式关闭跨 provider 兜底（env 语义）；非空 = provider 名（写端校验）。
    // reader 侧 trim 后 ' ' 也算显式关——不能裸存 raw。
    schema: z.string(),
    codeDefault: 'anthropic-sub',
    envName: 'JUDGE_FALLBACK_PROVIDER',
    envParse: (raw) => raw.trim(), // trim 后 ''（含 ' '）→ 显式关，非空 → trim 后名
    tier: 'A',
  },
  MISCONCEPTION_PROMOTE_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'MISCONCEPTION_PROMOTE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '接受猜想时生成 misconception 与 caused_by 边',
    consumers: ['agency.conjecture-accept'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  MISCONCEPTION_HARD_CONFIRM_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'MISCONCEPTION_HARD_CONFIRM_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '允许证据驱动的 soft→hard 确认轨',
    consumers: ['agency.conjecture-accountability'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  QUESTION_SUPPLY_REFILL_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'QUESTION_SUPPLY_REFILL_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '取题时按需补充见底题池',
    consumers: ['practice.supply-refill'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  JUDGE_CALIBRATION_SAMPLING_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'JUDGE_CALIBRATION_SAMPLING_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '允许付费 judge 校准抽样运行',
    consumers: ['practice.judge-calibration-sampling'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '提取后自动入队付费标注/判分',
    consumers: ['ingestion.workflow-judge-auto-enroll'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  WORKFLOW_JUDGE_OBSERVE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'WORKFLOW_JUDGE_OBSERVE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '允许付费 observe-only 判分路径',
    consumers: ['ingestion.workflow-judge-observe'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: {
    schema: z.number().min(0).max(1),
    codeDefault: 0.85,
    envName: 'WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD',
    envParse: numberEnv,
    tier: 'A',
  },
  WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '允许学生作答走多模态判分并写学习数据',
    consumers: ['ingestion.workflow-judge-student-answer'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  WAVE6_TRIGGER_MARK_WRONG_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WAVE6_TRIGGER_MARK_WRONG_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '错题笔记变化触发 note refine',
    consumers: ['notes.note-refine-trigger'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  WAVE6_TRIGGER_MASTERY_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WAVE6_TRIGGER_MASTERY_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '掌握度变化触发 note refine',
    consumers: ['notes.note-refine-trigger'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  WAVE6_TRIGGER_DREAMING_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WAVE6_TRIGGER_DREAMING_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: 'dreaming 变化触发 note refine',
    consumers: ['notes.note-refine-trigger'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  NOTES_MASTERY_SUBSCRIPTION_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'NOTES_MASTERY_SUBSCRIPTION_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '掌握度进度事件订阅生效',
    consumers: ['notes.mastery-refine-subscription'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  AUTO_INTERVENTION_EXPANSION_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'AUTO_INTERVENTION_EXPANSION_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '干预包进入 eligible 投递；关闭时仅 shadow',
    consumers: ['agency.intervention-preparation'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  INTERVENTION_DISABLED_METHOD_IDS: {
    schema: z.array(PedagogyMethodId),
    codeDefault: [],
    envName: 'INTERVENTION_DISABLED_METHOD_IDS',
    envParse: csvEnv,
    tier: 'A',
    description: '干预禁用的教学方法 id 列表（env 为 CSV，DB 为数组）',
    consumers: ['agency.intervention-preparation'],
    reload: 'per-call',
    exposure: 'operator',
  },
  COPILOT_SUBAGENT_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'COPILOT_SUBAGENT_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '允许 Copilot 派出 depth-1 researcher 子代理',
    consumers: ['copilot.researcher-subagent'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  COPILOT_NUDGE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'COPILOT_NUDGE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: 'Copilot 主动开口对用户可见（关闭时只写 shadow 证据）',
    consumers: ['copilot.nudge'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_IN_FLAG,
  },
  COPILOT_NUDGE_DAILY_MAX: {
    schema: z.number().int().positive(),
    codeDefault: 3,
    envName: 'COPILOT_NUDGE_DAILY_MAX',
    envParse: posIntEnv,
    tier: 'A',
  },
  COPILOT_NUDGE_EXPIRES_HOURS: {
    schema: z.number().int().positive(),
    codeDefault: 24,
    envName: 'COPILOT_NUDGE_EXPIRES_HOURS',
    envParse: posIntEnv,
    tier: 'A',
  },
  SELECTION_POLICY: {
    schema: z.enum(['legacy', 'softmax_mfi']),
    codeDefault: 'softmax_mfi',
    envName: 'SELECTION_POLICY',
    // 原 reader（stream-store.resolveSelectionPolicy）：裸 === 比较，无 trim——
    // ' legacy ' 落 default，不得纠成 legacy。
    envParse: (raw) => (raw === 'legacy' || raw === 'softmax_mfi' ? raw : undefined),
    tier: 'A',
    description: '练习流选题策略',
    consumers: ['practice.stream-selection'],
    reload: 'per-call',
    exposure: 'operator',
  },
  HUB_SYNC_MODE: {
    schema: z.enum(['off', 'shadow', 'apply']),
    codeDefault: 'off',
    envName: 'HUB_SYNC_MODE',
    // 原 reader 裸 === 比较（无 trim）：' apply ' → off。
    envParse: (raw) => (raw === 'off' || raw === 'shadow' || raw === 'apply' ? raw : undefined),
    tier: 'A',
    // 'off' 不是完整 kill switch（触发器照常记账）——面板文案必须带这句。
    note: "P2: 'off' is not a complete kill switch (trigger bookkeeping continues)",
    description: 'Hub 同步调和模式',
    consumers: ['notes.hub-sync-reconciliation'],
    reload: 'per-call',
    exposure: 'operator',
  },
  PROJECTION_IS_WRITER_ITEM_CALIBRATION: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'PROJECTION_IS_WRITER_ITEM_CALIBRATION',
    // '1' 字面量（不是 flag grammar）；其余任何值 = false 由 schema 侧保底。
    envParse: (raw) => (raw === '1' ? true : undefined),
    tier: 'A',
    note: 'P2: 写所有权翻位（Scheme A dark-ship）',
    description: 'item_calibration 投影 writer 翻位',
    consumers: ['kernel.projection-writer-policy'],
    reload: 'per-call',
    exposure: 'operator',
    flag: EXACT_ONE_FLAG,
  },
  PLACEMENT_PROBE_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'PLACEMENT_PROBE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
    description: '冷启动 placement 探测入口开放',
    consumers: ['practice.placement'],
    reload: 'per-call',
    exposure: 'operator',
    flag: OPT_OUT_FLAG,
  },
  AI_RATE_LIMIT_MAX: {
    schema: z.number().int().positive(),
    codeDefault: 30,
    envName: 'AI_RATE_LIMIT_MAX',
    // 原 readPositiveInt：Number+floor（'1e2'→100 而非 parseInt 的 1）。
    envParse: posNumFloorEnv,
    tier: 'A',
  },
  AI_RATE_LIMIT_WINDOW_MS: {
    schema: z.number().int().positive(),
    codeDefault: 10_000,
    envName: 'AI_RATE_LIMIT_WINDOW_MS',
    envParse: posNumFloorEnv,
    tier: 'A',
  },
  CLAUDE_CODE_MAX_RETRIES: {
    schema: z.number().int().min(0),
    codeDefault: 2,
    envName: 'CLAUDE_CODE_MAX_RETRIES',
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    },
    tier: 'A',
  },
  JUDGE_CALIBRATION_BATCH_MAX: {
    schema: z.number().int().min(1).max(50),
    codeDefault: 20,
    envName: 'JUDGE_CALIBRATION_BATCH_MAX',
    // 原 readIntInRange：'0' 产出 0 交 reader clamp→1（posIntEnv 会吞成 20）。
    envParse: intEnv,
    tier: 'A',
  },
  JUDGE_CALIBRATION_WINDOW_DAYS: {
    schema: z.number().int().min(1).max(90),
    codeDefault: 7,
    envName: 'JUDGE_CALIBRATION_WINDOW_DAYS',
    envParse: intEnv,
    tier: 'A',
  },
  JUDGE_CALIBRATION_REJUDGE_PROVIDER: {
    schema: z.string(),
    codeDefault: 'anthropic-sub',
    envName: 'JUDGE_CALIBRATION_REJUDGE_PROVIDER',
    envParse: stringEnv,
    tier: 'A',
  },
  JUDGE_CALIBRATION_REJUDGE_MODEL: {
    schema: z.string(),
    codeDefault: 'claude-opus-4-8',
    envName: 'JUDGE_CALIBRATION_REJUDGE_MODEL',
    envParse: stringEnv,
    tier: 'A',
  },
  // ── 全局 provider pin（owner 裁决：env pin > DB > default） ────────────────
  // 裸 AI_PROVIDER_OVERRIDE / AI_PROVIDER_MODEL 不注册：resolver 只消费 lane.global.*，
  // 注册裸键会产生「写进去永不生效」的静默死键。env 层经 lane.global.* 的 envName 挂接。
  // ── jyeoo 供给旋钮 ────────────────────────────────────────────────────────
  JYEOO_RS_BINARY: {
    schema: z.string(),
    codeDefault: undefined, // 缺省 → ~/yukoval-projects/jyeoo-rs/...（reader 侧拼）
    envName: 'JYEOO_RS_BINARY',
    envParse: stringEnv,
    tier: 'A',
  },
  JYEOO_SPAWN_TIMEOUT_MS: {
    // env 垃圾值 NaN 直通 spawn 边界 fail-closed，不做 env 纠偏；DB 层走 zod（int
    // positive）拦写入。'' 也是 NaN（parseInt('')），不是未表达。
    schema: z.number().int().positive(),
    codeDefault: 120_000,
    envName: 'JYEOO_SPAWN_TIMEOUT_MS',
    envParse: rawParseIntEnv,
    tier: 'A',
  },
  JYEOO_BACKFILL_TIMEOUT_MS: {
    schema: z.number().int().positive(),
    codeDefault: undefined, // 缺省 → sessionMax × 90s（reader 侧推导）
    envName: 'JYEOO_BACKFILL_TIMEOUT_MS',
    // '' 必须下探 SPAWN 层：迁移前的 `env.BACKFILL || env.SPAWN` 链把 '' 当未设置，
    // rawParseIntEnv 会把 '' 变成已表达的 NaN，撞断这层下探。SPAWN 键不可换用本
    // parser——它的直读 reader 语义就是 ''→NaN 直通，同一 env 名两面各取主 reader 语义。
    envParse: backfillTimeoutEnv,
    tier: 'A',
  },
  JYEOO_SPAWN_MAX_STDOUT_BYTES: {
    schema: z.number().int().positive(),
    codeDefault: 8 * 1024 * 1024,
    envName: 'JYEOO_SPAWN_MAX_STDOUT_BYTES',
    envParse: rawParseIntEnv,
    tier: 'A',
  },
  JYEOO_SPAWN_MAX_STDERR_BYTES: {
    schema: z.number().int().positive(),
    codeDefault: 1024 * 1024,
    envName: 'JYEOO_SPAWN_MAX_STDERR_BYTES',
    envParse: rawParseIntEnv,
    tier: 'A',
  },
  JYEOO_DAILY_FETCH_BUDGET: {
    // 0 = 当日禁抓（operator kill-switch），不得被 coalesce 成默认。
    schema: z.number().int().min(0),
    codeDefault: 40,
    envName: 'JYEOO_DAILY_FETCH_BUDGET',
    envParse: nonNegIntEnv,
    tier: 'A',
  },
  SUPPLY_NIGHTLY_SPEND_CAP_USD: {
    // 夜扫供题链（找题 + 换路 + 核验）每个学习日（Asia/Shanghai）合计 USD 上限；
    // 0 = 定位之外不再派新的付费供题（kill switch，含 supply_planner、手动 quiz-gen 和
    // file_bank_gap）；已入队的 job 仍会跑完。
    // 判定点 supply/server/spend-gate.ts。
    schema: z.number().min(0),
    codeDefault: 1,
    envName: 'SUPPLY_NIGHTLY_SPEND_CAP_USD',
    envParse: numberEnv,
    tier: 'A',
  },
  // ── 引擎/资源上限 ─────────────────────────────────────────────────────────
  EXTRACT_OCR_ENGINE: {
    schema: z.enum(['glm', 'tencent']),
    codeDefault: 'glm',
    envName: 'EXTRACT_OCR_ENGINE',
    // 原 reader 裸 === 比较（无 trim）。
    envParse: (raw) => (raw === 'glm' || raw === 'tencent' ? raw : undefined),
    tier: 'A',
    description: '提取管线 OCR 引擎',
    consumers: ['ingestion.ocr-extract'],
    reload: 'per-call',
    exposure: 'operator',
  },
  DOCX_CONVERT_ENGINE: {
    // 'docker' 是唯一显式值（探针 seam）；unset/其余 = 自动解析（reader 侧判 === 'docker'）。
    schema: z.enum(['docker']),
    codeDefault: undefined,
    envName: 'DOCX_CONVERT_ENGINE',
    envParse: (raw) => (raw === 'docker' ? 'docker' : undefined),
    tier: 'A',
    description: 'DOCX 转换引擎（docker = 显式探针 seam）',
    consumers: ['ingestion.docx-convert'],
    reload: 'per-call',
    exposure: 'operator',
  },
  // ── KC dedup + tagging match 旋钮（spec §1.4：「≤0 = 静默禁用」进 zod）──
  KC_DEDUP_DISTANCE_MAX: {
    schema: z.number().positive(),
    codeDefault: 0.1,
    envName: 'KC_DEDUP_DISTANCE_MAX',
    // env 层保原「非正/非有限 → fallback」——envParse 只出有限正值，其余 → 默认。
    envParse: posNumEnv,
    tier: 'A',
  },
  KC_DEDUP_WINDOW_DAYS: {
    schema: z.number().int().min(1),
    codeDefault: 7,
    envName: 'KC_DEDUP_WINDOW_DAYS',
    // 原 resolvePositiveInt：trunc(Number) ≥1（'1e2'→100 而非 parseInt 的 1）。
    envParse: posNumTruncEnv,
    tier: 'A',
  },
  KC_DEDUP_MAX_PAIRS: {
    schema: z.number().int().min(1),
    codeDefault: 50,
    envName: 'KC_DEDUP_MAX_PAIRS',
    envParse: posNumTruncEnv,
    tier: 'A',
  },
  TAGGING_MATCH_THRESHOLD: {
    schema: z.number(),
    codeDefault: 0.55,
    envName: 'TAGGING_MATCH_THRESHOLD',
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    },
    tier: 'A',
  },
  BACKUP_IMPORT_MAX_BYTES: {
    schema: z.number().int().min(1_000_000), // floor 1MB（过低会静默 413 每个 restore）
    codeDefault: 1_000_000_000,
    envName: 'BACKUP_IMPORT_MAX_BYTES',
    // env 垃圾值直通（reader warn + 默认），保原「非法值 → warn」语义。
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    },
    tier: 'A',
  },
  // ── 任务持续失败告警（observability/server/task-failure-alerts.ts 唯一判定） ──
  TASK_FAILURE_ALERT_CONSECUTIVE: {
    schema: z.number().int().min(2).max(100),
    codeDefault: 2,
    tier: 'A',
    note: '同一 task kind 自上次成功以来连续失败达到此次数即告警',
  },
  TASK_FAILURE_ALERT_WINDOW_HOURS: {
    schema: z.number().int().min(1).max(168),
    codeDefault: 24,
    tier: 'A',
  },
  TASK_FAILURE_ALERT_RATE: {
    schema: z.number().min(0).max(1),
    codeDefault: 0.5,
    tier: 'A',
    note: '窗口内失败率严格高于此值才告警；1 = 关闭失败率规则',
  },
  TASK_FAILURE_ALERT_MIN_RUNS: {
    // 8 次里 ≥5 次失败才算：10% 背景失败率下误报约 0.04%，20% 下约 1%；
    // 低频任务由连续失败规则兜住，不靠失败率。
    schema: z.number().int().min(2).max(1000),
    codeDefault: 8,
    tier: 'A',
  },
  TASK_FAILURE_ALERT_STALE_DAYS: {
    schema: z.number().int().min(1).max(90),
    codeDefault: 14,
    tier: 'A',
    note: '最近一次失败早于此天数的连续失败不再告警（已停用的任务不长期挂红）',
  },
  // ── admission 面（enforce 断流；mode 原文透传保 throw 语义） ──────────────
  AI_PROVIDER_ATTEMPT_ADMISSION_MODE: {
    schema: z.enum(['off', 'observe', 'enforce']),
    codeDefault: 'off',
    envName: 'AI_PROVIDER_ATTEMPT_ADMISSION_MODE',
    // 原 reader：z.enum().parse(rawTrimmed) —— 'enabled' 这类错值必须 THROW，
    // 不是 fallback 'off'（fail-open 回归）。trim 后原文交给 consumer parse。
    envParse: (raw) => {
      const v = raw.trim();
      return v === '' ? undefined : v;
    },
    tier: 'A',
    note: 'P2: enforce 断流风险（preflight §5 高风险确认）',
    description: 'provider attempt 准入模式',
    consumers: ['server.ai.provider-attempt-admission'],
    reload: 'per-call',
    exposure: 'operator',
  },
  AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: {
    // DB 层存解析后的 object：逐 lane {maxConcurrentAttempts, maxAttemptStartsPerMinute}
    // strict object；lane 名白名单（PROVIDER_ATTEMPT_ADMISSION_LANES 的写端镜像）在
    // write.ts 校验——core 不 import server（capability→server 边）。env 层原文是
    // JSON 字符串，consumer 侧 JSON.parse + zod（保原 throw 语义）。
    schema: z.record(
      z.string(),
      z
        .object({
          maxConcurrentAttempts: z.number().int().positive(),
          maxAttemptStartsPerMinute: z.number().int().positive(),
        })
        .strict(),
    ),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    envParse: stringEnv,
    tier: 'A',
    note: 'P2: 同 admission mode',
    description: 'provider attempt 逐 lane 准入策略（env JSON / DB object）',
    consumers: ['server.ai.provider-attempt-admission'],
    reload: 'per-call',
    exposure: 'operator',
  },
  AI_PROVIDER_SESSION_ADMISSION_MODE: {
    schema: z.enum(['off', 'observe', 'enforce']),
    codeDefault: 'off',
    envName: 'AI_PROVIDER_SESSION_ADMISSION_MODE',
    // 原 reader：'enabled' 类错值必须 throw（off|observe|enforce 白名单报错），
    // 不是 fallback 'off'。
    envParse: (raw) => {
      const v = raw.trim();
      return v === '' ? undefined : v;
    },
    tier: 'A',
    note: 'P2: enforce 断流风险',
    description: 'provider session 准入模式',
    consumers: ['server.ai.provider-session-admission'],
    reload: 'per-call',
    exposure: 'operator',
  },
  // ── 准入/结构化任务 provider 瞬时失败有界重试（YUK-1876）─────────────────
  ADMISSION_PROVIDER_RETRY_MAX_RETRIES: {
    schema: z.number().int().min(0).max(10),
    codeDefault: 3,
    envName: 'ADMISSION_PROVIDER_RETRY_MAX_RETRIES',
    envParse: nonNegIntEnv,
    tier: 'A',
    note: '绑定状态 429 等瞬时失败的额外付费发送上限（0=关闭 in-run 重试；发送总数=1+该值）',
  },
  ADMISSION_PROVIDER_RETRY_MAX_WAIT_MS: {
    schema: z.number().int().positive().max(600_000),
    codeDefault: 60_000,
    envName: 'ADMISSION_PROVIDER_RETRY_MAX_WAIT_MS',
    envParse: posNumFloorEnv,
    tier: 'A',
    note: 'in-run 重试的总睡眠预算；放不下的 delay 不执行（超界=明确 provider 失败）',
  },
  ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS: {
    schema: z.number().int().min(0).max(60_000),
    codeDefault: 2_000,
    envName: 'ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS',
    envParse: nonNegIntEnv,
    tier: 'A',
    note: '无 provider retry_after 时的回退退避基数（指数 2^n）',
  },
  AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: {
    // DB 层存解析后的 object：provider 名 → session lane policy 的 record（provider
    // key 白名单 isKnownProvider 在 write.ts / consumer 两侧校验）。env 层原文是 JSON
    // 字符串，consumer 侧 JSON.parse + 手工逐域校验（保原报错文案）。
    schema: z
      .record(
        z.string(),
        z
          .object({
            maxConcurrentSessions: z.number().int().min(1).max(1_000),
            maxSessionStartsPerMinute: z.number().int().min(1).max(100_000),
            maxQueuedSessions: z.number().int().min(1).max(1_000).optional(),
            maxWaitMs: z.number().int().min(1).max(300_000).optional(),
          })
          .strict(),
      )
      .refine((m) => Object.keys(m).length > 0, {
        message: 'must configure at least one provider lane',
      }),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON',
    envParse: stringEnv,
    tier: 'A',
    note: 'P2: 同 admission mode',
    description: 'provider session 逐 provider 准入策略（env JSON / DB object）',
    consumers: ['server.ai.provider-session-admission'],
    reload: 'per-call',
    exposure: 'operator',
  },
  // ── scoped lane overrides（DB 版 solve/vision 异源拨道） ─────────────────
  'lane.verify_solve.provider': {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'VERIFY_SOLVE_PROVIDER_OVERRIDE',
    envParse: stringEnv,
    tier: 'A',
  },
  'lane.verify_solve.model': {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'VERIFY_SOLVE_MODEL_OVERRIDE',
    envParse: stringEnv,
    tier: 'A',
  },
  'lane.vision_judge.provider': {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'VISION_JUDGE_PROVIDER',
    envParse: stringEnv,
    tier: 'A',
  },
  'lane.vision_judge.model': {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'VISION_JUDGE_MODEL',
    envParse: stringEnv,
    tier: 'A',
  },
  // lane.global.* = AI_PROVIDER_OVERRIDE 的 DB 位（env pin 恒压它，见 §2.2
  // ordering：arg > env global pin > DB global/task override > registry default）。
  'lane.global.reasoning': {
    schema: z
      .object({ level: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) })
      .strict(),
    codeDefault: { level: 'high' },
    tier: 'B',
  },
  'lane.global.provider': {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_OVERRIDE',
    envParse: stringEnv,
    envMode: 'priority',
    tier: 'B',
  },
  'lane.global.model': {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_MODEL',
    envParse: stringEnv,
    envMode: 'priority',
    tier: 'B',
  },
  // ── ingestion agent 周预算（启动额度门） ──────────────────────────────────
  'ingestion.agent_weekly_budget_usd': {
    // USD/周上限；0 = 显式关闭 agent 启动（kill switch）。判定点在事务内直读
    // system_config 行 + revision（不依赖 15s 快照），env 仅作无 DB 行时的
    // fallback 层。周口径 = Asia/Shanghai 自然周一 00:00 半开区间。
    schema: z.number().min(0),
    codeDefault: 20,
    envName: 'INGESTION_AGENT_WEEKLY_BUDGET_USD',
    envParse: numberEnv,
    tier: 'A',
  },
  // ── locale ────────────────────────────────────────────────────────────────
  'locale.learner': {
    schema: z.enum(['zh-CN', 'en']),
    codeDefault: 'zh-CN',
    envName: undefined, // 无 env fallback（TaskSpec pin 的 DB 位）
    tier: 'B',
  },
};

// ─── 动态前缀 key（task.<kind>.* / lane.<lane>.*） ──────────────────────────
//
// task.<kind>.{provider,model,budget,reasoning,override_global_pin}：per-task 覆盖，
// kind 有效性在写端经 src/ai/registry `tasks` 校验。lane.<lane>.{provider,model}：
// scoped lane（verify_solve / vision_judge / judge_calibration / global）。

export interface DynamicKeyDef {
  kind: 'task' | 'lane';
  field: 'provider' | 'model' | 'budget' | 'reasoning' | 'override_global_pin';
  /** task → kind；lane → lane id。 */
  scope: string;
}

export function matchDynamicConfigKey(key: string): DynamicKeyDef | null {
  const task = /^task\.([^.]+)\.(provider|model|budget|reasoning|override_global_pin)$/.exec(key);
  if (task) {
    return { kind: 'task', scope: task[1], field: task[2] as DynamicKeyDef['field'] };
  }
  const lane = /^lane\.([^.]+)\.(provider|model|budget)$/.exec(key);
  if (lane) {
    return { kind: 'lane', scope: lane[1], field: lane[2] as DynamicKeyDef['field'] };
  }
  return null;
}

/** 动态 key 的 schema（按 field 而非整 override 对象）。 */
export function dynamicKeySchema(def: DynamicKeyDef): z.ZodTypeAny | null {
  switch (def.field) {
    case 'provider':
      return z.string();
    case 'model':
      return z.string();
    case 'budget':
      return budgetOverrideSchema;
    case 'reasoning':
      return taskReasoningSchema;
    case 'override_global_pin':
      // 只有显式 true 是 opt-in；false 等同未设（也可走 clear 删行）。
      return z.boolean();
  }
}

/** 静态 key 与动态前缀 key 同一入口；未登记返回 null。 */
export function resolveKeyDef(key: string): ConfigKeyDef | null {
  const staticDef = Object.hasOwn(CONFIG_REGISTRY, key) ? CONFIG_REGISTRY[key] : undefined;
  if (staticDef) return staticDef;
  const dyn = matchDynamicConfigKey(key);
  // Every live lane key is registered explicitly above; no arbitrary lane or lane budget.
  if (!dyn || dyn.kind === 'lane') return null;
  const schema = dynamicKeySchema(dyn);
  if (!schema) return null;
  return { schema, codeDefault: undefined, tier: 'B' };
}

export type ConfigKey = keyof typeof CONFIG_REGISTRY | (string & {});

export type ConfigSource = 'db' | 'env' | 'code-default' | 'compose-forced';
