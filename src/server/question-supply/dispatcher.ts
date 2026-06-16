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
import { writeEvent } from '@/server/events/queries';
import { planSupplyRoutes } from './route-planner';
import type { QuestionSupplyTarget, SupplyRoute } from './target-discovery';

/** 能自动派到后台队列的路由（pg-boss）。其余路由 emit + manual。 */
const AUTO_DISPATCHABLE = new Set<SupplyRoute>(['sourcing_web', 'quiz_gen']);

export type DispatchStatus =
  | 'dispatched' // 成功发了一个后台 job。
  | 'manual' // 选定路由当前无法自动派（image/ingest/author），emit + 留给人工/UI。
  | 'skipped' // 目标无可用知识点锚（不该发生，防御）。
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

export interface DispatchDeps {
  /** boss.send 注入（默认走真实 pg-boss）。 */
  enqueue?: EnqueueFn;
  /** 观测事件 actor_ref（默认 'question_supply'）。 */
  actorRef?: string;
  caused_by_event_id?: string | null;
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

  return result;
}

/**
 * 批量派发（按 priority 已排序的目标列表）。逐个 dispatch + emit；返回结果数组（观测/汇总用）。
 * 单个目标失败不打断其余（每个目标独立 emit 了状态）。
 */
export async function dispatchSupplyTargets(
  db: Db,
  targets: QuestionSupplyTarget[],
  deps: DispatchDeps = {},
): Promise<DispatchResult[]> {
  const out: DispatchResult[] = [];
  for (const target of targets) {
    out.push(await dispatchSupplyTarget(db, target, deps));
  }
  return out;
}
