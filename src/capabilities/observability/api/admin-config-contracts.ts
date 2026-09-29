// YUK-1007 — GET /api/admin/config 响应契约（读面 payload 形状）。
//
// 设计输入：settings-panel preflight §10.2 的行契约，按 PR #1498 落地后的
// store 现实收敛：source 枚举 = store 的 ConfigSource（'db' | 'env' |
// 'code-default' | 'compose-forced'）；env pin 与普通 env fallback 由 env_mode
// 区分（'priority' = operator pin）。design 的 effect/writable/owner/risk/decl
// 列在本批收敛为 wired/read_only/consumer——生效语义以实际接线为准（诚实优先
// 于面板文案），风险/owner 标注随 UI lane 批准时补。
import { z } from 'zod';

/** 读面值形状：boolean | number | string | string[] | 对象（override/policies）| null。 */
export const AdminConfigValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const AdminConfigSourceSchema = z.enum(['db', 'env', 'code-default', 'compose-forced']);
export const AdminConfigEnvModeSchema = z.enum(['fallback', 'priority', 'pinned']);

export const AdminConfigKeyRowSchema = z.object({
  key: z.string(),
  value: AdminConfigValueSchema.nullable(),
  source: AdminConfigSourceSchema,
  default: AdminConfigValueSchema.nullable(),
  /** consumer 实际消费值（真实 reader 产出，facts seam 注入）；缺席 = 直通。 */
  effective: AdminConfigValueSchema.nullable().optional(),
  effective_note: z.string().optional(),
  env_name: z.string().nullable(),
  env_mode: AdminConfigEnvModeSchema,
  tier: z.enum(['A', 'B', 'C']),
  read_only: z.boolean(),
  wired: z.boolean(),
  consumer: z.string().nullable(),
  revision: z.number().int().nullable(),
  updated_at: z.string().nullable(),
  note: z.string().optional(),
});

export const AdminConfigTaskBudgetSchema = z.object({
  maxIterations: z.number(),
  maxCost: z.number(),
  transientRetries: z.number(),
  timeout: z.number(),
});

export const AdminConfigTaskOverrideSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  budget: z.record(z.string(), z.unknown()).optional(),
});

export const AdminConfigTaskRowSchema = z.object({
  kind: z.string(),
  default_provider: z.string(),
  default_model: z.string(),
  default_budget: AdminConfigTaskBudgetSchema,
  override: AdminConfigTaskOverrideSchema.nullable(),
  override_wired: z.object({
    provider: z.boolean(),
    model: z.boolean(),
    budget: z.boolean(),
  }),
  global_pin: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .nullable(),
});

/** providers[] 行：唯一 credential 派生事实是 key_present 布尔（绝无 secret）。 */
export const AdminConfigProviderRowSchema = z.object({
  name: z.string(),
  auth_mode: z.enum(['key', 'oauth']),
  /** credential env 变量**名字**（operator 自查用）；值永不序列化。 */
  credential_env: z.string(),
  key_present: z.boolean(),
  implemented: z.boolean(),
});

/** schedules[] 行：cron 声明的静态只读投影（不触发任何 worker 行为）。 */
export const AdminConfigScheduleRowSchema = z.object({
  name: z.string(),
  cron: z.string(),
  tz: z.string(),
  owner: z.string(),
  queue: z.string(),
  source: z.enum(['capability-manifest', 'server-boss-infra', 'server-memory-infra']),
  note: z.string().optional(),
});

/** runtime 分区：运行形态常量（设计 §3.2 #6），全部来自单一声明点。 */
export const AdminConfigRuntimeSectionSchema = z.object({
  port: z.number().int().nullable(),
  db_pool_max: z.number().int(),
  queue_tiers: z.object({
    expire_seconds: z.object({ fast: z.number(), llm: z.number(), agent: z.number() }),
    retention_seconds: z.number(),
  }),
  orchestration: z.object({
    anchor_cron: z.string(),
    tz: z.string(),
    queue: z.string(),
    catchup_window_seconds: z.number(),
    tick_interval_seconds: z.number(),
    node_timeout_seconds: z.number(),
    layer_stagger_seconds: z.number(),
    dag_members: z.array(z.string()),
  }),
});

export const AdminConfigResponseSchema = z.object({
  snapshot: z.object({
    epoch: z.number().int().nonnegative(),
    hydrated_at: z.string().nullable(),
  }),
  /** 运行时事实是否已由组合根注入（false = 对应分区如实置空，不伪造）。 */
  facts_injected: z.boolean(),
  keys: z.array(AdminConfigKeyRowSchema),
  tasks: z.array(AdminConfigTaskRowSchema),
  providers: z.array(AdminConfigProviderRowSchema),
  schedules: z.object({
    read_only_note: z.string(),
    rows: z.array(AdminConfigScheduleRowSchema),
  }),
  runtime: AdminConfigRuntimeSectionSchema.nullable(),
});

export type AdminConfigResponse = z.infer<typeof AdminConfigResponseSchema>;
