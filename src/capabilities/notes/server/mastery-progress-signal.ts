// ADR-0040 决定2 — Living-Note ← mastery_state p(L) progress telemetry.
//
// 背景：mastery_change refine 触发器（note-refine-triggers.ts）历史上叫
// `review_success`，触发条件是纯 `outcome==='success'`（成败代理），**从不读任何真实
// mastery 数值**。ADR-0040 决定2 要把它诚实化为「读 mastery_state 真实 p(L) delta」，
// 最终目标是触发条件改为「p(L) 跨阈变化」。但跨阈阈值是 n=1 magic number——必须先埋点
// N 周拿到真实 Δ 分布后再定，绝不现在硬编码。
//
// 本模块就是那一步「埋点」：在 mastery_change 触发点（submit.ts，outcome===success
// 处）READ 学习者刚落库的真实 p(L)/θ̂ delta（mastery_state.last_theta_delta = 本次
// attempt 的 Δθ̂，由 updateThetaForAttempt 写入），并把它作为一条 `experimental:
// mastery_progress` 事件 EMIT，复用既有 event/ai-log 基础设施（不建新表）。N 周后
// owner 从这些事件的 Δ 分布里挑阈值，再把触发条件从「成败代理」升级为「跨阈 gating」。
//
// B1 基础设计此前对 living note 链零提及——本模块即 ADR-0040 决定2 要求补的「living
// note → mastery_state 读接口」最小实现。
//
// 红线（ADR-0035，三轴正交）：本模块 **只 READ** mastery_state 派生 p(L)/θ̂，并 EMIT 一条
// 观测事件。**绝不写** mastery_state / item_calibration / FSRS——θ̂/p(L)/FSRS scheduling
// 不经此路径回流。它是只读旁路埋点，不是反馈环。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { getMasteryProjection, getMasteryState } from '@/server/mastery/state';

export const MASTERY_PROGRESS_ACTION = 'experimental:mastery_progress';

// 一个 KC 的 p(L) progress 读数。delta = 本次 attempt 的 Δθ̂（state.ts:657
// `newTheta - s.theta`，落在 mastery_state.last_theta_delta）；p_learned = 当前
// difficulty-aware p(L) point estimate（getMasteryProjection.mastery）。
export interface MasteryProgressReading {
  knowledge_id: string;
  // 本次 attempt 的 θ̂ 漂移（Δθ̂）。NULL = cold-start / 该 KC 还没有 prior Δ（首作答前）。
  theta_delta: number | null;
  // 当前 p(L) point estimate（0..1）。KC 无 mastery_state row（理论上不该发生，因为本
  // helper 在 attempt 落库后调）→ null。
  p_learned: number | null;
  theta_hat: number | null;
}

/**
 * READ-only：把一组 KC 的真实 p(L)/θ̂ progress 从 mastery_state 读出来。
 *
 * 在 attempt tx COMMIT 之后调（submit.ts 触发点已在 tx 外）——故读到的是已落库的
 * POSTERIOR row（含 updateThetaForAttempt 刚写的 last_theta_delta）。纯 SELECT，不写任何
 * mastery 通道（红线）。
 */
export async function readMasteryProgress(
  db: Db,
  knowledgeIds: string[],
): Promise<MasteryProgressReading[]> {
  const ids = Array.from(new Set(knowledgeIds.map((k) => k.trim()).filter((k) => k.length > 0)));
  if (ids.length === 0) return [];
  // p(L) point estimate（difficulty-aware，B1 FULL）批量读。
  const projection = await getMasteryProjection(db, ids);
  const readings: MasteryProgressReading[] = [];
  for (const knowledgeId of ids) {
    // last_theta_delta（本次 attempt Δθ̂）只在单 row read 里暴露——getMasteryState。
    const state = await getMasteryState(db, knowledgeId);
    const proj = projection.get(knowledgeId);
    readings.push({
      knowledge_id: knowledgeId,
      theta_delta: state?.last_theta_delta ?? null,
      p_learned: proj?.mastery ?? null,
      theta_hat: state?.theta_hat ?? null,
    });
  }
  return readings;
}

/**
 * READ p(L) delta + EMIT 一条 `experimental:mastery_progress` 观测事件 per KC。
 *
 * 埋点用：让 owner N 周后从真实 Δθ̂/p(L) 分布里挑「跨阈」阈值（ADR-0040 决定2）。事件复用
 * 既有 event 表（subject_kind='knowledge'，subject_id=<kc>），不建新表。caused_by 串到
 * 触发它的 attempt event，证据可追溯（evidence-first）。
 *
 * 红线：本函数 **不写** mastery_state / item_calibration / FSRS。它只 readMasteryProgress
 * （SELECT）+ writeEvent（INSERT 进通用 event outbox）。emit 失败 best-effort 吞掉——绝不
 * 让旁路埋点 fail 主作答路径（caller 已在 tx 外，但仍保守 try/catch）。
 *
 * @returns 实际 emit 的事件 id 列表（cold-start 无 Δ 的 KC 仍 emit，theta_delta=null 是
 *   合法的「首作答」读数，对埋点同样有意义）。
 */
export async function emitMasteryProgressSignal(input: {
  db: Db;
  knowledgeIds: string[];
  questionId?: string;
  // 触发它的 attempt event id —— caused_by 链 + payload.evidence。
  attemptEventId?: string | null;
  now?: Date;
}): Promise<string[]> {
  const { db, knowledgeIds, questionId, attemptEventId } = input;
  const now = input.now ?? new Date();
  const emittedIds: string[] = [];
  try {
    const readings = await readMasteryProgress(db, knowledgeIds);
    for (const reading of readings) {
      const eventId = newId();
      await writeEvent(db, {
        id: eventId,
        actor_kind: 'system',
        actor_ref: 'mastery_progress_signal',
        action: MASTERY_PROGRESS_ACTION,
        subject_kind: 'knowledge',
        subject_id: reading.knowledge_id,
        // 不带 success/failure 语义——这是观测读数，非判分。
        outcome: null,
        payload: {
          knowledge_id: reading.knowledge_id,
          // 真实 p(L) delta 埋点核心字段。
          theta_delta: reading.theta_delta,
          p_learned: reading.p_learned,
          theta_hat: reading.theta_hat,
          question_id: questionId ?? null,
          attempt_event_id: attemptEventId ?? null,
          // PHASE-DEFERRED：跨阈阈值尚未定——埋点窗口里这条事件不 gate 任何行为。
          // 阈值从这些事件的 Δ 分布里挑出后，触发器才从成败代理升级为跨阈 gating
          // （ADR-0040 决定2）。
          threshold_deferred: true,
        },
        caused_by_event_id: attemptEventId ?? null,
        created_at: now,
      });
      emittedIds.push(eventId);
    }
  } catch (err) {
    // 旁路埋点 best-effort：绝不让它 fail 主作答 / refine 触发路径。
    console.warn('[mastery_progress] emit failed (non-fatal):', err);
  }
  return emittedIds;
}
