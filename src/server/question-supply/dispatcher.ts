// YUK-361 Phase 8 (Task 13 Step 4 + 7) — 供给目标派发到既有获取面 + 观测留痕。
//
// 权威 spec：
//   - docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md Task 13 Step 4/7
//   - docs/design/2026-06-15-question-supply-target-discovery-architecture.md §Route Planner 映射 / §Dispatcher
//
// **不建新的整体获取任务、不建新 AI task**（Task 13 红线：deterministic-first，确定性缺口扫描
// 够用就不加 AI task）。本 dispatcher 是薄 IO 层：把一个 target 选定的路由 → 既有 job/task 调用。
//
// 路由 → 既有面映射（架构 doc §Route Planner「Mapping to current code」）：
//   - sourcing_web    → boss.send('sourcing', { trigger:'knowledge', ref_id, count, knowledge_id, kind })
//                       （SourcingTask web 既存题，链 source_verify，src/server/boss/handlers/sourcing.ts）
//   - quiz_gen        → boss.send('quiz_gen', { trigger:'knowledge', ref_id, count, generation_method,
//                       knowledge_id, kind })（仅当显式要 material/closed_book 生成卷题时；archive doc
//                       Open Decision：只在 bundled quiz/paper 显式需要时走）
//   - author_question → **不自动派**（无后台队列；runQuestionAuthor 只经 copilot tool 由 LLM 发起，
//                       Open Decision #4「拟题是否自动后台运行」未拍板 → 默认 manual，需用户/copilot 发起）
//   - image_candidate → **不自动派**（image_candidate 是 SourcingTask 的产物 + 需用户 accept 才下载抽取，
//                       守 ADR-0002；架构 doc §Verification Invariants）
//   - ingest_existing → **不自动派**（未来 crawler/import 路由，未建；emit target + 标 manual）
//
// 不能自动派的路由 → 记 status='manual'（emit + log，不动作），等用户/UI 接手。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { and, eq, gte, sql } from 'drizzle-orm';
import { planSupplyRoutes } from './route-planner';
import type { QuestionSupplyTarget, SupplyRoute } from './target-discovery';

/** 能自动派到后台队列的路由（pg-boss）。其余路由 emit + manual。 */
const AUTO_DISPATCHABLE = new Set<SupplyRoute>(['sourcing_web', 'quiz_gen']);

// ── review FINDING #1 + #2：跨扫描指纹 cooldown（防 job-spam / 无界 re-dispatch）─────
//
// 问题：dispatcher 算了 fingerprint 却从不持久化/比对——没有任何跨扫描幂等。R1（前沿零题）
// 自限（一发 sourcing 出 fresh draft → 池 > 0 → 缺口消失），但 R2/R3/R4 在**验证失败**时不自限：
// 一道被拒的 draft 仍是 'draft' 状态、KC 仍前沿、缺口每扫描必复现 → 每扫描 re-dispatch 一个**付费**
// sourcing/quiz_gen job，无界叠加（且 handlers 无幂等键，会堆重复 draft）。
//
// 修复：**query-based fingerprint cooldown**（不新建表——持久表是架构 doc 的后续 phase）。
// AUTO-派发前，查最近 `SUPPLY_DISPATCH_COOLDOWN_DAYS` 内 SAME fingerprint 的
// experimental:question_supply 事件（dispatcher 本就在写这些事件），且其 payload.status='dispatched'
// （**真派过的**，不含 manual/skipped/failed）。命中 → SKIP（不再 boss.send，status='skipped'、
// stop_condition='cooldown'），打破无界循环。fingerprint 已在 payload 里且 JSONB 可查（payload->>）。
//
// 这是 **cooldown 节流**，不是完整持久化 / in-flight-job 去重（后者是架构 doc 的后续 phase）。
// 但有了 cooldown，dispatcher 接生产 caller 是 SAFE 的——同一未满足缺口的重复派发被时间窗挡住。
export const SUPPLY_DISPATCH_COOLDOWN_DAYS = 7;

export type DispatchStatus =
  | 'dispatched' // 成功发了一个后台 job。
  | 'manual' // 选定路由当前无法自动派（image/ingest/author），emit + 留给人工/UI。
  | 'skipped' // 无可用知识点锚（防御）**或** 同 fingerprint 在 cooldown 窗内已派过（FINDING #1/#2）。
  | 'failed'; // 派发抛错（enqueue 失败）。

