// 内核契约「manifest/组合」（spec §2.1/§2.2，YUK-311 P1）。
// P1 字段只覆盖打样包实际行使的面（events/api/ui 声明元数据）；tasks/
// proposals/jobs/projections 等字段在第一个需要它们的包迁入时再加（第二
// 实例原则，spec 反框架护栏）。manifest 是声明元数据 + 组合期校验，不是
// 运行时插件总线；组合根见 src/capabilities/index.ts（静态、类型检查）。

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

export interface CapabilityManifest {
  name: string;
  description: string;
  /** 本包拥有/骑乘的 event actions（组合期查跨包重复声明） */
  events?: { actions: string[] };
  /** 本包的 API 面归属元数据（真实 route 文件由外壳挂载） */
  api?: { routes: ApiRouteDecl[] };
  /** 本包的 UI 面：页面路由 + today/工作台贡献块标识 */
  ui?: { pages?: UiPageDecl[]; todayBlocks?: string[] };
}

/** identity helper — 只为类型推断与调用点可读性。 */
export function defineCapability(manifest: CapabilityManifest): CapabilityManifest {
  return manifest;
}

/** 组合期校验：包名、event action、API 路由声明全局唯一，冲突即抛错。 */
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
}
