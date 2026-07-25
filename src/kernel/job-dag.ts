// 夜间任务编排 DAG（YUK-758）——纯拓扑内核，无 IO。
//
// 立意：把夜链任务的依赖从「钟表错峰」搬进 manifest 声明贡献制（与路由/工具/事件
// 同一登记教义）。JobDecl.dependsOn 声明的边在此被校验（缺引用 / 非成员引用 /
// 自环 / 成环）并被 orchestrator 消费。kernel 保持纯净（manifest.unit 分区不被
// DB/pg-boss 污染）：本文件只做集合/图算法，运行时驱动在 src/server/orchestration/。
//
// 成员语义（membership）：JobDecl 上**存在** `dependsOn` 字段（哪怕 `[]`）即声明
// 该 job 为编排图成员；字段缺席 = 裸 cron，orchestrator 不碰。`[]` = 根（run 起
// 步即入队）。每条边引用一个上游 job 名，上游**必须**同为图成员。
//
// 边的失败语义（逐边）：默认**硬**（上游失败/跳过 → 下游跳过，留 skip 痕迹）；
// 标 `soft` 的边 → 上游失败下游照跑，但 orchestrator 传入 stale 标记。

/** 一条依赖边的规范形。 */
export interface JobDependency {
  /** 上游 job 名（必须是已声明的图成员）。 */
  job: string;
  /** 软边：上游失败/跳过时下游仍跑（带 stale 标记）。缺省 false = 硬边。 */
  soft?: boolean;
}

/** manifest 里可写字符串简写（硬边）或对象（可标 soft）。 */
export type JobDependencyDecl = string | JobDependency;

/** 规范化一条依赖声明为 { job, soft } 满形。 */
export function normalizeJobDependency(dep: JobDependencyDecl): Required<JobDependency> {
  return typeof dep === 'string'
    ? { job: dep, soft: false }
    : { job: dep.job, soft: dep.soft ?? false };
}

/** 一个图成员的最小输入（从 manifest JobDecl + 归属包名投影而来）。 */
export interface JobDagMemberInput {
  name: string;
  /** 归属 capability 名，仅用于错误信息可读性。 */
  owner: string;
  dependsOn: readonly JobDependencyDecl[];
}

export interface JobDagNode {
  name: string;
  owner: string;
  /** 规范化后的上游边。 */
  deps: Required<JobDependency>[];
}

export interface JobDag {
  /** name → 节点。 */
  nodes: Map<string, JobDagNode>;
  /** 无上游的根（run 起步入队）。 */
  roots: string[];
  /** upstream name → 依赖它的下游边列表（反向邻接，orchestrator 推进用）。 */
  dependents: Map<string, { job: string; soft: boolean }[]>;
}

export class JobDagError extends Error {
  override name = 'JobDagError';
}

/**
 * 从成员输入构图。假定输入已通过 {@link validateJobDag}（无缺引用/自环/成环）；
 * 未经校验直接建图不做防御——校验与建图分离，orchestrator 启动路径先校验后建。
 */
export function buildJobDag(members: readonly JobDagMemberInput[]): JobDag {
  const nodes = new Map<string, JobDagNode>();
  const dependents = new Map<string, { job: string; soft: boolean }[]>();
  for (const m of members) {
    // Self-defensive against a duplicate member name even when a caller bypasses
    // validateComposition (buildOrchestrationDag / tests call buildJobDag directly).
    // A silent Map overwrite would drop one capability's job from the DAG.
    if (nodes.has(m.name)) {
      throw new JobDagError(`duplicate DAG member name '${m.name}' (${m.owner})`);
    }
    nodes.set(m.name, {
      name: m.name,
      owner: m.owner,
      deps: m.dependsOn.map(normalizeJobDependency),
    });
    dependents.set(m.name, []);
  }
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      const list = dependents.get(dep.job);
      // buildJobDag 契约：调用前已过 validateJobDag（dep.job 一定是成员）。若某上游不在
      // nodes 里，说明调用方跳过了校验——fail fast，绝不发明幻影反向边掩盖集成错误。
      if (!list) {
        throw new JobDagError(
          `buildJobDag: dependency '${dep.job}' of '${node.name}' is not a declared member (was validateJobDag called?)`,
        );
      }
      list.push({ job: node.name, soft: dep.soft });
    }
  }
  const roots = [...nodes.values()].filter((n) => n.deps.length === 0).map((n) => n.name);
  return { nodes, roots, dependents };
}