export interface DispatchResult {
  targetId: string;
  fingerprint: string;
  /** route-planner 算出的完整有序路由列表（观测用）。 */
  routePlan: SupplyRoute[];
  /** 本次实际选中的首选可派路由（manual 时是 routePlan[0]）。 */
  chosenRoute: SupplyRoute | null;
  status: DispatchStatus;
  /** dispatched 时是 pg-boss jobId；其余为 null。 */
  jobId: string | null;
  /** 停止条件描述（观测用，架构 doc §7「stop condition」）。 */
  stopCondition: string;
  reason: string;
}

/** boss.send 注入口（DB 测试可注入 fake 捕获 enqueue）。 */
export type EnqueueFn = (
  queue: 'sourcing' | 'quiz_gen',
  data: Record<string, unknown>,
) => Promise<string | null>;

async function defaultEnqueue(
  queue: 'sourcing' | 'quiz_gen',
  data: Record<string, unknown>,
): Promise<string | null> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  return boss.send(queue, data);
}

/**
 * review FINDING #1 + #2 — query-based fingerprint cooldown 探针（不新建表）。
 *
 * 查最近 `cooldownDays` 内是否有同 fingerprint 的、**真派过的**（payload.status='dispatched'）
 * experimental:question_supply 事件。dispatcher 自己写这些事件，fingerprint + status 都在
 * payload JSONB 里（payload->>'fingerprint' / payload->>'status'，皆为标量字符串）。命中
 * `event_action_outcome_idx`（action + created_at）+ payload GIN，时间窗剪枝廉价。
 *
 * 只数 status='dispatched' 的事件：manual / skipped（含上次 cooldown 命中）/ failed 都**没有**
 * 真发后台 job，不该让一个未满足的缺口被永久锁死——只有真发过 job 才进入 cooldown 静默期。
 */
