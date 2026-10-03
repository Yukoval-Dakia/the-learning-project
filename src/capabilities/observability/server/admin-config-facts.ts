// YUK-1007 — GET /api/admin/config 的**运行时事实注入 seam**（providers[] /
// infra schedules / runtime 常量 / consumer-effective 值）。
//
// 为什么是注入而不是直接 import：这些事实的真相源都在 src/server/*（provider
// 注册表、boss/memory cron 注册、运行形态常量）与其他 capability（各键的
// 真实 reader）——observability 直接 import 会新增 capability→server /
// cross-capability 边，撞 capability-boundary ratchet（450 exact，禁升 baseline）。
// 组合根（server 层，server/config/admin-config-facts.ts）自由 import 一切真相
// 源后，经本 capability 的 public 入口（server→public 允许）把 facts 工厂注入
// 进来；route 每次请求调用工厂，保持热加载新鲜度（facts 不在 boot 冻结）。
//
// 诚实性契约：
//   - providers[] 只输出 key presence **布尔**与 env **名字**——credential 值
//     绝不进 payload（canary 测试钉住）。
//   - effective_values 只能来自真实 reader 调用（各 capability 的
//     config-effective-facts 模块）；reader 输出非单一标量的键只给 note。
//   - 未注入（worker 进程 / 未接线的测试挂载）时读面如实标 facts_injected=false，
//     对应分区置空/null，不伪造。
import type { ConfigEffectiveFacts } from '@/core/config/effective';

/** providers[] 行：唯一 credential 派生事实是 key_present 布尔（绝无 secret）。 */
export interface AdminConfigProviderRow {
  readonly name: string;
  readonly auth_mode: 'key' | 'oauth';
  /** credential env 变量**名字**（operator 自查用）；值永不序列化。 */
  readonly credential_env: string;
  readonly key_present: boolean;
  /** isProviderImplemented（resolveTaskProvider 同一谓词）：reserved-but-unwired 如实标 false。 */
  readonly implemented: boolean;
  /** Actual native pi identity; null for providers using a non-pi execution path. */
  readonly pi_provider?: string | null;
  readonly models?: readonly { id: string; api: string; input: readonly string[] }[];
}

/** schedules[] 行：cron 声明的静态投影（本表只读，不触发任何 worker 行为）。 */
export interface AdminConfigScheduleRow {
  readonly name: string;
  readonly cron: string;
  readonly tz: string;
  readonly owner: string;
  readonly queue: string;
  readonly source: 'capability-manifest' | 'server-boss-infra' | 'server-memory-infra';
  readonly note?: string;
}

/** runtime 分区：运行形态常量（设计 §3.2 #6），全部来自单一声明点。 */
export interface AdminConfigRuntimeSection {
  readonly port: number | null;
  readonly db_pool_max: number;
  readonly queue_tiers: {
    readonly expire_seconds: {
      readonly fast: number;
      readonly llm: number;
      readonly agent: number;
    };
    readonly retention_seconds: number;
  };
  readonly orchestration: {
    readonly anchor_cron: string;
    readonly tz: string;
    readonly queue: string;
    readonly catchup_window_seconds: number;
    readonly tick_interval_seconds: number;
    readonly node_timeout_seconds: number;
    readonly layer_stagger_seconds: number;
    /** 编排 DAG 成员名（projectDagMembers 投影）——无 cron、由 orchestrator 触发。 */
    readonly dag_members: readonly string[];
  };
}

/** 组合根注入的完整事实束（每请求重算——工厂形态保热加载新鲜度）。 */
export interface AdminConfigRuntimeFacts {
  readonly providers: readonly AdminConfigProviderRow[];
  readonly infra_schedules: readonly AdminConfigScheduleRow[];
  readonly runtime: AdminConfigRuntimeSection;
  readonly effective_values: ConfigEffectiveFacts;
}

export type AdminConfigRuntimeFactsSource = () => AdminConfigRuntimeFacts;

let factsSource: AdminConfigRuntimeFactsSource | undefined;

/** 组合根（server/index.ts boot）注入 facts 工厂；重复注入以最后一次为准。 */
export function setAdminConfigRuntimeFacts(source: AdminConfigRuntimeFactsSource): void {
  factsSource = source;
}

/** route 侧读取：未注入返回 null（读面如实标 facts_injected=false）。 */
export function getAdminConfigRuntimeFacts(): AdminConfigRuntimeFacts | null {
  return factsSource?.() ?? null;
}

/** 测试隔离用。 */
export function __resetAdminConfigRuntimeFactsForTests(): void {
  factsSource = undefined;
}