/**
 * 找一条有向环并返回其节点路径（用于错误信息）；无环返回 null。
 * 三色 DFS：white=未访问 gray=在栈上 black=已完成。gray→gray 命中回边即环。
 */
export function findCycle(members: readonly JobDagMemberInput[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const m of members) {
    adj.set(
      m.name,
      m.dependsOn.map((d) => normalizeJobDependency(d).job),
    );
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  function dfs(name: string): string[] | null {
    color.set(name, GRAY);
    stack.push(name);
    for (const next of adj.get(name) ?? []) {
      // 缺引用（next 非成员）不是本函数职责——validateJobDag 先拦。这里跳过未知节点。
      if (!adj.has(next)) continue;
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // 回边：从栈里 next 起截到当前节点即环路径。
        const idx = stack.indexOf(next);
        return [...stack.slice(idx), next];
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(name, BLACK);
    return null;
  }

  for (const m of members) {
    if ((color.get(m.name) ?? WHITE) === WHITE) {
      const cycle = dfs(m.name);
      if (cycle) return cycle;
    }
  }
  return null;
}

/**
 * 校验图成员集：
 *  1. 成员名唯一（无重复成员）。
 *  2. 每条边的上游必须是**存在的 job**（allJobNames）——否则缺引用。
 *  3. 上游必须**同为图成员**（memberNames）——依赖一个裸 cron job 无意义（orchestrator
 *     不追踪它），拦下。
 *  4. 无自环。
 *  5. 单节点内无重复上游。
 *  6. 全图无环。
 *
 * @param members 图成员（dependsOn 已声明的 job）。
 * @param allJobNames 组合根里**全部** job 名（含裸 cron），用于区分「缺引用」与「引用了非成员」。
 */
export function validateJobDag(
  members: readonly JobDagMemberInput[],
  allJobNames: ReadonlySet<string>,
): void {
  // 重复成员名显式拦（YUK-758 review ToTap）：`new Set(members.map(...))` 会**静默**去重，
  // 让两条同名成员通过校验，与本函数「校验图成员集」的契约不符。生产路径上
  // validateComposition 的 jobOwner 唯一性先拦一道，但本函数是导出的公共校验入口
  // （测试 / 未来独立校验路径直调），契约须自洽——否则返回假阴性「合法」。
  const memberNames = new Set<string>();
  for (const m of members) {
    if (memberNames.has(m.name)) {
      throw new JobDagError(`duplicate DAG member name '${m.name}' (${m.owner})`);
    }
    memberNames.add(m.name);
  }
  for (const m of members) {
    const seen = new Set<string>();
    for (const decl of m.dependsOn) {
      const { job: upstream } = normalizeJobDependency(decl);
      if (upstream === m.name) {
        throw new JobDagError(`job '${m.name}' (${m.owner}) declares a self-dependency`);
      }
      if (seen.has(upstream)) {
        throw new JobDagError(
          `job '${m.name}' (${m.owner}) declares duplicate dependency on '${upstream}'`,
        );
      }
      seen.add(upstream);
      if (!allJobNames.has(upstream)) {
        throw new JobDagError(`job '${m.name}' (${m.owner}) depends on unknown job '${upstream}'`);
      }
      if (!memberNames.has(upstream)) {
        throw new JobDagError(
          `job '${m.name}' (${m.owner}) depends on '${upstream}', which is not an orchestrated DAG member (it has no dependsOn declaration)`,
        );
      }
    }
  }
  const cycle = findCycle(members);
  if (cycle) {
    throw new JobDagError(`job dependency cycle detected: ${cycle.join(' -> ')}`);
  }
}
