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
 * 同一轮 advance 内**齐发**成员 job 的错峰间隔 / 上限（秒，YUK-758 review 面板疑点 ②）。
 *
 * 为什么需要：`JobDecl.queue`（'llm' | 'agent' | 'fast'）**只是档位标签，不是 pg-boss 队列名**
 * ——`register-capability-jobs.ts` 用 `boss.work(decl.name, ...)`，每只 job 是**自己的**队列、
 * 自己的 worker。所以 `batchSize: 1` 只保证「同一只 job 不并跑」，完全不约束**不同** job 之间。
 * 本图有 8 个根节点且全部 `queue: 'llm'`，锚点一开闸会把 8 只 LLM job 同秒推给 provider；
 * 而 AI 调用路径无任何并发闸（无 p-limit/semaphore），429 的 in-process 退避对 durable handler
 * 是**特意关掉**的（queue-config.ts：「queue redelivery is their ONLY transient layer」），
 * 队列重试又是固定 30s 无 jitter → 整群同时失败、同时重试、再次对撞。
 *
 * 迁移前这 8 只散在 02:30–05:15 的独立 cron 时刻，错峰**顺带**承担了限流分摊；直切成 DAG 把
 * 这层保护一并去掉了。DAG 的 happens-before 边比钟表偏移强，值得保留——只是不该让**同层**齐发。
 * 故只补最小一道闸：同一轮 advance 里第 n 个入队的 job 加 n×间隔 的 `startAfter`（pg-boss 原生
 * 支持，不自造调度器）。串行链上每轮通常只有 1 个就绪节点 → offset=0，不加任何延迟。
 *
 * 上限存在是为了让延迟**不随图变大而无界**：总错峰封顶后，余下的仍会齐发，但那已远好于 8 齐发。
 * 封顶值须与 NODE_TIMEOUT_SECONDS 相容——最坏 15min 错峰 + 6h 重试预算 < 7h 超时。
 */
export const LAYER_STAGGER_SECONDS = 120;
export const LAYER_STAGGER_MAX_SECONDS = 15 * 60;

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
