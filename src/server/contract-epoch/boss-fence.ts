// ====================================================================
// YUK-1055 — pgboss per-delivery epoch fence + outstanding 处置报告
// ====================================================================
//
// 两个面：
//   1. fenceAwareJobHandler —— 包住每个 boss.work handler。启动期闸门
//      （waitForRunnableEpoch in start-worker）管不到「一个还活着的 worker
//      在 epoch 翻转后继续消费」的情形；per-delivery 检查补上这一刀。
//      按 ./jobs.ts 的 disposition：
//        drain     → marker state 非 'active' 时 fenced；active 即可（不挑 epoch）。
//        fenced    → 另要求 marker.epoch === CODE_CONTRACT_EPOCH。
//        translate → 另要求 job 出生 epoch === marker.epoch（created_on 时刻
//                    最近一次 'active' marker；见 epoch.ts readJobBirthEpoch）——
//                    旧合同的 durable payload 绝不按新合同执行（§15 outstanding
//                    translate）；post-cutover 新投递的同队列 job 照跑。
//      命中 → console.warn 确定性日志 + ContractEpochFenceError（pg-boss 按
//      队列 retry 预算重投，耗尽后 failed/DLQ —— 不静默吞、不无限烧）。
//   2. reportOutstandingBossJobs —— cutover 前的存量分级报告（scripts/
//      contract-epoch.ts `outstanding` 子命令；接 YUK-1042 的处置）。

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  CODE_CONTRACT_EPOCH,
  ContractEpochFenceError,
  type EpochMarker,
  gateContractEpoch,
  isUndefinedTable,
  logContractEpochFence,
  readContractEpoch,
  readJobBirthEpoch,
} from './epoch';
import { type JobEpochDisposition, jobEpochDisposition } from './jobs';

type JobHandler<J extends Job = Job> = (jobs: J[]) => Promise<unknown>;

async function gateJobDelivery(
  db: Db,
  queue: string,
  job: Job,
): Promise<ContractEpochFenceError | null> {
  const marker = await readContractEpoch(db);
  const disposition = jobEpochDisposition(queue);
  const surface = `job:${queue}`;

  // 'preparing'/'ready'（maintenance）→ 全类 fenced（维护窗下任何 job 不写）。
  // 'active' + epoch 不匹配：仅 fenced/translate 类拒绝；drain 类是
  // epoch-agnostic housekeeping，在哪个 active epoch 下跑都正确。
  const verdict = gateContractEpoch(marker);
  if (!verdict.runnable) {
    if (disposition === 'drain' && verdict.reason === 'epoch_mismatch') return null;
    logContractEpochFence(surface, verdict, { jobId: job.id, disposition });
    return new ContractEpochFenceError(surface, verdict);
  }
  // 此处 marker 恒非空且 state='active'（runnable=true 蕴含），且 epoch === CODE_CONTRACT_EPOCH。
  if (disposition === 'drain') return null;
  if (disposition === 'translate') {
    const createdOn = await readJobCreatedOn(db, job.id);
    // 查不到 job 行（pgboss schema 缺 / 测试 stub）→ 保守按当前 epoch 放行：
    // 无法证明它来自旧 epoch 时，不误伤新投递（fence 的失败方向是卡住新工作，
    // 不是保护旧 payload——那是 marker/active 检查的职责）。
    if (createdOn === null) return null;
    const birthEpoch = await readJobBirthEpoch(db, createdOn);
    // runnable=true 蕴含 marker.epoch === CODE_CONTRACT_EPOCH；出生 epoch 必须
    // 等于本代码 epoch，否则该 payload 是旧合同产物 → fenced（待显式转换）。
    if (birthEpoch !== CODE_CONTRACT_EPOCH) {
      const fencedVerdict = {
        runnable: false as const,
        marker: marker as EpochMarker,
        reason: 'epoch_mismatch' as const,
      };
      logContractEpochFence(surface, fencedVerdict, {
        jobId: job.id,
        disposition,
        birthEpoch,
        createdOn: createdOn.toISOString(),
      });
      return new ContractEpochFenceError(surface, fencedVerdict);
    }
  }
  return null;
}

async function readJobCreatedOn(db: Db, jobId: string): Promise<Date | null> {
  try {
    const rows = await db.execute<{ created_on: Date }>(sql`
      select created_on from pgboss.job where id = ${jobId}
    `);
    return rows[0]?.created_on ?? null;
  } catch (err) {
    // pgboss schema 缺失（42P01：无 boss 的测试/最小部署）→ 无出生记录可判，放行。
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

/**
 * 把 epoch fence 织进 job handler。在 register-capability-jobs / handlers /
 * memory triggers / orchestrator / subscription dispatch 的 boss.work 处统一套。
 * `handler` 内部逻辑不变；fenced delivery 抛出 ContractEpochFenceError，
 * pg-boss 按该队列 retry 配置决定重投/failed/DLQ。
 *
 * 泛型 J 透传调用方的 job 形状（Job<ReqData> / JobWithMetadata<ReqData>）——
 * 裸 Job 形参会因 invariance 拒掉 Job<{event_id:…}>[] handler。
 */
export function fenceAwareJobHandler<J extends Job>(
  db: Db,
  queue: string,
  handler: JobHandler<J>,
): JobHandler<J> {
  return async (jobs: J[]) => {
    for (const job of jobs) {
      const fence = await gateJobDelivery(db, queue, job);
      if (fence) throw fence;
    }
    return handler(jobs);
  };
}

// ───────────────────────── outstanding 处置报告（YUK-1042 衔接） ─────────────────────────

export interface OutstandingJobDisposition {
  queue: string;
  /** pgboss.job.state（created/retry/active/failed/completed/…）。 */
  state: string;
  count: number;
  disposition: JobEpochDisposition;
}

const OUTSTANDING_STATES = ['created', 'retry', 'active', 'failed'] as const;

/**
 * cutover 存量报告：pgboss.job 按 (queue,state) 计数 × disposition。
 * 'failed' 也纳入——存量失败同样是需要处置决定的 outstanding（YUK-1042）。
 * pgboss schema 缺失 → 空数组（不是错误）。
 */
export async function reportOutstandingBossJobs(db: Db): Promise<OutstandingJobDisposition[]> {
  let rows: { name: string; state: string; count: number | string }[];
  try {
    const states = sql.join(
      OUTSTANDING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    rows = await db.execute<{ name: string; state: string; count: number | string }>(sql`
      select name, state, count(*)::int as count
      from pgboss.job
      where state in (${states})
      group by name, state
      order by name, state
    `);
  } catch (err) {
    if (isUndefinedTable(err)) {
      return [];
    }
    throw err;
  }
  return rows.map((r) => ({
    queue: r.name,
    state: r.state,
    count: Number(r.count),
    disposition: jobEpochDisposition(r.name),
  }));
}
