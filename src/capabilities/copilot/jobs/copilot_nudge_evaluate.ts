// YUK-577 — copilot 主动开口触发线：pg-boss handler（FAST 队列，按需 job）。
// design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.1 / §3.3 / §3.7.
//
// producer（ingestion 完成写点）post-commit `boss.send(COPILOT_NUDGE_EVALUATE_QUEUE, {kind, session_id})`
// → 本 handler 在 worker 进程跑确定性判定 + 写触发留痕 event。**无 kill-switch 首行 early-return**
// ——SHADOW 模型（§3.7）下 flag OFF 仍照跑照写（打 shadow=true），surfacing 由 event.shadow +
// 读模型 gate，不 gate 判定/写入。FAST 档无 DLQ 无 retryLimit，但 expire/crash 仍 redeliver +
// 无 singleton 并发 → partial unique index（caused_by_event_id）+ 23505 捕获是 per-source 幂等保证。

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { loadNudgeConfig } from '../server/nudge-config';
import {
  NUDGE_ACTION,
  type NudgeEvaluateInput,
  evaluateNudgeTrigger,
} from '../server/nudge-triggers';

/** job.data 形状（松守边界，判定事实由 evaluate 从 event 表回读——payload 只带定位 id）。 */
const JobData = z.object({
  kind: z.literal('ingestion_complete'),
  session_id: z.string().min(1),
});

/** postgres.js surfaces unique violations as code '23505' (possibly wrapped); walk the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 处理一个 nudge 评估 job：确定性判定 → fire 则写触发留痕 event。
 * 幂等：partial unique index ON event(caused_by_event_id) WHERE action=nudge —— 并发/重投的
 * 第二次写撞 23505，捕获后当已发跳过（writeEvent 的 onConflictDoNothing 只 target PK，其它
 * 唯一约束照常 throw，故 23505 会到这里）。
 */
export async function runCopilotNudgeEvaluate(db: Db, input: NudgeEvaluateInput): Promise<void> {
  const config = loadNudgeConfig();
  const decision = await evaluateNudgeTrigger(db, input, config);
  if (!decision.fire) {
    console.log(
      `[copilot_nudge_evaluate] session=${input.session_id} no-fire reason=${decision.reason}`,
    );
    return;
  }

  try {
    await writeEvent(db, {
      id: newId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'copilot_nudge_trigger',
      action: NUDGE_ACTION,
      subject_kind: decision.event.subject_kind,
      subject_id: decision.event.subject_id,
      outcome: null,
      payload: decision.event.payload,
      caused_by_event_id: decision.event.caused_by_event_id,
      // observe-only：opt out memory outbox（同 auto_enroll_observed / judge_calibration 先例）。
      ingest_at: new Date(),
    });
    console.log(
      `[copilot_nudge_evaluate] session=${input.session_id} fired kind=${decision.event.payload.kind} shadow=${decision.event.payload.shadow}`,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      // 并发/重投竞态：同一触发源已写过 nudge —— 幂等跳过。
      console.log(
        `[copilot_nudge_evaluate] session=${input.session_id} duplicate (unique index) — skipped`,
      );
      return;
    }
    throw err;
  }
}

/** pg-boss handler factory（`(db) => (jobs) => Promise<void>`，register-capability-jobs 挂载）。 */
export function buildCopilotNudgeEvaluateHandler(db: Db): (jobs: Job[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const parsed = JobData.safeParse(job.data);
      if (!parsed.success) {
        console.error('[copilot_nudge_evaluate] malformed job.data — skipped', parsed.error.issues);
        continue;
      }
      await runCopilotNudgeEvaluate(db, parsed.data);
    }
  };
}
