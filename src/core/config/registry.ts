// YUK-1007 — 热加载配置 key 注册表（canonical keyspace）。
//
// grounding：docs/planning/2026-09-26-yuk1007-hot-reload-config.md §1.4/§1.5。
// 本文件在 `src/core/`：capability reader 只允许 import `@/core/*`（capability→server
// 边计入 capability-boundary baseline，新 module 一律回归），故 keyspace + 读面全
// 部保持 DB-free。
//
// 分层裁决（每个 env-migratable key，对应 getConfig）：
//   envMode='fallback'  — DB 行 > env 值 > codeDefault（env 是迁移期回退层 + 逃生通道）
//   envMode='priority'  — env 显式值 > DB 行 > codeDefault（operator pin 永远钉死
//                         进程，如 AI_PROVIDER_OVERRIDE——owner 裁决的 readEnvOverride
//                         语义：env pin > DB 单键覆盖）
//   envMode='pinned'    — env 值 > codeDefault，DB 层整层跳过（compose 强制项：
//                         面板写端对它返回 409，不得让 DB 行静默输给 deploy pin）
//
// `envParse` 把 env 原始 string 翻译成 DB 层同型值（flag → boolean、CSV → array、
// int → number）。返回 undefined = 「env 未表达值」→ 继续下探一层；对 flag 组
// unrecognized literal 返回 undefined = 该 reader 现 fallback 语义的等价物。
//
// 不在本表的 key：secret / boot 输入 / env schema 自身 / VITEST / NODE_ENV（§1.5
// 「不建 key」清单）。task.<kind>.* / lane.<lane>.* 用模式定义（§1.5 动态前缀）。

import { z } from 'zod';
import { PedagogyMethodId } from '@/core/pedagogy/method-library';

/** DB 层值的运行时形状（jsonb 载荷）。 */
export type ConfigValue = boolean | number | string | string[] | ConfigOverride;

/** task.<kind> / lane.<lane> / lane.global 的 override 载荷形状。 */
export interface ConfigOverride {
  provider?: string;
  model?: string;
  /** TaskSpec budget 覆盖（maxIterations/maxCost/transientRetries/timeout）。 */
  budget?: {
    maxIterations?: number;
    maxCost?: number;
    transientRetries?: number;
    timeout?: number;
  };
}

export type EnvMode = 'fallback' | 'priority' | 'pinned';

export type EnvParseFn = (raw: string) => ConfigValue | undefined;

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
  /** 备注（P2 风险标注 / 面板文案提示）。 */
  note?: string;
}

// ─── env 翻译器（每个 reader 的现 parse 语义） ──────────────────────────────

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

/** 保留空串语义的 string env（'' 是显式信号，如 JUDGE_FALLBACK_PROVIDER='' = 关兜底）。 */
const rawStringEnv: EnvParseFn = (raw) => raw;

// ─── override 载荷 schema（task.<kind>.* / lane.<lane>.* 共用） ──────────────

const budgetOverrideSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    maxCost: z.number().positive().optional(),
    transientRetries: z.number().int().min(0).optional(),
    timeout: z.number().positive().optional(),
  })
  .strict();

/** env 侧 provider override 读到的是两个独立 env（*_PROVIDER / *_MODEL），
 * getLaneOverride 每 key 各读各的 env fallback（registry envName 直挂）。 */

// ─── 注册表 ────────────────────────────────────────────────────────────────

