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
 * 让硬下游据此跳过（票面「上游超时 → 下游不跑并留痕」）。3h > EXPIRE_AGENT(2h)：pg-boss
 * 队列级 expire 是主 backstop，本超时只兜「job 行消失 / 卡死」的极端。
 */
export const NODE_TIMEOUT_SECONDS = 3 * 60 * 60;
