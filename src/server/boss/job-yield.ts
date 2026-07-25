// YUK-779 — 夜链 job「静默空跑」判据（纯函数，零依赖）。
//
// 背景：多个夜链 handler 对 AI 调用失败是 per-cell / per-row / per-LLM-half
// `try/catch` **吞掉**的。单点失败时这是**对的**（一道坏题不该炸整批），本模块
// 不改这个语义。问题在**限流风暴**下：同一批里每一条都失败、每一条都被吞，job
// 以 succeeded 收尾、产出为零，DAG 节点转绿，硬下游据此在空数据上继续跑，而运维
// 看到的是「昨晚一切正常」。
//
// ── 判据：区分「正常的零产出」与「异常的零产出」──────────────────────────
// 只报 `created: 0` 无法区分二者——空队列/无候选/全部已处理也是 0。区分的关键是
// **是否真的试过**：
//
//   attempted  = 本轮**调用可失败步骤**（LLM / embed / 判定器）的单元数。
//                走到调用之前就被前置闸挡掉的（dedup 命中、无候选、frontier 稠密、
//                标签不够）**不计**——那是「今晚确实没事可做」。
//   succeeded  = 可失败步骤**正常返回**的单元数。注意「正常返回但没产出」
//                （no_anchor / below_threshold / LLM 判定不该提议）算 **succeeded**
//                ——那是该步骤的合法结论，不是故障。
//   failed     = 可失败步骤**抛错并被吞掉**的单元数。
//
// 不变量：`attempted === succeeded + failed`。前置闸挡掉的单元既不进 attempted
// 也不进另外两项。
//
// 于是四档（见 {@link classifyJobYield}）：
//   idle      —— 压根没走到可失败步骤（attempted 0）。**正常的零产出**，永不报警。
//   ok        —— 有成功产出，失败率在容忍带内。
//   degraded  —— 有成功产出，但失败占多数（见阈值论证）。warn。
//   stalled   —— 试过、且**没有一个成功**。这就是「静默空跑」。error。
//
// ── 为什么 degraded 需要阈值，而 stalled 不需要 ─────────────────────────────
// `stalled`（succeeded === 0）是无参判据：本轮**一点新产出都没有**，下游读到的
// 就是陈旧/空数据——无论成因。它不需要调参，也不会在空夜误报（那是 idle）。
//
// 但只报「全败」会漏掉 attempted=25 / succeeded=1 这种——1 条侥幸通过就让整晚
// 限流风暴显示为「健康」。所以补一档比例判据。阈值取 **0.5**（{@link
// YIELD_DEGRADED_FAILURE_RATE}）的理由：
//   · 因为 attempted === succeeded + failed（合法跳过不稀释分母），这个比率是**纯
//     粹的抛错率**。稳态下它应当接近 0——这里的抛错是「单条数据坏」（parse 失败、
//     ref 悬空），互相独立；而 provider 限流/故障是**相关**失败，会把整批一起打掉。
//     判据要抓的正是这个「相关性跃迁」。
//   · 阈值取太低（如 0.1）会让长期存在几条顽固坏数据的语料**每夜**报警 → 告警疲劳
//     → 没人看 → 退回静默空跑，等于没做。
//   · 0.5 = 「失败的比成功的多」。这句话对运维是自明的故障陈述，远高于任何可信的
//     稳态坏数据率，同时限流风暴一取得多数就立刻命中。
//   · 配 {@link YIELD_DEGRADED_MIN_SAMPLE}=5 的最小样本：attempted ≤ 4 时单条失败
//     就是 0.25、两条就是 0.5，小样本比率是噪声。样本不足时只有无参的 stalled 档
//     生效。（research_meeting_nightly 每轮上限 3 格，故它只会落在
//     idle / stalled / ok 三档，永不 degraded——3 个单元里「有成功」就是真进展，
//     对它算比率没有意义。）
//
// ── 消费点 ─────────────────────────────────────────────────────────────────
// 1. loud log（stalled → console.error，degraded → console.warn）。FAST 队列无
//    DLQ，无日志即全无声。
// 2. handler 把报告作为**返回值**交给 pg-boss：batchSize:1 时 pg-boss 把 handler
//    的 resolved value 存进 job 的 `output` 列（manager.js `complete(name, jobIds,
//    jobIds.length === 1 ? result : undefined)`）→ job 终态携带该信号。
// 3. orchestrator 轮询 `getJobById` 时连 `output` 一起读，把 stalled/degraded 盖进
//    `dag_orchestration_node.detail`——即「昨晚一切正常」这个假象的正面修复。
//
// **本模块不改变夜链的失败语义**：stalled 的 job 依然以 succeeded 收尾、DAG 节点
// 依然转绿、硬下游依然照跑。「要不要让异常空跑直接 fail（进而让硬下游 skip）」是
// 产品语义决策（一次限流风暴会让整条子树全 skip，且 pg-boss 会以 30s 退避重投递
// ——在限流风暴里正是最不该做的事），留给 owner 拍板。