async function recentDispatchExists(
  db: Db,
  fingerprint: string,
  cooldownDays: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:question_supply'),
        gte(event.created_at, cutoff),
        sql`${event.payload}->>'fingerprint' = ${fingerprint}`,
        sql`${event.payload}->>'status' = 'dispatched'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface DispatchDeps {
  /** boss.send 注入（默认走真实 pg-boss）。 */
  enqueue?: EnqueueFn;
  /** 观测事件 actor_ref（默认 'question_supply'）。 */
  actorRef?: string;
  caused_by_event_id?: string | null;
  /**
   * cooldown 窗口天数（review FINDING #1/#2）。默认 SUPPLY_DISPATCH_COOLDOWN_DAYS（7d）。
   * 测试可注入 0 关闭 cooldown 或调小窗口验证行为。
   */
  cooldownDays?: number;
}

/**
 * 把一个 quiz_gen 路由的 generation_method 从目标约束推导：
 *   objectiveOnly / 一般 → closed_book（无 grounding 要求时闭卷生成）。
 *   minSourceTier ≤ 2（要中可信）→ material_grounded（拉真原文 grounding）。
 * （quiz_gen 队列只在 route plan 把它排到首位且 sourcing 不可用时才命中——见 chooseAutoRoute。）
 */
function generationMethodFor(target: QuestionSupplyTarget): 'material_grounded' | 'closed_book' {
  return target.minSourceTier <= 2 ? 'material_grounded' : 'closed_book';
}

/**
 * 选自动派路由：**只看路由计划的 head（最优先路由）**——尊重 route-planner 的优先级排序。
 * head 可自动派（sourcing_web / quiz_gen）→ 自动派；head 不可自动派（image_candidate /
 * ingest_existing / author_question）→ 返回 null → manual（emit + 留给 UI/copilot）。
 *
 * 为什么不扫整个 plan 找首个可派的：image-first 的目标其 plan 是 ['image_candidate', ...,
 * 'sourcing_web']——若往后扫到 sourcing_web 就自动派，等于无视「这题需要图、web 是劣替代」
 * 的硬偏好（Task 13 Step 4：image_candidate 需 UI accept → 不自动派）。head-only 保证
 * 「最优先路由不可派 ⇒ 整个目标走 manual」，与 route-planner 的判据优先链一致。
 */
function chooseAutoRoute(routePlan: SupplyRoute[]): SupplyRoute | null {
  const head = routePlan[0];
  return head && AUTO_DISPATCHABLE.has(head) ? head : null;
}

/**
 * 派发一个供给目标。先 route-plan → 选首个可自动派路由 → enqueue 既有队列；不可派则 manual。
 * 永远 emit 一个 experimental:question_supply 观测事件（Step 7：gap counts via reason/gapKind、
 * 选定 route list、stop condition、satisfied/skipped/failed 状态）。
 */
export async function dispatchSupplyTarget(
  db: Db,
  target: QuestionSupplyTarget,
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  const enqueue = deps.enqueue ?? defaultEnqueue;
  const actorRef = deps.actorRef ?? 'question_supply';
  const cooldownDays = deps.cooldownDays ?? SUPPLY_DISPATCH_COOLDOWN_DAYS;
  const routePlan = planSupplyRoutes(target);
  const anchorKid = target.knowledgeIds[0] ?? null;

  let result: DispatchResult;

  if (!anchorKid) {
    // 防御：扫描器永远给至少一个 KC，但 dispatch 不该在无锚时盲发。
    result = {
      targetId: target.id,
      fingerprint: target.fingerprint,
      routePlan,
      chosenRoute: routePlan[0] ?? null,
      status: 'skipped',
      jobId: null,
      stopCondition: `no anchor knowledge id on target ${target.id}`,
      reason: target.reason,
    };
  } else {
    const autoRoute = chooseAutoRoute(routePlan);
    if (autoRoute === null) {
      // 选定路由（image/ingest/author）当前无法自动派 → manual（emit + 留给 UI/copilot）。
      result = {
        targetId: target.id,
        fingerprint: target.fingerprint,
        routePlan,
        chosenRoute: routePlan[0] ?? null,
        status: 'manual',
        jobId: null,
        stopCondition: `route '${routePlan[0] ?? 'none'}' has no background queue; awaits user/UI (Open Decision #1/#4)`,
        reason: target.reason,
      };
    } else if (
      cooldownDays > 0 &&
      (await recentDispatchExists(db, target.fingerprint, cooldownDays))
    ) {
      // ── review FINDING #1 + #2：cooldown 命中 → SKIP（不 boss.send）─────────────
      // 同 fingerprint 在 cooldown 窗内已真派过一个后台 job。再发就是无界 re-dispatch
      // （缺口未被验证满足 → 每扫描复现 → 每次 boss.send 一个付费 job + 堆重复 draft）。
      // 静默到窗口期满，让上次派的 job + 它的 verify 链有时间落地。emit 一个 skipped 事件
      // 留痕（观测可见 cooldown 在生效），但**不**再算进 cooldown 计数（只数 dispatched）。
      result = {
        targetId: target.id,
        fingerprint: target.fingerprint,
        routePlan,
        chosenRoute: autoRoute,
        status: 'skipped',
        jobId: null,
        stopCondition: `cooldown: same fingerprint dispatched within last ${cooldownDays}d; skipping re-dispatch to avoid unbounded job-spam (review FINDING #1/#2)`,
        reason: target.reason,
      };
    } else {
      // 自动派：sourcing_web → 'sourcing'，quiz_gen → 'quiz_gen'。
      const queue: 'sourcing' | 'quiz_gen' = autoRoute === 'sourcing_web' ? 'sourcing' : 'quiz_gen';
      const data: Record<string, unknown> = {
        trigger: 'knowledge',
        ref_id: anchorKid,
        count: target.desiredCount,
        knowledge_id: anchorKid,
        // 题型 hint（'any' → 不 pin）；扫描器的 kind 字段（forwarded：sourcing→kinds, quiz_gen→kind）。
        ...(target.kind && target.kind !== 'any' ? { kind: target.kind } : {}),
        ...(queue === 'quiz_gen' ? { generation_method: generationMethodFor(target) } : {}),
      };
      try {
        const jobId = await enqueue(queue, data);
        result = {
          targetId: target.id,
          fingerprint: target.fingerprint,
          routePlan,
          chosenRoute: autoRoute,
          status: 'dispatched',
          jobId,
          stopCondition: `enqueued ${queue} for knowledge ${anchorKid}; satisfied when ${target.desiredCount} active question(s) ≥ tier ${target.minSourceTier} exist (verified via source_verify/quiz_verify)`,
          reason: target.reason,
        };
      } catch (err) {
        result = {
          targetId: target.id,
          fingerprint: target.fingerprint,
          routePlan,
          chosenRoute: autoRoute,
          status: 'failed',
          jobId: null,
          stopCondition: `enqueue ${queue} threw: ${(err as Error).message}`,
          reason: target.reason,
        };
      }
    }
  }

  // ── Step 7 观测：每个派发结果落一个 experimental:question_supply 事件 ─────────
  // 复用既有 evidence-first 事件总线（writeEvent），无新重型基建。payload 含：gap 类别/
  // count（gapKind + desiredCount + gap_count）、选定 route list、stop condition、状态。
  //
  // review FINDING #6（健壮性）：writeEvent 跑在 enqueue（boss.send）之后。dispatched 路径下
  // 后台 job **已经发出去了**——若此处 observability 写遇瞬时 DB 错就 reject，等于「job 发了但
  // caller 看到失败」的撕裂态（caller 可能重试 → 重复 job）。故把 writeEvent 包 try/catch：
  // 留痕失败只 log，**绝不 reject**，结果 result 已是真相（job 发没发由 result.status 定）。
  // observability 是辅助轴，不该反过来污染主派发结果。
  try {
    await writeEvent(db, {
      id: newId(),
      actor_kind: 'agent',
      actor_ref: actorRef,
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: target.id,
      outcome:
        result.status === 'dispatched'
          ? 'success'
          : result.status === 'failed'
            ? 'failure'
            : 'partial',
      caused_by_event_id: deps.caused_by_event_id ?? null,
      payload: {
        target_id: target.id,
        fingerprint: target.fingerprint,
        gap_kind: target.gapKind,
        subject_id: target.subjectId,
        knowledge_ids: target.knowledgeIds,
        kind: target.kind,
        difficulty_band: target.difficultyBand,
        desired_count: target.desiredCount,
        min_source_tier: target.minSourceTier,
        priority: target.priority,
        route_plan: result.routePlan,
        chosen_route: result.chosenRoute,
        status: result.status,
        job_id: result.jobId,
        stop_condition: result.stopCondition,
        reason: result.reason,
        constraints: target.constraints,
      },
    });
  } catch (eventErr) {
    // 留痕失败 non-fatal：job 状态已定（result），observability 缺一条不该让派发 reject。
    console.error(
      `[question-supply] observability writeEvent failed for target ${target.id} (status=${result.status}); dispatch result stands:`,
      eventErr,
    );
  }

  return result;
}

