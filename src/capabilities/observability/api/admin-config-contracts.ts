// GET /api/admin/config 响应契约（读面 payload 形状）。
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
  /** YUK-1557 — DB row's hard stop; null = permanent (or no DB row). */
  expires_at: z.string().nullable().optional(),
  /** True when the row exists but its expires_at has passed. */
  expired: z.boolean().optional(),
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
  /** Stored task.<kind>.reasoning row verbatim ({level?, reasoning_effort?}); the wire outcome lives in effective_binding.reasoning. */
  reasoning: z.record(z.string(), z.unknown()).optional(),
  /** Stored opt-in flag; true = this task's pair beats the global pin (selection_rule reports 'task_pair_priority'). */
  override_global_pin: z.boolean().optional(),
});

/**
 * YUK-1808 — the layer that produced the effective binding; same vocabulary as
 * the run record's selection_rule (providers.ts TaskSelectionRule).
 * `call_override` appears when a scoped lane (vision_judge / verify_solve)
 * serves the task — the same rule the run record writes.
 */
export const AdminConfigTaskSelectionRuleSchema = z.enum([
  'env_pin',
  'task_pair_priority',
  'call_override',
  'global_pin',
  'task_config',
  'registry_default',
]);

/** resolveTaskReasoning's outcome: stored level → what the wire will carry, or its readable error. */
export const AdminConfigTaskEffectiveReasoningSchema = z.object({
  source: z.enum(['task', 'global', 'catalog']).optional(),
  requested: z.string().nullable(),
  applied: z.string().nullable(),
  error: z.string().nullable(),
});

/**
 * The binding's credential lane from this process's view. verified_in_process=false
 * = the env/file lives outside this process (e.g. worker-only mount) — a fact,
 * never an error; credential file paths are never serialized. 'conflict' mirrors
 * the provider row's auth_mode: key + auth-file envs both set is a hard run-time
 * error, not a lane.
 */
export const AdminConfigTaskCredentialSchema = z.object({
  lane: z.enum(['key', 'oauth', 'oauth-file', 'conflict']),
  verified_in_process: z.boolean(),
});

/** Effective binding as the runtime resolver produces it; shared by the read face and the write receipt. */
export const AdminConfigTaskEffectiveBindingSchema = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  selection_rule: AdminConfigTaskSelectionRuleSchema.nullable(),
  reasoning: AdminConfigTaskEffectiveReasoningSchema.nullable(),
  credential: AdminConfigTaskCredentialSchema.nullable().optional(),
});

