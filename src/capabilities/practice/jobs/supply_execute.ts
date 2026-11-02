// 供给执行 job：确定性 plan executor 的 pg-boss 入口。
// 三个 caller 共用：
//   (a) supply_planner 门后第二阶段——accepted plan 立即入队本 job（planner 当晚
//       计划当晚执行；规划与执行分离，各自独立 DLQ 重试语义，planner 不等执行）；
//   (b) dispatcher 安全网派发——sourcing_web 分支重指向本队列（scanner 构造需求项，
//       route_preference 带所选路由起的完整 plan；web blocked 时同一需求沿余下
//       路由回落，见 web-supply.ts 的 routesTried/nextRoute）；
//   (b') web 需求路由回落——observe/recovery 见 blocked 后以同一 demand_id 入队
//       本队列（plan_event_id=web_supply_fallback_<demandId>，singletonKey 同名）；
//   (c) 手动 caller：scripts/supply-execute.ts（--plan <id> | --latest）。
// executor 本体是纯确定性模块（question-supply/plan-executor.ts）：无 LLM 判断，
// 路由按 route_preference 机械走；LLM 只在候选工具内部（web SourcingTask / jyeoo
// subprocess / quiz_gen job）。幂等键 plan_event_id（planner 路径）；scanner/手动
// 路径 plan_event_id=null，幂等由 store seam 的 canonical hash 承担（重投只吃
// duplicate_exact 软拒，不堆重复 draft）。
import type { JobWithMetadata } from 'pg-boss';
import { z } from 'zod';
import type { Db } from '@/db/client';
import { enqueueSupplyDispatchJob } from '@/kernel/supply-dispatch';
import type { SupplyTraceV1T } from '../server/question-supply/evidence-demand';
import {
  type PlacementWebDelivery,
  runPlacementWebDelivery,
} from '../server/question-supply/placement-starter-web-delivery';
import type { JyeooFetchConfig } from '../server/question-supply/plan-executor';
import {
  type ExecuteSupplyPlanDeps,
  type SupplyDemandItem,
  executeSupplyPlan,
} from '../server/question-supply/plan-executor';
import { runWebFetchCandidates } from '../server/question-supply/web-candidates';
import { defaultWebSourcingDeps } from '../server/web-sourcing-operation';

/** scanner / planner 共用的默认 jyeoo 抓取参数（与 scripts/jyeoo-backfill.ts 缺省一致）。 */
export const SUPPLY_EXECUTE_JYEOO_DEFAULTS: JyeooFetchConfig = {
  grade: 11,
  subject: 'math2',
  pages: 2,
  maxPapers: 2,
};

// ── job data 契约（snake_case，pg-boss payload） ──────────────────────────────
// route_preference 取 SupplyRoute 全词表（executor 对 author_question /
// ingest_existing / image_candidate 等不可执行路由记 skipped:'route_not_executable'，
// 留痕诚实——planner 的完整偏好不静默截断）。
const SupplyExecuteItem = z.object({
  demand_id: z.string().min(1),
  knowledge_id: z.string().min(1),
  kind: z.string().min(1),
  difficulty_band: z.string().nullable().optional(),
  count: z.number().int().min(1).max(10),
  route_preference: z.array(z.string().min(1)).min(1),
  placement_claim_id: z.string().min(1).optional(),
  objective_only: z.boolean().optional(),
  kind_required: z.boolean().optional(),
});

const SupplyExecuteJobData = z.object({
  plan_event_id: z.string().min(1).nullable(),
  items: z.array(SupplyExecuteItem).min(1),
  supply_trace: z.unknown().optional(),
  jyeoo_fetch: z
    .object({
      grade: z.union([z.literal(10), z.literal(11), z.literal(12)]),
      subject: z.string().min(1).optional(),
      pages: z.number().int().min(1).optional(),
      max_papers: z.number().int().min(1).optional(),
    })
    .optional(),
});

export type SupplyExecuteJobDataT = z.infer<typeof SupplyExecuteJobData>;

/**
 * 生产 deps 装配（supply_planner phase-2 / 手动 caller 共用）。web 生产线的
 * runSourcingAgent/parseLoose 经 defaultWebSourcingDeps() 唯一组装点；
 * quiz_gen enqueue 失败上抛（pg-boss 语义保留）；web 由同 demand owner
 * 持久恢复，不将来源获取变成用户 proposal。
 */
