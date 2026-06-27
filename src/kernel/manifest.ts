// 内核契约「manifest/组合」（spec §2.1/§2.2，YUK-311 P1）。
// P1 字段只覆盖打样包实际行使的面（events/api/ui 声明元数据）；M4 (YUK-319)
// 夜链入容器 + 提议契约真身是 jobs/proposals 两字段的第一实例时刻，于此加入；
// tasks/projections 等字段仍待各自的第一个需求包迁入时再加（第二实例原则，
// spec 反框架护栏）。manifest 是声明元数据 + 组合期校验，不是运行时插件
// 总线；组合根见 src/capabilities/index.ts（静态、类型检查）。

/**
 * Web 标准 handler。M1 (YUK-314) 起带路径参数：server 组合根（server/app.ts）
 * 把 Hono 的 c.req.param() 透传为第二实参；无参路由的 handler 忽略它即可
 *（M0 的 (req)=>Response 形态天然兼容——JS 多余实参无害，TS 参数双变兼容）。
 */
export type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>;

export interface ApiRouteDecl {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // 形如 '/api/agents/notes'
  /**
   * 懒加载 handler 引用（M0，REV 2 D19）：声明为 thunk 保证 manifest 维持纯元数据——
   * composition.unit.test 导入 manifest 时不会拉进 @/db/client 等运行时依赖，
   * unit 分区不被污染；server 组合根（server/app.ts）挂载时才解析。
   * 无 load 的 route 是纯归属元数据（如 practice 的待迁路由），不被挂载。
   */
  load?: () => Promise<RouteHandler>;
}

export interface UiPageDecl {
  route: string; // 形如 '/agent-notes'
}

/**
 * pg-boss job handler 工厂——与各包 buildXHandler(db) 形态一致：
 * `(db) => (jobs) => Promise<void>`。参数刻意用 any：kernel 不 import
 * pg-boss/db 类型（unit 分区纯净），而 TS strictFunctionTypes 参数逆变下
 * unknown 无法零适配接收 `(db: Db) => (jobs: Job<T>[]) => …` 的具体工厂；
 * any 让包 manifest 直接引用既有工厂函数，窄化 cast 集中在注册器
 * （server/boss/register-capability-jobs.ts）一处。
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate variance escape hatch（见 docblock）
export type JobHandlerFactory = (db: any) => (jobs: any) => Promise<void>;

export interface JobDecl {
  name: string; // boss 队列名，形如 'dreaming_nightly'
  /** cron 调度；无 schedule 的是链式/按需 job（如 rejudge） */
  schedule?: { cron: string; tz: string };
  /**
   * 队列档位 → 注册器映射建队配方（handlers.ts 三档先例）：
   * llm/agent 走 createJobQueue（先建 `<name>_dlq` 再建主队列，1h/2h expire）；
   * fast 走 createOrUpdateQueue 无 DLQ（housekeeping 掉一拍下个 cron 重跑）。
   */
  queue: 'llm' | 'agent' | 'fast';
  /** 懒加载 handler 工厂（ApiRouteDecl.load 同构语义）；无 load 的 decl 是纯归属元数据，不被挂载。 */
  load?: () => Promise<JobHandlerFactory>;
}

/**
 * M5-T3 (YUK-321) — Copilot 工具声明（贡献制）。
 * name = DomainTool.name（全局唯一，validateComposition 第 6 循环守护）。
 * load 是懒加载 thunk（api.routes / jobs.handlers 同款先例）；缺省时为纯归属
 * 元数据，不被组合根挂载。返回类型用最小结构 { name }——kernel 不依赖
 * src/server 的 DomainTool 类型，类型窄化集中在组合根聚合器一处
 * （JobHandlerFactory 同约）。
 */
export interface CopilotToolDecl {
  name: string;
  load?: () => Promise<{ name: string }>;
}

/**
 * 本包拥有的 proposal kind（AiProposalPayload 判别值）。归属按 producer 域定；
 * applier 实现在包 server/proposal-appliers.ts，dispatch 见 server/proposals/
 * actions.ts 瘦壳。归属与 accept-applier 存在性解耦——有 producer 无 applier
 * 的 kind（defer/archive/judge_retraction，YUK-44）照常声明归属。
 */
export interface ProposalKindDecl {
  kind: string;
}

export interface CapabilityManifest {
  name: string;
  description: string;
  /** 本包拥有/骑乘的 event actions（组合期查跨包重复声明） */
  events?: { actions: string[] };
  /** 本包的 API 面归属元数据（真实 route 文件由外壳挂载） */
  api?: { routes: ApiRouteDecl[] };
  /** 本包的 pg-boss job 面（M4 第一实例）：注册由组合根收集挂载 */
  jobs?: { handlers: JobDecl[] };
  /** 本包拥有的 proposal kinds（M4 第一实例）：组合期查全局唯一 + 与 schema 枚举对账 */
  proposals?: { kinds: ProposalKindDecl[] };
  /** 本包贡献的 Copilot 工具（M5-T3 第一实例）：组合期查全局唯一，挂载由组合根聚合器收集 */
  copilotTools?: { tools: CopilotToolDecl[] };
  /** 本包的 UI 面：页面路由 + today/工作台贡献块标识 */
  ui?: { pages?: UiPageDecl[]; todayBlocks?: string[] };
}

/** identity helper — 只为类型推断与调用点可读性。 */
export function defineCapability(manifest: CapabilityManifest): CapabilityManifest {
  return manifest;
}

/** 组合期校验：包名、event action、API 路由、job 名、proposal kind、copilot 工具名声明全局唯一，冲突即抛错。 */
export function validateComposition(capabilities: CapabilityManifest[]): void {
  const names = new Set<string>();
  for (const cap of capabilities) {
    if (names.has(cap.name)) throw new Error(`duplicate capability name: ${cap.name}`);
    names.add(cap.name);
  }
  const actionOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const action of cap.events?.actions ?? []) {
      const owner = actionOwner.get(action);
      if (owner !== undefined) {
        throw new Error(`event action '${action}' declared by both '${owner}' and '${cap.name}'`);
      }
      actionOwner.set(action, cap.name);
    }
  }
  const routeOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const route of cap.api?.routes ?? []) {
      const key = `${route.method} ${route.path}`;
      const owner = routeOwner.get(key);
      if (owner !== undefined) {
        throw new Error(`api route '${key}' declared by both '${owner}' and '${cap.name}'`);
      }
      routeOwner.set(key, cap.name);
    }
  }
  const jobOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const job of cap.jobs?.handlers ?? []) {
      const owner = jobOwner.get(job.name);
      if (owner !== undefined) {
        throw new Error(`job '${job.name}' declared by both '${owner}' and '${cap.name}'`);
      }
      jobOwner.set(job.name, cap.name);
    }
  }
  const kindOwner = new Map<string, string>();
  for (const cap of capabilities) {
    for (const decl of cap.proposals?.kinds ?? []) {
      const owner = kindOwner.get(decl.kind);
      if (owner !== undefined) {
        throw new Error(
          `proposal kind '${decl.kind}' declared by both '${owner}' and '${cap.name}'`,
        );
      }
      kindOwner.set(decl.kind, cap.name);
    }
  }
  const copilotToolOwners = new Map<string, string>();
  for (const cap of capabilities) {
    for (const tool of cap.copilotTools?.tools ?? []) {
      const owner = copilotToolOwners.get(tool.name);
      if (owner !== undefined) {
        throw new Error(
          `copilot tool '${tool.name}' declared by both '${owner}' and '${cap.name}'`,
        );
      }
      copilotToolOwners.set(tool.name, cap.name);
    }
  }
}