/** YUK-1808 — the effective global switch and the layer that produced it ('env' pin vs 'db' default). */
export const AdminConfigGlobalEffectiveSchema = z.object({
  reasoning: z
    .object({
      level: z.string().nullable(),
      source: z.enum(['db', 'env', 'code-default', 'compose-forced']),
    })
    .optional(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** The provider field's producing layer. */
  source: z.enum(['env', 'db']).nullable(),
  /** The model field's own layer — the pair can be mixed-source (env AI_PROVIDER_MODEL + DB provider). */
  model_source: z.enum(['env', 'db']).nullable().optional(),
  error: z.string().nullable(),
});

export const AdminConfigTaskRowSchema = z.object({
  kind: z.string(),
  /** Registry one-liner; the page's human-facing task label source. */
  description: z.string(),
  /** Human-facing group id (join with task_groups[] for label/order). */
  group_id: z.string(),
  effective_binding: AdminConfigTaskEffectiveBindingSchema.nullable(),
  default_provider: z.string(),
  default_model: z.string(),
  default_budget: AdminConfigTaskBudgetSchema,
  budget_wiring: z.object({
    maxIterations: z.boolean(),
    maxCost: z.boolean(),
    transientRetries: z.boolean(),
    timeout: z.boolean(),
  }),
  effective_budget: z.object({
    maxIterations: z.number().nullable(),
    maxCost: z.number().nullable(),
    transientRetries: z.number(),
    timeout: z.number(),
  }),
  budget_note: z.string(),
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

/** 三态能力事实：目录缺项为 'unknown'，不编造。 */
export const AdminConfigCapabilityTriStateSchema = z.union([z.boolean(), z.literal('unknown')]);

/** models[] 行（YUK-1563 AC1）：provider 目录桶全量模型 + 完整能力事实。 */
export const AdminConfigCatalogModelRowSchema = z.object({
  id: z.string(),
  /** 线协议；目录与协议模板都没有时为 null（unknown）。 */
  api: z.string().nullable(),
  /** 输入模态；目录未声明时为 ['unknown']。 */
  input: z.array(z.string()),
  /** 保存期 registry 是否接受（必需可执行事实齐全）。 */
  runnable: z.boolean(),
  tool_call: AdminConfigCapabilityTriStateSchema,
  reasoning: AdminConfigCapabilityTriStateSchema,
  /** models.dev reasoning_options 投影：mode + 该模型接受的层级取值（null = 无推理配置位）。 */
  reasoning_options: z
    .object({
      mode: z.enum(['effort', 'budget_tokens', 'toggle', 'unknown']),
      values: z.array(z.string()),
    })
    .nullable(),
  structured_output: AdminConfigCapabilityTriStateSchema,
  vision: AdminConfigCapabilityTriStateSchema,
  forced_tool_choice: AdminConfigCapabilityTriStateSchema,
  context_window_tokens: z.number().int().nullable(),
  max_input_tokens: z.number().int().nullable(),
  max_output_tokens: z.number().int().nullable(),
  /** 目录费率卡（USD/Mtok）；无卡为 null（unknown，不是免费）。 */
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number(),
      cache_write: z.number().optional(),
    })
    .nullable(),
});

/** providers[].auth（YUK-1563 AC3）：probe/结算事实的认证状态投影，绝无凭据值。 */
export const AdminConfigProviderAuthSchema = z.object({
  status: z.enum(['unconfigured', 'configured', 'auth_failed', 'login_lane']),
  /** 认证失败的 HTTP 状态（/models 读取或推理探针）；其余为 null。 */
  http_status: z.number().int().nullable(),
  /** 认证失败的错误类型（如 invalid_api_key）；其余为 null。 */
  error_type: z.string().nullable(),
});

/** providers[] 行：credential 派生事实只有 key_present 与 auth 状态（绝无 secret）。 */
export const AdminConfigProviderRowSchema = z.object({
  name: z.string(),
  /** ACTIVE credential lane; 'oauth-file' = auth-file lane (e.g. ChatGPT login) despite a declared 'key' mode (YUK-1833); 'conflict' = key+file envs both set — a hard error at run time. */
  auth_mode: z.enum(['key', 'oauth', 'oauth-file', 'conflict']),
  /** credential env 变量**名字**（operator 自查用）；值永不序列化。 */
  credential_env: z.string(),
  key_present: z.boolean(),
  /** Legacy chat-only availability; see implemented_for for typed execution. */
  implemented: z.boolean(),
  implemented_for: z.object({ chat: z.boolean(), typed: z.boolean() }).optional(),
  pi_provider: z.string().nullable().optional(),
  models: z.array(AdminConfigCatalogModelRowSchema).optional(),
  auth: AdminConfigProviderAuthSchema.optional(),
});

/** schedules[] 行：cron 声明的静态只读投影（不触发任何 worker 行为）。 */
export const AdminConfigScheduleRowSchema = z.object({
  name: z.string(),
  cron: z.string(),
  tz: z.string(),
  owner: z.string(),
  queue: z.string(),
  source: z.enum([
    'capability-manifest',
    'server-boss-infra',
    'server-memory-infra',
    'server-event-subscriptions',
  ]),
  note: z.string().optional(),
});

/** runtime 分区：运行形态常量，全部来自单一声明点。 */
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

/** task_groups[] row: ordered human-facing group → its task kinds (catalog order). */
export const AdminConfigTaskGroupRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  kinds: z.array(z.string()),
});

export const AdminConfigResponseSchema = z.object({
  snapshot: z.object({
    epoch: z.number().int().nonnegative(),
    hydrated_at: z.string().nullable(),
  }),
  /** 运行时事实是否已由组合根注入（false = 对应分区如实置空，不伪造）。 */
  facts_injected: z.boolean(),
  keys: z.array(AdminConfigKeyRowSchema),
  /** Effective global switch (env pin vs DB default); null = facts not injected. */
  global: AdminConfigGlobalEffectiveSchema.nullable(),
  /** YUK-1808 — ordered first layer in human language; '其他' appears only when non-empty. */
  task_groups: z.array(AdminConfigTaskGroupRowSchema),
  tasks: z.array(AdminConfigTaskRowSchema),
  providers: z.array(AdminConfigProviderRowSchema),
  schedules: z.object({
    read_only_note: z.string(),
    rows: z.array(AdminConfigScheduleRowSchema),
  }),
  runtime: AdminConfigRuntimeSectionSchema.nullable(),
});

export type AdminConfigResponse = z.infer<typeof AdminConfigResponseSchema>;
