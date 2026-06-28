// YUK-455 inc-E — prereq 诊断「向后传播」producer 的 IO + EMIT 半（dark-ship）。
//
// 纯「闭包 → 风险」折算住 core/prereq-risk.ts（无 IO）。本模块做两件 IO 事：
//   (1) loadPrereqClosure — 沿 KG prerequisite 边向上 walk 失败 KC 的 transitive 前置闭包。
//   (2) emitPrereqRiskSignal — 把折算出的 per-前置风险读数 EMIT 成 `experimental:prereq_risk`
//       观测事件（复用通用 event outbox，零新表）——这是 surmise relation 诊断向后半的 producer。
//
// ════════════════════════════════════════════════════════════════════════════
// DARK-SHIP CONTRACT（YUK-455 验收：flag-off byte-identical）
//
//   PREREQ_RISK_EMIT_ENABLED（module const, 默认 false）是唯一开关。dark 保证**完全
//   住在两个 call site**（submit.ts / paper-submit.ts），它们 gate 在
//   `PREREQ_RISK_EMIT_ENABLED && outcome==='failure'`——flag-off 时 `&&` 短路，
//   emitPrereqRiskSignal 永不被调，**零** `experimental:prereq_risk` 行写出 → event set
//   与 inc-E 之前 BYTE-IDENTICAL（回归锚）。这与 THETA_GRID_ENABLED 的「use-site gate」范式
//   一致（grid 函数永远算，candidate-signals.ts:385 在用点 gate）。
//
//   ⚠️ emitPrereqRiskSignal / loadPrereqClosure **故意不**在函数内查 flag——这样 producer
//   机制可被 unit/db 测独立验证（defer-flip readiness：dark-ship 必须已接线 + 可证，不能
//   dark-AND-broken）。**新增 call site 必须同样 gate 在 PREREQ_RISK_EMIT_ENABLED**，
//   否则会在 dark 期漏 emit、破坏 byte-identical 保证。
// ════════════════════════════════════════════════════════════════════════════
//
// 红线（ADR-0035 三轴正交）：本 producer 只 EMIT 独立 event 投影（subject_kind='knowledge'，
// subject_id=前置 A）。**绝不写** mastery_state.theta_hat / fail_count——前置 A 从未被作答，
// 写「假 fail」会污染 Elo 充分统计量。风险是独立投影，不经此路径回流 θ̂/p(L)/选题/FSRS。

import { newId } from '@/core/ids';
import {
  PREREQ_RISK_BASE_WEIGHT,
  PREREQ_RISK_DEPTH_DECAY,
  type PrereqClosureEdge,
  prereqRiskFromAttempt,
} from '@/core/prereq-risk';
import type { Db, Tx } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { sql } from 'drizzle-orm';

type DbLike = Db | Tx;
// Injectable writeEvent seam（默认真 writeEvent）——测试用来精确制造单 KC emit 失败，
// 证明 per-event 隔离（同 mastery-progress-signal.ts 的 WriteEventFn 范式）。
type WriteEventFn = typeof writeEvent;

// ── DARK-SHIP FLAG ──────────────────────────────────────────────────────────
// module-level const（镜像 SRT_ENABLED / HIERARCHICAL_ELO_ENABLED / THETA_GRID_ENABLED）。
// false = 诊断向后传播 producer 全程 dark（见上 DARK-SHIP CONTRACT）。翻 true 是 owner
// 决策（独立审计后），届时两个 call site 的 gate 自动放行 emit。
// Renamed from PREREQ_PROPAGATION_ENABLED to disambiguate from the A6 directed θ̂ propagation
// (core/prereq-propagation.ts PREREQ_THETA_PROPAGATION_ENABLED) — a different inc-E mechanism
// that shared the same name. This flag gates ONLY the backward risk-emit producer.
export const PREREQ_RISK_EMIT_ENABLED = false;

export const PREREQ_RISK_ACTION = 'experimental:prereq_risk';

/**
 * 闭包 walk 的硬深度上限（cycle / run-away guard）。镜像 learnable-frontier 的
 * FRONTIER_DEPTH_LIMIT / cascade.ts。overflow → fail-safe 到 []（绝不返回半 walk）。
 */
export const PREREQ_DEPTH_LIMIT = 16;
/**
 * 闭包 ROWCOUNT 的 run-away backstop（一行一个 (prereq, source, depth) tuple）。overflow
 * → fail-safe 到 []。设宽松（同 cascade.ts 10k node 先例），只挡病态 fan-out / 逃出 path
 * guard 的环，不当功能性 frontier-size 限制。
 */