/** 一轮夜跑对「可失败步骤」的尝试/成败计数。不变量：attempted === succeeded + failed。 */
export interface JobYield {
  /** 本轮调用可失败步骤的单元数。前置闸挡掉的不计。 */
  attempted: number;
  /** 可失败步骤正常返回的单元数（含「正常返回但没产出」的合法结论）。 */
  succeeded: number;
  /** 可失败步骤抛错并被吞掉的单元数。 */
  failed: number;
}

/** 四档判定。详见文件头判据说明。 */
export type JobYieldLevel = 'idle' | 'ok' | 'degraded' | 'stalled';

/** 落进 job output / 节点 detail 的报告体。 */
export interface JobYieldReport extends JobYield {
  /** job 名（= pg-boss 队列名 = DAG 成员名）。 */
  job: string;
  level: JobYieldLevel;
  /** 人读一行；ok / idle 为 null（无话可说即不占 detail）。 */
  detail: string | null;
}

/** degraded 档的失败率阈值（严格大于才算）。论证见文件头。 */
export const YIELD_DEGRADED_FAILURE_RATE = 0.5;

/** degraded 档的最小样本量——低于它只有无参的 stalled 档生效。 */
export const YIELD_DEGRADED_MIN_SAMPLE = 5;

/** handler 返回值里承载报告的键；orchestrator 按此键从 job output 取回。 */
export const JOB_YIELD_OUTPUT_KEY = 'job_yield';

/** handler 交给 pg-boss 的返回值形状（→ 存进 job.output）。 */
export interface JobYieldOutput {
  [JOB_YIELD_OUTPUT_KEY]: JobYieldReport;
}

/**
 * 判档。`resolved = succeeded + failed` 是真正走到可失败步骤并有结论的单元数。
 *
 * `resolved <= 0` 一并归 idle 是对「handler 传了 considered 当 attempted、但那些单元
 * 全被内部前置闸挡掉、无一抛错」的防御：那种夜晚同样是**正常的零产出**，绝不能报警。
 * 因此 `succeeded === 0` 分支被 `resolved > 0` 守住 ⇒ 必然 `failed > 0`，即「试过、
 * 有失败、无一成功」——stalled 的完整语义，无需再写一遍 failed > 0。
 */
export function classifyJobYield(y: JobYield): JobYieldLevel {
  const resolved = y.succeeded + y.failed;
  if (y.attempted <= 0 || resolved <= 0) return 'idle';
  if (y.succeeded === 0) return 'stalled';
  if (resolved >= YIELD_DEGRADED_MIN_SAMPLE && y.failed / resolved > YIELD_DEGRADED_FAILURE_RATE) {
    return 'degraded';
  }
  return 'ok';
}

/** 人读一行；ok / idle 无话可说 → null。 */
export function describeJobYield(job: string, y: JobYield, level: JobYieldLevel): string | null {
  if (level === 'stalled') {
    return `${job}: zero yield — all ${y.attempted} attempted unit(s) failed (swallowed); downstream reads stale/empty data`;
  }
  if (level === 'degraded') {
    return `${job}: degraded yield — ${y.failed}/${y.attempted} attempted unit(s) failed (swallowed)`;
  }
  return null;
}

/**
 * 判档 + loud log + 返回可直接交给 pg-boss 的输出体。
 *
 * handler 侧唯一入口：`return reportJobYield('foo_nightly', { attempted, succeeded, failed })`。
 * 返回值经 pg-boss 存进 job.output（batchSize:1），orchestrator 再用
 * {@link readJobYieldReport} 取回盖进节点 detail。
 */
export function reportJobYield(job: string, y: JobYield): JobYieldOutput {
  const level = classifyJobYield(y);
  const detail = describeJobYield(job, y, level);
  if (level === 'stalled') {
    console.error(`[${job}] SILENT NO-OP —`, detail, y);
  } else if (level === 'degraded') {
    console.warn(`[${job}] degraded yield —`, detail, y);
  }
  return { [JOB_YIELD_OUTPUT_KEY]: { job, level, detail, ...y } };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 从 pg-boss job output 里防御性取回报告（orchestrator 侧）。
 *
 * output 是 jsonb，形状不受类型系统保护（旧版本 handler 返回 undefined、手工重放、
 * 未来 handler 返回别的东西都可能）。任何不认识的形状一律返回 undefined——观测层
 * 绝不能因为读不懂一个 output 就炸掉整个 tick。
 */
export function readJobYieldReport(output: unknown): JobYieldReport | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const raw = (output as Record<string, unknown>)[JOB_YIELD_OUTPUT_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.job !== 'string') return undefined;
  if (r.level !== 'idle' && r.level !== 'ok' && r.level !== 'degraded' && r.level !== 'stalled') {
    return undefined;
  }
  if (!isFiniteNumber(r.attempted) || !isFiniteNumber(r.succeeded) || !isFiniteNumber(r.failed)) {
    return undefined;
  }
  return {
    job: r.job,
    level: r.level,
    detail: typeof r.detail === 'string' ? r.detail : null,
    attempted: r.attempted,
    succeeded: r.succeeded,
    failed: r.failed,
  };
}
