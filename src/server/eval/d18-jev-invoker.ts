// ====================================================================
// YUK-1058 live-lane — D18 EvalInvoker for OpenRouter TypeSafe Jev
// ====================================================================
//
// 第一个真实 provider lane：把 corpus item 的 request 当
// JevScoringDecisionInput（{state, questions} 严格形状）转交给
// runTypedPrimitiveTask('JevScoringDecisionTask') —— 复用 YUK-1049 的
// typed runner（model pin / provider 约束 / 重试法 / durable attempt +
// 成本真相全部走 run-lifecycle，本 invoker 不自己写 wire）。
//
// 证据路径（双写，既有语义）：
//   - runTypedPrimitiveTask 写 ai_task_runs 的 JevScoringDecisionTask 行
//     （provider='openrouter', model='typesafe/jev-1.13'，attempt 级真相）；
//   - harness sink 写 D18EvalHarness 封存行（eval 证据；provider 字段由
//     runner 传 'openrouter'）。
//   两层都是审计面：Harness 行聚合 per-item，Jev 行聚合 attempt 级原生 cost。
//
// 判分镜像（→ metrics 层输入）：只有当 corpus item 带 expect.gold_points
// 时才报 score —— 无 gold 的调用照实入账（cost/latency）但不装判分语义。
//   - score 答案：期望等级指数 × max_points/(levels−1)（probability-
//     weighted expectation over the declared level order —— 与
//     jev-model-executor 的 score 语义一致：score 不是点数本身）。
//   - noul 答案：P(statement) × max_points（binary claim 的期望点数）。
//   - choice / 形状不符：不上报 score（不进判分指标，不编造）。
// escalated 恒 false：本 lane 无应用层升级（Jev→advanced 升级只存在于
// jev-model-executor 端口，eval invoker 不配 advanced executor）。
//
// 成本诚实：outcome.unknown_cost 时 reportedCostUsd=null —— reserve 值是
// gate 的保守预留，不是 provider 报价；gate.settle 按 estimated 记账，
// 绝不冒名 'reported'。

import type { EvalCallEstimate } from '@/core/eval/d18-budget';
import type { EvalInvocationResult, EvalInvoker } from '@/core/eval/d18-harness';
import {
  type JevQuestionT,
  JevScoringDecisionInput,
  type JevSystemOneResponseT,
} from '@/core/schema/jev-systemone';
import type { Db } from '@/db/client';
import {
  type TypedPrimitiveCtx,
  type TypedPrimitiveOutcome,
  runTypedPrimitiveTask,
} from '@/server/ai/typed-primitive-runner';

export const JEV_OPENROUTER_LANE = 'jev-openrouter' as const;
/** provider/model truth stamped on the D18 seal rows for this lane. */
export const JEV_LANE_PROVIDER = 'openrouter';
export const JEV_LANE_MODEL = 'typesafe/jev-1.13';

/**
 * 每调用保守预留（admit 用）：typed runner 自己的 $0.005/attempt reserve 是
 * 内部 maxCost 闸，本值喂 EvalBudgetGate —— 取 Jev 官方价上限
 * （prompt $0.042/M）下 ~8k token 的保守量级；未知成本按本值记账
 * （gate.settle 收到 reportedCostUsd=null 时回退 estimated）。
 */
export const JEV_ESTIMATE_PER_CALL: EvalCallEstimate = {
  kind: 'verification',
  inputTokens: 4_096,
  outputTokens: 512,
  estimatedCostUsd: 0.005,
};

type RunFn = (
  kind: string,
  input: unknown,
  ctx: TypedPrimitiveCtx,
) => Promise<TypedPrimitiveOutcome<JevSystemOneResponseT>>;

export interface JevOpenRouterInvokerOptions {
  db: Db;
  /** 每调用 wall-clock 上限（ms epoch）；缺省 = invoke 时刻 + 60s。 */
  deadlineMs?: number;
  /** Test seam：替换 typed runner 调用（单测不接 wire/DB）。 */
  run?: RunFn;
  /** Test seam：时钟。 */
  now?: () => number;
}

/**
 * 把 typed 答案折成 metrics 层的 score 镜像。仅在 expect 存在时调用。
 * 返回 null = 无法诚实换算（choice / 答案缺失 / criteria 形状不符）。
 */
export function jevAnswerToScore(
  question: JevQuestionT | undefined,
  answer: JevSystemOneResponseT['answers'][string] | undefined,
  maxPoints: number,
): { points_awarded: number; max_points: number } | null {
  if (question === undefined || answer === undefined) return null;
  if (answer.type === 'score' && question.type === 'score') {
    const levels = question.criteria.length;
    if (levels < 2) return null;
    const clamped = Math.min(levels - 1, Math.max(0, answer.score));
    return { points_awarded: (clamped / (levels - 1)) * maxPoints, max_points: maxPoints };
  }
  if (answer.type === 'noul' && question.type === 'noul') {
    const p = Math.min(1, Math.max(0, answer.noul));
    return { points_awarded: p * maxPoints, max_points: maxPoints };
  }
  return null;
}

/**
 * jev-openrouter EvalInvoker：每个 corpus item 一发 systemone 决策调用。
 * request 必须 schema-parse 成 {state, questions}；parse 失败抛错 →
 * harness 记 invoke_failed（语料级 bug，不是预算事件）。
 */
export function jevOpenRouterInvoker(opts: JevOpenRouterInvokerOptions): EvalInvoker {
  const run: RunFn = opts.run ?? runTypedPrimitiveTask;
  const now = opts.now ?? Date.now;
  return {
    lane: JEV_OPENROUTER_LANE,
    estimate(_req) {
      return JEV_ESTIMATE_PER_CALL;
    },
    async invoke(req): Promise<EvalInvocationResult> {
      const input = JevScoringDecisionInput.parse(req.item.request);
      const outcome = await run('JevScoringDecisionTask', input, {
        db: opts.db,
        deadlineAt: opts.deadlineMs ?? now() + 60_000,
        logScope: 'd18EvalJev',
      });
      const questionIds = Object.keys(input.questions);
      let score: EvalInvocationResult['score'];
      if (req.item.expect !== undefined && questionIds.length > 0) {
        const firstId = questionIds[0];
        score =
          jevAnswerToScore(
            input.questions[firstId],
            outcome.output.answers[firstId],
            req.item.expect.max_points,
          ) ?? undefined;
      }
      return {
        output: outcome.output,
        usage: {
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
        },
        // 成本真相：unknown ⇒ null（gate 回退 estimated reserve）；实报/价目
        // 都照 outcome.cost_usd 入账（typed runner 的 cumulative 值）。
        reportedCostUsd: outcome.unknown_cost ? null : outcome.cost_usd,
        ...(score !== undefined ? { score } : {}),
        escalated: false,
      };
    },
  };
}
