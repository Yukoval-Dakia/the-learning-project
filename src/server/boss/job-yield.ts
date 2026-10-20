// 夜链 handler 吞掉单条失败。整批全失败时 job 仍 succeeded，下游会在空数据上继续。
// 这里只分类，不改吞错。
//
// attempted 只计真正调用了可失败步骤的单元。前置闸挡掉的不计。
// succeeded 含正常返回但没产出。failed 是被吞掉的抛错。
// 不变量是 attempted === succeeded + failed。
//
// idle 是没走到可失败步骤，不报警。ok 是有成功且失败率未过线。
// degraded 是有成功，但失败严格多于成功。stalled 是试过且无一成功。
// stalled 不需要阈值。只报全败会漏掉 25 次里成功 1 次的限流。
// 分母是 resolved = succeeded + failed，所以比率是抛错率，不被合法跳过稀释。
// 稳态坏数据彼此独立。限流是相关失败。0.5 是「失败比成功多」，再低会每夜报警。
// 样本不足 5 时比率是噪声，只留无参的 stalled。
//
// pg-boss 在 batchSize 为 1 时把返回值写入 job.output。FAST 队列没有 DLQ，所以失败必须打日志。
// stalled 让 DAG 节点落成 degraded。yield 档 degraded 仍是 succeeded，detail 留告警。
// 节点 degraded 不连坐下游。job 仍 completed。这里不重投，重投会在限流里再打一轮。

/** 一轮夜跑的可失败步骤计数。不变量是 attempted === succeeded + failed。 */
export interface JobYield {
  /** 调用了可失败步骤的单元数。前置闸挡掉的不计。 */
  attempted: number;
  /** 正常返回的单元数，含合法的空产出。 */
  succeeded: number;
  /** 抛错并被吞掉的单元数。 */
  failed: number;
}

export type JobYieldLevel = 'idle' | 'ok' | 'degraded' | 'stalled';

/** 写入 job output 和节点 detail 的报告。 */
export interface JobYieldReport extends JobYield {
  /** 队列名，也是 DAG 成员名。 */
  job: string;
  level: JobYieldLevel;
  /** ok 和 idle 为 null，避免占 detail。 */
  detail: string | null;
}

/** 严格大于才算 degraded。理由见文件头。 */
export const YIELD_DEGRADED_FAILURE_RATE = 0.5;

/** 低于它只生效无参的 stalled。 */
export const YIELD_DEGRADED_MIN_SAMPLE = 5;

/** orchestrator 用这个键从 job output 取回报告。 */
export const JOB_YIELD_OUTPUT_KEY = 'job_yield';
export interface JobYieldOutput {
  [JOB_YIELD_OUTPUT_KEY]: JobYieldReport;
}

/**
 * resolved <= 0 也归 idle。handler 可能把含前置闸的 considered 当成 attempted，
 * 那些单元若无一抛错，仍是正常的零产出。
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

/**
 * ok 和 idle 返回 null。分母用 resolved，与判档相同。
 * 用 attempted 当展示分母时，前置闸会把告警比例显示得更小。
 */
export function describeJobYield(job: string, y: JobYield, level: JobYieldLevel): string | null {
  if (level !== 'stalled' && level !== 'degraded') return null;
  const resolved = y.succeeded + y.failed;
  // level 由调用方传入，不必与判档自洽。resolved 为 0 时返回 null，避免印出 NaN%。
  if (resolved <= 0) return null;
  // 不变量不成立时标出 attempted，不把它放进分母。
  const attemptedNote = y.attempted === resolved ? '' : ` [attempted=${y.attempted}]`;
  if (level === 'stalled') {
    return `${job}: zero yield — 0/${resolved} resolved unit(s) succeeded, ${y.failed} swallowed failure(s); downstream reads stale/empty data${attemptedNote}`;
  }
  // 留一位小数。整数取整会把 50.4% 印成「50% > 50%」。
  const pct = Math.round((y.failed / resolved) * 1000) / 10;
  const threshold = Math.round(YIELD_DEGRADED_FAILURE_RATE * 1000) / 10;
  return `${job}: degraded yield — ${y.failed}/${resolved} resolved unit(s) failed (${pct}% > ${threshold}% threshold)${attemptedNote}`;
}

/** 判档、打日志，并返回 pg-boss 会写入 job.output 的对象。 */
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

/**
 * 计数必须是非负整数。小数能凑出 attempted === succeeded + failed，然后印出半个单元。
 * 坏形状整条丢掉，当成这个 job 没报产出。
 */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * output 是 jsonb。不认识的形状返回 undefined，一条坏 output 不能炸掉整个 tick。
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
  if (!isCount(r.attempted) || !isCount(r.succeeded) || !isCount(r.failed)) {
    return undefined;
  }
  // attempted 为 0 且 succeeded 非 0 会被判成 idle，把真实吞错说成没事可做。
  // 违反不变量的三元组按不认识的形状丢掉。
  if (r.attempted !== r.succeeded + r.failed) return undefined;
  return {
    job: r.job,
    level: r.level,
    detail: typeof r.detail === 'string' ? r.detail : null,
    attempted: r.attempted,
    succeeded: r.succeeded,
    failed: r.failed,
  };
}