export const PREREQ_NODE_CAP = 10_000;

interface PrereqClosureRow {
  prereq_kc: string;
  source_kc: string;
  depth: number | string;
}

/**
 * loadPrereqClosure — 沿 KG prerequisite 边**向上** walk 一组失败 KC 的 transitive 前置闭包。
 *
 * knowledge_edge `from_knowledge_id → to_knowledge_id` 语义 =「from 是 to 的前置」。失败 KC B
 * 的前置 = 以 B 为 `to_` 的边的 `from_`。anchor 在失败 KC（base case：to_ ∈ failedKnowledgeIds），
 * 沿 `e.to_knowledge_id = c.prereq_kc` 向上递归（与 learnable-frontier 同方向闭包形状）。每条分支
 * 携带其 source_kc（anchor 的失败 KC）不变，用于贡献归因。
 *
 * fail-safe-to-empty：path-array 环卫 + 深度上限 + node-cap，任一 overflow 返回 []（绝不返回
 * 半 walk，同 learnable-frontier ③）。archived 边排除。self-loop（from=to）每层丢弃。
 *
 * @param db Db 或 Tx——只读（execute SELECT）。
 * @returns 闭包边列表（去重的 (prereq_kc, source_kc, depth) tuple）。
 */
export async function loadPrereqClosure(
  db: DbLike,
  failedKnowledgeIds: string[],
): Promise<PrereqClosureEdge[]> {
  const anchors = Array.from(
    new Set(failedKnowledgeIds.map((k) => k.trim()).filter((k) => k.length > 0)),
  );
  if (anchors.length === 0) return [];

  // Recurse ONE level past the depth limit so an over-deep chain is detectable, and fetch
  // ONE row past the node cap so cap-overflow is detectable without a COUNT (mirror
  // learnable-frontier.ts / cascade.ts). Both probes dropped JS-side below.
  const depthProbe = PREREQ_DEPTH_LIMIT + 1;
  const fetchLimit = PREREQ_NODE_CAP + 1;
  // Bind the anchor set as a value list (each id its own parameter) — avoids text[]
  // cast ambiguity that a bare `= ANY($1)` array bind can hit through drizzle's sql.
  const anchorList = sql.join(
    anchors.map((id) => sql`${id}`),
    sql`, `,
  );

  const rows = (await db.execute(sql`
    WITH RECURSIVE closure AS (
      SELECT
        e.from_knowledge_id AS prereq_kc,
        e.to_knowledge_id   AS source_kc,
        1 AS depth,
        ARRAY[e.to_knowledge_id, e.from_knowledge_id] AS path
      FROM knowledge_edge e
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id
        AND e.to_knowledge_id IN (${anchorList})

      UNION ALL

      SELECT
        e.from_knowledge_id AS prereq_kc,
        c.source_kc,
        c.depth + 1 AS depth,
        c.path || e.from_knowledge_id AS path
      FROM knowledge_edge e
      JOIN closure c ON e.to_knowledge_id = c.prereq_kc
      WHERE e.relation_type = 'prerequisite'
        AND e.archived_at IS NULL
        AND e.from_knowledge_id <> e.to_knowledge_id
        AND NOT (e.from_knowledge_id = ANY(c.path))
        AND c.depth < ${depthProbe}
    )
    SELECT DISTINCT prereq_kc, source_kc, depth
    FROM closure
    LIMIT ${fetchLimit}
  `)) as unknown as PrereqClosureRow[];

  const normalised: PrereqClosureEdge[] = rows.map((r) => ({
    prereq_kc: r.prereq_kc,
    source_kc: r.source_kc,
    depth: typeof r.depth === 'string' ? Number(r.depth) : r.depth,
  }));

  // Fail-safe-to-empty on any overflow (mirror learnable-frontier ③ / cascade.ts).
  const depthOverflow = normalised.some((r) => r.depth > PREREQ_DEPTH_LIMIT);
  const nodeOverflow = normalised.length > PREREQ_NODE_CAP;
  if (depthOverflow || nodeOverflow) return [];

  return normalised;
}

