// YUK-758 夜间任务编排 orchestrator 常量。独立模块（不向 god file 加肉）。

/** orchestrator 自身的 pg-boss 队列名（单锚点）。 */
export const ORCHESTRATOR_QUEUE = 'nightly_orchestrator';

/**
 * 单锚点 cron：~02:30 Asia/Shanghai 开闸建「今晚运行记录」+ enqueue 根节点。
 * 图成员 job 自身**不再**带 cron（validateComposition 强制互斥）——全由本锚点驱动。
 */
export const ORCHESTRATOR_CRON = '30 2 * * *';
export const ORCHESTRATOR_TZ = 'Asia/Shanghai';

/**
 * tick 自调度间隔（秒）。锚点起步后，orchestrator 每 tick 轮询节点态、推进就绪下游，
 * 未完成则 boss.send 自身下一 tick（startAfter）。pg-boss 持久化该 send → 跨 worker
 * 重启存活。60s 对夜间批足够（层间收敛以 tick 为步）。
 */
export const TICK_INTERVAL_SECONDS = 60;

/**
 * 单节点超时（秒）。enqueue/running 超过此时长仍未终态 → 判 failed（detail: timeout），
 * 让硬下游据此跳过（票面「上游超时 → 下游不跑并留痕」）。
 *
 * **必须覆盖 pg-boss 的完整重试预算**（YUK-758 review ToTeE）。旧值 3h 是拿单次
 * EXPIRE_AGENT(2h) 比出来的，漏算了重试：agent 档成员 job 的最坏合法生命周期是
 *
 *   (1 + JOB_RETRY_LIMIT) × EXPIRE_AGENT + 重试退避 = 3 × 2h + (~30s + ~60s) ≈ 6h
 *
 * （queue-config.ts：EXPIRE_AGENT=7200、JOB_RETRY_LIMIT=2、JOB_RETRY_DELAY_SECONDS=30 +
 * retryBackoff）。`enqueued_at` 在 claim 时只写一次、重试不重置，故 3h 会在第二次尝试还
 * 在跑时就把节点判死：硬下游被**永久** skipped，哪怕第三次尝试随后成功——夜链白跑还留下
 * 错误的失败痕迹。取 7h 覆盖 6h 预算 + 余量。
 *
 * 定位不变：pg-boss 队列级 expire + retry 才是主 backstop（真 job 总会收敛到 completed/
 * failed），本超时只兜「job 行消失 / 无 worker 消费该队列」这类 pg-boss 自己不会收敛的极端。
 * 上限安全性由锚点兜底：跨日残留 running run 会被次夜锚点 abandon，故拉长不会让 run 永挂。
 *
 * ⚠️ 改 EXPIRE_AGENT / JOB_RETRY_LIMIT / JOB_RETRY_DELAY_SECONDS 时必须回来重算本值。
 */
export const NODE_TIMEOUT_SECONDS = 7 * 60 * 60;

/**
 * 「已领取但 pg-boss 查无此 job」的补发宽限窗（秒，YUK-758 review ToTaI）。
 *
 * 节点的 boss_job_id 在 boss.send **之前**就随 CAS 落库（claimNodePending），所以
 * enqueued 节点永远带 id。若之后 getJobById 查不到该 id，只有一种可能：那次 send 没落地
 * （claim 提交后、send 前崩溃/瞬时失败）。此时按同一个 id 补发即可自愈——pg-boss 的
 * insertJobs 是 `ON CONFLICT DO NOTHING`（id 为主键），**同 id 补发天然幂等**，最多存在
 * 一条真 job，绝无重复付费。
 *
 * 仍设窗而非无限补发：万一某部署把队列 retention 调得极短、已完成的 job 行被清掉，
 * 补发就会变成真的重跑。窗设 5min（崩溃窗实际是毫秒级；几分钟内没出现的 job 就是没发出去），
 * 而 pg-boss 队列 retention/deletion 默认 7d ≫ 本窗，故窗内「查无」不可能是「跑完被清」。
 * 超窗仍查不到 → 落回 NODE_TIMEOUT_SECONDS 兜底判 failed。
 */
export const SEND_RECOVERY_GRACE_SECONDS = 5 * 60;
