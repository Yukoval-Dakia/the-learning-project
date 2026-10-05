// ====================================================================
// YUK-1057 — D18 证据封存 seam（app ai_task_runs + file sink）
// ====================================================================
//
// EvidenceSink 的两个实现：
//   - FileEvidenceSink：NDJSON 追加（演练/单测工件；raw entry 原文落盘）。
//   - AiTaskRunEvidenceSink：把每次 invocation 封成 ai_task_runs 行 ——
//     「证据经 app ai_task_runs 封存」（D18）的现成通路。
//
// task_kind 用 'D18EvalHarness'：TaskKind union 来自 src/ai/registry 的
// catalog 定义（注册一个新任务需要完整 prompt/budget/runner 合同），
// 而 D18 评测的运行体是 harness 不是 TaskRunner —— 不注册 catalog，
// 直接用字符串写库（task_kind 列是 text，无 DB enum）。catalog 侧
// EXPECTED_KINDS 契约不受影响。
//
// YUK-1058 metrics 扩展：latency_ms → started_at/finished_at 反推
// （ai_task_runs 无 duration 列，用 finished−started 表达耗时）；score 与
// escalated 镜像进 usage_json 的 d18_* 可选字段（判分证据的权威仓是
// NDJSON/harness entry，DB 行镜像之以便 SQL 聚合）。error_message 只装真
// 错误（不入元数据）。

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Writable } from 'node:stream';

import { eq } from 'drizzle-orm';

import type { EvalEvidenceSink } from '@/core/eval/d18-harness';
import type { Db } from '@/db/client';
import { ai_task_runs } from '@/db/schema';

export const D18_TASK_KIND = 'D18EvalHarness' as const;

/** NDJSON 追加 sink —— 工件目录下的原始证据（含 input/output digest）。 */
export function fileEvidenceSink(path: string): EvalEvidenceSink {
  mkdirSync(dirname(path), { recursive: true });
  const stream: Writable = createWriteStream(path, { flags: 'a' });
  return {
    async record(entry) {
      await new Promise<void>((resolvePromise, reject) => {
        stream.write(`${JSON.stringify(entry)}\n`, (err) => (err ? reject(err) : resolvePromise()));
      });
    },
    async close() {
      await new Promise<void>((resolvePromise) => stream.end(resolvePromise));
    },
  };
}

/**
 * app ai_task_runs 封存：一条 invocation = 一行 task run（原子 upsert，
 * start+finish 一次落库 —— harness record 时 invocation 已终态）。
 * input_hash 承载 item 输入 digest；result_digest 承载输出 digest；
 * usage_json/cost_usd 照实入账；outcome 映射 status/finish_reason。
 * id = `d18-<runId>-<item>-a<attempt>`（harness run 重跑幂等：同 id
 * ON CONFLICT 不覆盖 —— 证据行不可变，第二次 run 需要新 runId）。
 */
export function aiTaskRunEvidenceSink(
  db: Db,
  opts: { provider: string; model?: string },
): EvalEvidenceSink {
  return {
    async record(entry) {
      const runId = `d18-${entry.run_id}-${entry.item_id}-a${entry.attempt}`;
      const status = entry.outcome === 'settled' ? 'success' : 'failure';
      const finishReason = entry.outcome === 'settled' ? 'settled' : entry.outcome;
      const recordedAt = new Date(entry.recorded_at);
      // latency → 时间区间表达：finished_at=recorded_at，started_at=recorded−latency
      // （ai_task_runs 无 duration 列；gate_rejected 无调用 → 两端同刻）。
      const startedAt =
        entry.latency_ms === null ? recordedAt : new Date(recordedAt.getTime() - entry.latency_ms);
      // 先查后写：证据行不可变 —— 已有同 id 行（同 run 重放）即跳过，
      // 绝不让第二次运行悄悄覆盖已封存证据。
      const existing = await db
        .select({ id: ai_task_runs.id })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, runId))
        .limit(1);
      if (existing.length > 0) return;
      await db.insert(ai_task_runs).values({
        id: runId,
        task_kind: D18_TASK_KIND,
        provider: opts.provider,
        model: opts.model ?? `d18/${entry.lane}`,
        input_hash: entry.input_digest,
        result_digest: entry.output_digest === '' ? null : entry.output_digest,
        status,
        finish_reason: finishReason,
        usage_json: {
          inputTokens: entry.usage.inputTokens,
          outputTokens: entry.usage.outputTokens,
          // YUK-1058：判分/升级镜像（可选字段，ai_task_runs.usage_json $type
          // 的 d18_* 扩展 —— 不影响既有消费方）。
          ...(entry.score === null ? {} : { d18_score: entry.score }),
          ...(entry.escalated === null ? {} : { d18_escalated: entry.escalated }),
          ...(entry.latency_ms === null ? {} : { d18_latency_ms: entry.latency_ms }),
        },
        cost_usd: entry.cost_usd,
        cost_basis: entry.cost_basis,
        cost_ref: entry.cost_ref,
        error_message: entry.error === null ? null : entry.error.slice(0, 500),
        started_at: startedAt,
        finished_at: recordedAt,
      });
    },
    async close() {
      // DB sink 无缓冲 —— 每次 record 都已落库。
    },
  };
}