/**
 * 批量派发（按 priority 已排序的目标列表）。逐个 dispatch + emit；返回结果数组（观测/汇总用）。
 *
 * review FINDING #6（健壮性）：每个 target 包 try/catch——单个目标的 dispatch 抛错（不该发生，
 * 因为 dispatchSupplyTarget 内部已捕获 enqueue + writeEvent 错；这是最后一道防线，挡住任何漏网的
 * 意外异常如无锚之外的 DB 错）**不打断其余目标**的派发。抛错的目标合成一个 failed 结果计入返回，
 * 让批量扫描的其余缺口照常推进，不被一个瞬时错全盘 abort。
 */
export async function dispatchSupplyTargets(
  db: Db,
  targets: QuestionSupplyTarget[],
  deps: DispatchDeps = {},
): Promise<DispatchResult[]> {
  const out: DispatchResult[] = [];
  for (const target of targets) {
    try {
      out.push(await dispatchSupplyTarget(db, target, deps));
    } catch (err) {
      console.error(
        `[question-supply] dispatchSupplyTarget threw for target ${target.id}; continuing with remaining targets:`,
        err,
      );
      out.push({
        targetId: target.id,
        fingerprint: target.fingerprint,
        routePlan: [],
        chosenRoute: null,
        status: 'failed',
        jobId: null,
        stopCondition: `dispatchSupplyTarget threw: ${(err as Error).message}`,
        reason: target.reason,
      });
    }
  }
  return out;
}
