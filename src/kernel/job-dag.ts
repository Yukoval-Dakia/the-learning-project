// 夜间任务编排 DAG —— 纯拓扑内核，无 IO。依赖由 manifest 的 dependsOn 声明，
// 在此校验并由 orchestrator 消费；运行时驱动在 src/server/orchestration/。
//
// 成员：存在 dependsOn（哪怕 []）即为图成员；缺席 = 裸 cron。[] = 根。上游必须
// 同为图成员。硬边失败会跳过下游；soft 边只表示不阻塞，调度行记 stale，handler
// 收不到信号。not_needed/degraded 不连坐跳过。

import type { NightlyEligibilityFn } from './nightly-eligibility';

/** 一条依赖边的规范形。 */
export interface JobDependency {
  /** 上游 job 名（必须是已声明的图成员）。 */
  job: string;
  /** 软边：上游失败/跳过时下游仍跑，调度行记 stale。缺省 false = 硬边。 */
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
  /** 入队前资格判定。缺省 = 照旧入队。 */
  eligibility?: NightlyEligibilityFn;
}

export interface JobDagNode {
  name: string;
  owner: string;
  /** 规范化后的上游边。 */
  deps: Required<JobDependency>[];
  eligibility?: NightlyEligibilityFn;
}

export interface JobDag {
  /** name → 节点。 */
  nodes: Map<string, JobDagNode>;
  /** 无上游的根（run 起步入队）。 */
  roots: string[];
  /** 反向邻接：upstream name → 依赖它的下游边。 */
  dependents: Map<string, { job: string; soft: boolean }[]>;
}

export class JobDagError extends Error {
  override name = 'JobDagError';
}

/**
 * 从已校验的成员构图；校验与建图分离，orchestrator 启动路径先校验后建。
 */
export function buildJobDag(members: readonly JobDagMemberInput[]): JobDag {
  const nodes = new Map<string, JobDagNode>();
  const dependents = new Map<string, { job: string; soft: boolean }[]>();
  for (const m of members) {
    // Guard duplicates even when a caller bypasses validateComposition: a silent
    // Map overwrite would drop one capability's job.
    if (nodes.has(m.name)) {
      throw new JobDagError(`duplicate DAG member name '${m.name}' (${m.owner})`);
    }
    nodes.set(m.name, {
      name: m.name,
      owner: m.owner,
      deps: m.dependsOn.map(normalizeJobDependency),
      ...(m.eligibility ? { eligibility: m.eligibility } : {}),
    });
    dependents.set(m.name, []);
  }
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      const list = dependents.get(dep.job);
      // Caller skipped validation: fail fast, never invent a phantom edge.
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
 * 找一条有向环并返回节点路径；无环返回 null。重复成员名直接抛，否则 Map 覆盖
 * 会漏判真环。
 */
export function findCycle(members: readonly JobDagMemberInput[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const m of members) {
    if (adj.has(m.name)) {
      throw new JobDagError(`duplicate DAG member name '${m.name}' (${m.owner})`);
    }
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
      // 缺引用由 validateJobDag 拦；这里跳过未知节点。
      if (!adj.has(next)) continue;
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // 回边：从栈中 next 截到当前节点即环。
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
 * @param allJobNames 组合根里全部 job 名，用于区分缺引用与非成员引用。
 */
export function validateJobDag(
  members: readonly JobDagMemberInput[],
  allJobNames: ReadonlySet<string>,
): void {
  // 显式拦重复名：Set 去重会静默放过两条同名成员，返回假阴性。
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