export function buildSupplyExecutorDeps(_db: Db): ExecuteSupplyPlanDeps {
  return {
    runWebFetchCandidates: (params) =>
      runWebFetchCandidates({
        ...params,
        deps: defaultWebSourcingDeps(),
      }),
    enqueueQuizGen: async (payload, opts) =>
      // The key doubles as the deterministic pg-boss job key: a retried send
      // of the same key dedups on the job primary key, so a crash between the
      // send and the item-completion event cannot pay for a second quiz_gen.
      (await enqueueSupplyDispatchJob(
        'quiz_gen',
        payload as unknown as Record<string, unknown>,
        ...(opts?.singletonKey ? [{ jobKey: opts.singletonKey }] : []),
      )) ?? undefined,
  };
}

export type SupplyExecuteJobDeps = Partial<ExecuteSupplyPlanDeps>;

/** 单个 job data 的执行体（纯函数化供测试直打；handler 只做 Job 解包循环）。 */
export async function runSupplyExecuteJobData(
  db: Db,
  jobId: string,
  data: unknown,
  executorDeps: ExecuteSupplyPlanDeps,
  placementDelivery?: PlacementWebDelivery,
): Promise<void> {
  const parsed = SupplyExecuteJobData.safeParse(data);
  if (!parsed.success) {
    // payload 契约破坏是编程错误——响亮失败进 DLQ，不静默丢弃供给需求。
    throw new Error(
      `supply_execute: invalid job data (job ${jobId}): ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const parsedData = parsed.data;
  const items: SupplyDemandItem[] = parsedData.items.map((item) => ({
    demandId: item.demand_id,
    knowledgeId: item.knowledge_id,
    kind: item.kind,
    difficultyBand: item.difficulty_band ?? null,
    count: item.count,
    // 词表宽于 SupplyRouteName（全 SupplyRoute 词表合法）；executor 的运行时
    // 守卫把不可执行路由记 skipped:'route_not_executable'——此处窄化只对齐类型。
    routePreference: item.route_preference as SupplyDemandItem['routePreference'],
    ...(item.placement_claim_id ? { placementClaimId: item.placement_claim_id } : {}),
    ...(item.objective_only ? { objectiveOnly: true } : {}),
    ...(item.kind_required ? { kindRequired: true } : {}),
  }));
  const result = await executeSupplyPlan(
    {
      db,
      planEventId: parsedData.plan_event_id,
      items,
      ...(parsedData.supply_trace
        ? { supplyTrace: parsedData.supply_trace as SupplyTraceV1T }
        : {}),
      ...(placementDelivery ? { placementDelivery } : {}),
      jyeooFetch: parsedData.jyeoo_fetch
        ? {
            grade: parsedData.jyeoo_fetch.grade,
            ...(parsedData.jyeoo_fetch.subject ? { subject: parsedData.jyeoo_fetch.subject } : {}),
            ...(parsedData.jyeoo_fetch.pages ? { pages: parsedData.jyeoo_fetch.pages } : {}),
            ...(parsedData.jyeoo_fetch.max_papers
              ? { maxPapers: parsedData.jyeoo_fetch.max_papers }
              : {}),
          }
        : SUPPLY_EXECUTE_JYEOO_DEFAULTS,
    },
    executorDeps,
  );
  console.log('[supply_execute] job %s → %s', jobId, result.status);
}

/** A placement delivery is exactly one item bound to a claim (see dispatchPlacementStarterClaim). */
function placementClaimIdOf(data: unknown): string | undefined {
  const parsed = SupplyExecuteJobData.safeParse(data);
  if (!parsed.success) return undefined;
  const claimed = parsed.data.items.filter((item) => item.placement_claim_id);
  if (claimed.length === 0) return undefined;
  if (parsed.data.items.length !== 1) {
    throw new Error('supply_execute: a placement claim item must be the only item of its job');
  }
  return claimed[0]?.placement_claim_id;
}

export function buildSupplyExecuteHandler(db: Db, deps: SupplyExecuteJobDeps = {}) {
  return async (jobs: JobWithMetadata[]) => {
    const executorDeps: ExecuteSupplyPlanDeps = {
      ...buildSupplyExecutorDeps(db),
      ...deps,
    };
    for (const job of jobs) {
      const claimId = placementClaimIdOf(job.data);
      if (!claimId) {
        await runSupplyExecuteJobData(db, job.id, job.data, executorDeps);
        continue;
      }
      await runPlacementWebDelivery({
        db,
        job,
        claimId,
        execute: (delivery) =>
          runSupplyExecuteJobData(db, job.id, job.data, executorDeps, delivery),
      });
    }
  };
}
