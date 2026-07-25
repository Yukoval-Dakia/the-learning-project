// YUK-758 夜间任务编排 orchestrator 常量。独立模块（不向 god file 加肉）。

/** orchestrator 自身的 pg-boss 队列名（单锚点）。 */
export const ORCHESTRATOR_QUEUE = 'nightly_orchestrator';

/**
 * 单锚点时刻：~02:30 Asia/Shanghai 开闸建「今晚运行记录」+ enqueue 根节点。
 * 图成员 job 自身**不再**带 cron（validateComposition 强制互斥）——全由本锚点驱动。
 *
 * cron 串由时/分**推导**而非另写一份字面量（YUK-781）：启动期补跑闸要判「现在离锚点多久」，
 * 两处各写一遍 02:30 会在改锚点时静默分叉（cron 挪了、补跑窗还按老时刻算）。
 */
export const ORCHESTRATOR_ANCHOR_HOUR = 2;
export const ORCHESTRATOR_ANCHOR_MINUTE = 30;
export const ORCHESTRATOR_CRON = `${ORCHESTRATOR_ANCHOR_MINUTE} ${ORCHESTRATOR_ANCHOR_HOUR} * * *`;
export const ORCHESTRATOR_TZ = 'Asia/Shanghai';

/**
 * 启动期补跑窗（秒，YUK-781 A）。worker 挂载后若「本地日尚无任何 run」**且**本地时间落在
 * `[锚点, 锚点 + 本窗)` 内，补一次 `runOrchestratorStart(..., 'cron')`；超窗只 loud log 等次夜。
 *
 * **为什么必须补**：pg-boss 的 cron **不重放错过的锚点**。timekeeper 每
 * `cronMonitorIntervalSeconds`（默认 30s）跑一次 `cron()`，`shouldSendIt()` 只在
 * 「上一次 cron 时刻距今 < 60s」时才入队（timekeeper.js `shouldSendIt`：
 * `prevDiff = (databaseTime - interval.prev()) / 1000; return prevDiff < 60`）。
 * 整机/整栈在 02:30±60s 窗内是停的（夜间断电、compose down 部署、重启拉镜像慢），
 * 该夜锚点就**根本没入过队**——14 个 DAG 成员一个都不跑，`dag_orchestration_run` 里连行都没有
 * （不是 abandoned，是"没有"），直到次日 02:30。迁移前成员各带 03:00–06:00 独立 cron，
 * 错过 02:30 只损失那一只。
 *
 * **为什么必须带窗口**：补跑是"把夜链搬到现在跑"。无窗口时中午/傍晚的一次重启会把整条夜链
 * （8 个付费 LLM 根 + 下游）拉到白天与学习者同时在线时跑。取 5h → 最晚 07:30 起步：
 *  · 下界考量：迁移前成员 cron 散在 02:30–05:15，夜批本就跑到 ~06:00；窗口短于 3.5h 会让
 *    「04:00/05:00 重启」这类真实错过场景无法恢复。
 *  · 上界考量：6h → 08:30 起步已进入白天使用时段；5h 留出约 1.5h 越过历史夜批包络即止。
 *  · 与 NODE_TIMEOUT_SECONDS(7h) 同量级，故不会出现「窗口比单节点预算还长」的怪相。
 */
export const ORCHESTRATOR_CATCHUP_WINDOW_SECONDS = 5 * 60 * 60;

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