/**
 * emitPrereqRiskSignal — 诊断向后传播 producer：load 失败 KC 的 prereq 闭包 → 折算 per-前置
 * 风险 → 每个受波及前置 EMIT 一条 `experimental:prereq_risk` 观测事件。
 *
 * 在 attempt tx COMMIT **之后**调（best-effort，post-commit）。复用通用 event outbox（不建
 * 新表）。caused_by 串到触发它的 attempt event，证据可追溯（evidence-first）。
 *
 * ⚠️ 见 DARK-SHIP CONTRACT：本函数**不查 flag**——dark 由 call site gate。call site 之外
 * 直接调它会真的 emit（仅供测试 / 翻 flag 后的 live 路径）。
 *
 * 错误隔离（同 mastery-progress-signal.ts）：closure load 失败 → best-effort 吞、返回 []；
 * per-event writeEvent 并行 + 各自独立 try（Promise.allSettled），一条 throw 绝不连累其余 KC；
 * 失败计数经 onEmitFailure + console.warn 暴露，不静默丢。
 *
 * 红线：本函数**不写** mastery_state / item_calibration / FSRS。只 loadPrereqClosure（SELECT）
 * + writeEvent（INSERT 进通用 outbox）。
 *
 * @returns 实际成功 emit 的事件 id 列表。
 */
export async function emitPrereqRiskSignal(input: {
  db: Db;
  // 本次答错的题所触及的 KC（failure 路径的 q.knowledge_ids）——闭包 anchor。
  failedKnowledgeIds: string[];
  questionId?: string;
  // 触发它的 attempt event id —— caused_by 链 + payload.evidence。
  attemptEventId?: string | null;
  now?: Date;
  // 可注入的 writeEvent seam（默认真 writeEvent）——测试用来精确制造单 KC 失败。生产路径不传。
  writeEventFn?: WriteEventFn;
  // 每条 emit 失败时回调（带失败 KC）。可观测 hook——不传也会 warn 计数。
  onEmitFailure?: (knowledgeId: string, err: unknown) => void;
}): Promise<string[]> {
  const { db, failedKnowledgeIds, questionId, attemptEventId, writeEventFn, onEmitFailure } = input;
  const emit = writeEventFn ?? writeEvent;
  const now = input.now ?? new Date();

  let closure: PrereqClosureEdge[];
  try {
    closure = await loadPrereqClosure(db, failedKnowledgeIds);
  } catch (err) {
    console.warn('[prereq_risk] closure load failed (non-fatal):', err);
    return [];
  }
  if (closure.length === 0) return [];

  // PURE 折算（core/prereq-risk.ts）。确定性 KC 排序让 emit 顺序可复现。
  const readings = [...prereqRiskFromAttempt(closure).values()].sort((a, b) =>
    a.knowledge_id.localeCompare(b.knowledge_id),
  );
  if (readings.length === 0) return [];

  const emittedIds: string[] = [];
  const failures: string[] = [];
  const results = await Promise.allSettled(
    readings.map(async (reading) => {
      const eventId = newId();
      await emit(db, {
        id: eventId,
        actor_kind: 'system',
        actor_ref: 'prereq_propagation',
        action: PREREQ_RISK_ACTION,
        subject_kind: 'knowledge',
        subject_id: reading.knowledge_id,
        // 不带 success/failure 语义——这是诊断观测投影，非判分（红线）。
        outcome: null,
        payload: {
          knowledge_id: reading.knowledge_id,
          // 诊断向后传播核心字段：上调的掌握风险幅度 + 最近跳距 + 归因。
          risk_delta: reading.risk_delta,
          min_depth: reading.min_depth,
          source_kcs: [...new Set(reading.contributions.map((c) => c.source_kc))].sort(),
          contributions: reading.contributions,
          // owner 固定先验常数随事件留痕，便于 N 周后从分布回看（与下方 threshold_deferred 配套）。
          base_weight: PREREQ_RISK_BASE_WEIGHT,
          depth_decay: PREREQ_RISK_DEPTH_DECAY,
          question_id: questionId ?? null,
          attempt_event_id: attemptEventId ?? null,
          // PHASE-DEFERRED：传播权重/衰减是 n=1 magic number——埋点期这条事件**不 gate** 任何
          // live 行为（选题/p(L)/θ̂/FSRS 均不读它）。owner 从 risk_delta 分布选定常数/阈值后
          // 才考虑下游消费（同 ADR-0040 决定2 范式）。
          threshold_deferred: true,
        },
        caused_by_event_id: attemptEventId ?? null,
        created_at: now,
      });
      return { eventId, knowledgeId: reading.knowledge_id };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      emittedIds.push(result.value.eventId);
    } else {
      const knowledgeId = readings[i].knowledge_id;
      failures.push(knowledgeId);
      onEmitFailure?.(knowledgeId, result.reason);
    }
  }
  if (failures.length > 0) {
    console.warn(
      `[prereq_risk] ${failures.length}/${readings.length} emit(s) failed (non-fatal):`,
      failures,
    );
  }
  return emittedIds;
}
