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

export const AdminConfigResponseSchema = z.object({
  snapshot: z.object({
    epoch: z.number().int().nonnegative(),
    hydrated_at: z.string().nullable(),
  }),
  keys: z.array(AdminConfigKeyRowSchema),
  tasks: z.array(AdminConfigTaskRowSchema),
});

export type AdminConfigResponse = z.infer<typeof AdminConfigResponseSchema>;