export const CONFIG_REGISTRY: Record<string, ConfigKeyDef> = {
  // ── flags（z.boolean；env fallback 走 flagEnv） ────────────────────────────
  JUDGE_DURABLE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'JUDGE_DURABLE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  JUDGE_FALLBACK_PROVIDER: {
    // '' = 显式关闭跨 provider 兜底（env 语义）；非空 = provider 名（写端校验）。
    schema: z.string(),
    codeDefault: 'anthropic-sub',
    envName: 'JUDGE_FALLBACK_PROVIDER',
    envParse: rawStringEnv,
    tier: 'A',
  },
  MISCONCEPTION_PROMOTE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'MISCONCEPTION_PROMOTE_ENABLED',
    envParse: flagEnv,
    // compose 强制项（preflight §4.2）：DB 层跳过，写端 409。
    envMode: 'pinned',
    tier: 'A',
  },
  MISCONCEPTION_HARD_CONFIRM_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'MISCONCEPTION_HARD_CONFIRM_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  QUESTION_SUPPLY_REFILL_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'QUESTION_SUPPLY_REFILL_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  CONFUSABLE_CONTRAST_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'CONFUSABLE_CONTRAST_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  RESEARCH_MEETING_AGENT_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'RESEARCH_MEETING_AGENT_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  JUDGE_CALIBRATION_SAMPLING_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'JUDGE_CALIBRATION_SAMPLING_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED',
    envParse: flagEnv,
    envMode: 'pinned', // compose 强制
    tier: 'A',
  },
  WORKFLOW_JUDGE_OBSERVE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'WORKFLOW_JUDGE_OBSERVE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD: {
    schema: z.number().min(0).max(1),
    codeDefault: 0.85,
    envName: 'WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD',
    envParse: numberEnv,
    envMode: 'pinned', // compose 强制
    tier: 'A',
  },
  WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  WAVE6_TRIGGER_MARK_WRONG_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WAVE6_TRIGGER_MARK_WRONG_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  WAVE6_TRIGGER_MASTERY_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WAVE6_TRIGGER_MASTERY_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  WAVE6_TRIGGER_DREAMING_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'WAVE6_TRIGGER_DREAMING_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  WAVE6_TRIGGER_VERIFY_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'WAVE6_TRIGGER_VERIFY_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  NOTES_MASTERY_SUBSCRIPTION_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'NOTES_MASTERY_SUBSCRIPTION_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  AUTO_INTERVENTION_EXPANSION_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'AUTO_INTERVENTION_EXPANSION_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  INTERVENTION_DISABLED_METHOD_IDS: {
    schema: z.array(PedagogyMethodId),
    codeDefault: [],
    envName: 'INTERVENTION_DISABLED_METHOD_IDS',
    envParse: csvEnv,
    tier: 'A',
  },
  COPILOT_SUBAGENT_ENABLED: {
    schema: z.boolean(),
    codeDefault: true,
    envName: 'COPILOT_SUBAGENT_ENABLED',
    envParse: flagEnv,
    tier: 'A',
  },
  COPILOT_NUDGE_ENABLED: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'COPILOT_NUDGE_ENABLED',
    envParse: flagEnv,
    tier: 'A',
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
  COPILOT_NUDGE_STREAK_N: {
    schema: z.number().int().positive(),
    codeDefault: 3,
    envName: 'COPILOT_NUDGE_STREAK_N',
    envParse: posIntEnv,
    tier: 'A',
  },
  COPILOT_NUDGE_KC_COOLDOWN_HOURS: {
    schema: z.number().int().positive(),
    codeDefault: 24,
    envName: 'COPILOT_NUDGE_KC_COOLDOWN_HOURS',
    envParse: posIntEnv,
    tier: 'A',
  },
  SELECTION_POLICY: {
    schema: z.enum(['legacy', 'softmax_mfi']),
    codeDefault: 'softmax_mfi',
    envName: 'SELECTION_POLICY',
    envParse: (raw) => {
      const v = raw.trim();
      return v === 'legacy' || v === 'softmax_mfi' ? v : undefined;
    },
    tier: 'A',
  },
  HUB_SYNC_MODE: {
    schema: z.enum(['off', 'shadow', 'apply']),
    codeDefault: 'off',
    envName: 'HUB_SYNC_MODE',
    envParse: (raw) => {
      const v = raw.trim();
      return v === 'off' || v === 'shadow' || v === 'apply' ? v : undefined;
    },
    tier: 'A',
    // P2（architecture.md:764）：'off' 不是完整 kill switch（触发器照常记账）——
    // 面板文案必须带这句。
    note: "P2: 'off' is not a complete kill switch (trigger bookkeeping continues)",
  },
  MEMORY_RECONCILE_HANDOFF_MODE: {
    schema: z.enum(['observe', 'write', 'recover', 'drain']),
    codeDefault: 'observe',
    envName: 'MEMORY_RECONCILE_HANDOFF_MODE',
    // 原语义：env 非法值 fail-fast throw（不是 fallback 地板）——原文直通，
    // 把 throw 留在 memoryReconcileHandoffMode 的 switch 里。
    envParse: stringEnv,
    tier: 'A',
  },
  PROJECTION_IS_WRITER_ITEM_CALIBRATION: {
    schema: z.boolean(),
    codeDefault: false,
    envName: 'PROJECTION_IS_WRITER_ITEM_CALIBRATION',
    // '1' 字面量（不是 flag grammar）；其余任何值 = false 由 schema 侧保底。
    envParse: (raw) => (raw === '1' ? true : undefined),
    tier: 'A',
    note: 'P2: 写所有权翻位（Scheme A dark-ship）',
  },
  AI_RATE_LIMIT_MAX: {
    schema: z.number().int().positive(),
    codeDefault: 30,
    envName: 'AI_RATE_LIMIT_MAX',
    envParse: posIntEnv,
    tier: 'A',
  },
  AI_RATE_LIMIT_WINDOW_MS: {
    schema: z.number().int().positive(),
    codeDefault: 10_000,
    envName: 'AI_RATE_LIMIT_WINDOW_MS',
    envParse: posIntEnv,
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
    envParse: posIntEnv,
    tier: 'A',
  },
  JUDGE_CALIBRATION_WINDOW_DAYS: {
    schema: z.number().int().min(1).max(90),
    codeDefault: 7,
    envName: 'JUDGE_CALIBRATION_WINDOW_DAYS',
    envParse: posIntEnv,
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
  AI_PROVIDER_OVERRIDE: {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_OVERRIDE',
    envParse: stringEnv,
    envMode: 'priority', // env 显式 pin 恒压过 DB 行
    tier: 'A',
  },
  AI_PROVIDER_MODEL: {
    schema: z.string(),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_MODEL',
    envParse: stringEnv,
    envMode: 'priority',
    tier: 'A',
  },
  // ── jyeoo 供给旋钮 ────────────────────────────────────────────────────────
  JYEOO_RS_BINARY: {
    schema: z.string(),
    codeDefault: undefined, // 缺省 → ~/yukoval-projects/jyeoo-rs/...（reader 侧拼）
    envName: 'JYEOO_RS_BINARY',
    envParse: stringEnv,
    tier: 'A',
  },
  JYEOO_SPAWN_TIMEOUT_MS: {
    // YUK-990：env 垃圾值 NaN 直通 spawn 边界 fail-closed，不做 env 纠偏；
    // DB 层走 zod（int positive）拦写入。
    schema: z.number().int().positive(),
    codeDefault: 120_000,
    envName: 'JYEOO_SPAWN_TIMEOUT_MS',
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      return Number.parseInt(v, 10); // NaN 直通（YUK-990 语义）
    },
    tier: 'A',
  },
  JYEOO_BACKFILL_TIMEOUT_MS: {
    schema: z.number().int().positive(),
    codeDefault: undefined, // 缺省 → sessionMax × 90s（reader 侧推导）
    envName: 'JYEOO_BACKFILL_TIMEOUT_MS',
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      return Number.parseInt(v, 10); // NaN 直通
    },
    tier: 'A',
  },
  JYEOO_SPAWN_MAX_STDOUT_BYTES: {
    schema: z.number().int().positive(),
    codeDefault: 8 * 1024 * 1024,
    envName: 'JYEOO_SPAWN_MAX_STDOUT_BYTES',
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      return Number.parseInt(v, 10);
    },
    tier: 'A',
  },
  JYEOO_SPAWN_MAX_STDERR_BYTES: {
    schema: z.number().int().positive(),
    codeDefault: 1024 * 1024,
    envName: 'JYEOO_SPAWN_MAX_STDERR_BYTES',
    envParse: (raw) => {
      const v = raw.trim();
      if (v === '') return undefined;
      return Number.parseInt(v, 10);
    },
    tier: 'A',
  },
  JYEOO_DAILY_FETCH_BUDGET: {
    // 0 = 当日禁抓（operator kill-switch；不得被 coalesce 成默认，memory #606）。
    schema: z.number().int().min(0),
    codeDefault: 40,
    envName: 'JYEOO_DAILY_FETCH_BUDGET',
    envParse: nonNegIntEnv,
    tier: 'A',
  },
  // ── 引擎/资源上限 ─────────────────────────────────────────────────────────
  EXTRACT_OCR_ENGINE: {
    schema: z.enum(['glm', 'tencent']),
    codeDefault: 'glm',
    envName: 'EXTRACT_OCR_ENGINE',
    envParse: (raw) => {
      const v = raw.trim();
      return v === 'glm' || v === 'tencent' ? v : undefined;
    },
    tier: 'A',
  },
  DOCX_CONVERT_ENGINE: {
    // 'docker' 是唯一显式值（探针 seam）；unset/其余 = 自动解析（reader 侧判 === 'docker'）。
    schema: z.enum(['docker']),
    codeDefault: undefined,
    envName: 'DOCX_CONVERT_ENGINE',
    envParse: (raw) => (raw.trim() === 'docker' ? 'docker' : undefined),
    tier: 'A',
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
    envParse: posIntEnv,
    tier: 'A',
  },
  KC_DEDUP_MAX_PAIRS: {
    schema: z.number().int().min(1),
    codeDefault: 50,
    envName: 'KC_DEDUP_MAX_PAIRS',
    envParse: posIntEnv,
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
  // ── admission 面（P2：enforce 断流；JSON 原文 env fallback） ────────────────
  AI_PROVIDER_ATTEMPT_ADMISSION_MODE: {
    schema: z.enum(['off', 'observe', 'enforce']),
    codeDefault: 'off',
    envName: 'AI_PROVIDER_ATTEMPT_ADMISSION_MODE',
    envParse: (raw) => {
      const v = raw.trim();
      return v === 'off' || v === 'observe' || v === 'enforce' ? v : undefined;
    },
    tier: 'A',
    note: 'P2: enforce 断流风险（preflight §5 高风险确认）',
  },
  AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON: {
    // DB 层存的是解析后的 object（PoliciesSchema 形状）；env 层原文是 JSON 字符串，
    // 由 reader 侧 parse（保持原 throw 语义）。schema 在写端再收紧。
    schema: z.record(z.string(), z.unknown()),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    envParse: stringEnv,
    tier: 'A',
    note: 'P2: 同 admission mode',
  },
  AI_PROVIDER_SESSION_ADMISSION_MODE: {
    schema: z.enum(['off', 'observe', 'enforce']),
    codeDefault: 'off',
    envName: 'AI_PROVIDER_SESSION_ADMISSION_MODE',
    envParse: (raw) => {
      const v = raw.trim();
      return v === 'off' || v === 'observe' || v === 'enforce' ? v : undefined;
    },
    tier: 'A',
    note: 'P2: enforce 断流风险',
  },
  AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON: {
    schema: z.record(z.string(), z.unknown()),
    codeDefault: undefined,
    envName: 'AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON',
    envParse: stringEnv,
    tier: 'A',
    note: 'P2: 同 admission mode',
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
// `task.<kind>.provider` / `.model` / `.budget`：52 TaskSpec 的 per-task 覆盖，
// kind 有效性在写端经 src/ai/registry `tasks` 校验（server/write.ts 侧）。
// `lane.<lane>.provider` / `.model`：scoped lane（verify_solve / vision_judge /
// judge_calibration / global）。

export interface DynamicKeyDef {
  kind: 'task' | 'lane';
  field: 'provider' | 'model' | 'budget';
  /** task → kind；lane → lane id。 */
  scope: string;
}

export function matchDynamicConfigKey(key: string): DynamicKeyDef | null {
  const task = /^task\.([^.]+)\.(provider|model|budget)$/.exec(key);
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
  }
}

/** 查 registry：静态 key 或动态前缀 key 都返回 def；未登记 → null。 */
export function resolveKeyDef(key: string): ConfigKeyDef | null {
  const staticDef = CONFIG_REGISTRY[key];
  if (staticDef) return staticDef;
  const dyn = matchDynamicConfigKey(key);
  if (!dyn) return null;
  const schema = dynamicKeySchema(dyn);
  if (!schema) return null;
  return { schema, codeDefault: undefined, tier: 'B' };
}

export type ConfigKey = keyof typeof CONFIG_REGISTRY | (string & {});

export type ConfigSource = 'db' | 'env' | 'code-default' | 'compose-forced';
