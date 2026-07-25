// YUK-779 — 「静默空跑」判据单测。核心断言是那条分界线：
// **正常的零产出不报警，异常的零产出报警。**

import { describe, expect, it, vi } from 'vitest';

import {
  JOB_YIELD_OUTPUT_KEY,
  YIELD_DEGRADED_FAILURE_RATE,
  YIELD_DEGRADED_MIN_SAMPLE,
  classifyJobYield,
  describeJobYield,
  readJobYieldReport,
  reportJobYield,
} from './job-yield';

describe('classifyJobYield — 正常的零产出 vs 异常的零产出', () => {
  it('空队列 / 无候选 / 全部已处理 → idle（绝不报警）', () => {
    // 这是「今晚确实没事可做」：前置闸挡在可失败步骤之前，一次调用都没发生。
    expect(classifyJobYield({ attempted: 0, succeeded: 0, failed: 0 })).toBe('idle');
  });

  it('有候选、可失败步骤全部正常返回但没产出 → ok（合法结论，不报警）', () => {
    // recalibration_nightly 的招牌夜：200 道题全部 below_threshold。
    // recalibrateQuestion 每次都正常返回，只是数据闸没过 —— 这是**正常的零产出**。
    expect(classifyJobYield({ attempted: 200, succeeded: 200, failed: 0 })).toBe('ok');
  });

  it('试过、且没有一个成功 → stalled（这就是静默空跑）', () => {
    expect(classifyJobYield({ attempted: 3, succeeded: 0, failed: 3 })).toBe('stalled');
    expect(classifyJobYield({ attempted: 25, succeeded: 0, failed: 25 })).toBe('stalled');
  });

  it('单个可失败单元（whole-LLM-half 形态）也适用两侧判据', () => {
    // goal_scope / frontier_fill / knowledge_edge_propose：attempted 是 0 或 1。
    expect(classifyJobYield({ attempted: 0, succeeded: 0, failed: 0 })).toBe('idle'); // 前置闸挡掉
    expect(classifyJobYield({ attempted: 1, succeeded: 1, failed: 0 })).toBe('ok'); // 模型没什么可提的
    expect(classifyJobYield({ attempted: 1, succeeded: 0, failed: 1 })).toBe('stalled'); // 调用炸了
  });

  it('部分失败：超过阈值且样本足够 → degraded；否则 ok', () => {
    // 24/25 失败 —— 1 条侥幸通过不该让整晚限流风暴显示为「健康」。
    expect(classifyJobYield({ attempted: 25, succeeded: 1, failed: 24 })).toBe('degraded');
    // 恰好一半不越阈（严格大于才算）。
    expect(classifyJobYield({ attempted: 10, succeeded: 5, failed: 5 })).toBe('ok');
    // 越阈一格。
    expect(classifyJobYield({ attempted: 10, succeeded: 4, failed: 6 })).toBe('degraded');
    // 稳态坏数据（几条顽固坏题）不该每夜报警。
    expect(classifyJobYield({ attempted: 25, succeeded: 23, failed: 2 })).toBe('ok');
  });

  it('样本不足时只有无参的 stalled 档生效（小样本比率是噪声）', () => {
    // 3 个单元里 2 败 1 成 = 0.67 > 0.5，但样本 < YIELD_DEGRADED_MIN_SAMPLE → 不判 degraded。
    expect(YIELD_DEGRADED_MIN_SAMPLE).toBe(5);
    expect(classifyJobYield({ attempted: 3, succeeded: 1, failed: 2 })).toBe('ok');
    // 但同样 3 个单元里一个都没成 —— 依然是 stalled，与样本量无关。
    expect(classifyJobYield({ attempted: 3, succeeded: 0, failed: 3 })).toBe('stalled');
  });

  it('阈值常量就是「失败的比成功的多」', () => {
    expect(YIELD_DEGRADED_FAILURE_RATE).toBe(0.5);
  });

  it('handler 误把 considered 当 attempted、且无一抛错 → 仍归 idle，不误报', () => {
    // 防御分支：若某 handler 传的 attempted 含被内部前置闸挡掉的单元，而
    // succeeded/failed 都是 0，那依然是「没走到可失败步骤」，绝不能报成 stalled。
    expect(classifyJobYield({ attempted: 100, succeeded: 0, failed: 0 })).toBe('idle');
  });
});

describe('reportJobYield', () => {
  it('stalled → console.error + 携带 detail 的报告体', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = reportJobYield('research_meeting_nightly', {
      attempted: 3,
      succeeded: 0,
      failed: 3,
    });
    const report = out[JOB_YIELD_OUTPUT_KEY];
    expect(report.level).toBe('stalled');
    expect(report.job).toBe('research_meeting_nightly');
    expect(report.detail).toContain('zero yield');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('degraded → console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = reportJobYield('item_prior_backfill', { attempted: 25, succeeded: 1, failed: 24 });
    expect(out[JOB_YIELD_OUTPUT_KEY].level).toBe('degraded');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('idle / ok → 一声不吭，detail 为 null（空夜不占 detail）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const y of [
      { attempted: 0, succeeded: 0, failed: 0 },
      { attempted: 200, succeeded: 200, failed: 0 },
    ]) {
      expect(reportJobYield('recalibration_nightly', y)[JOB_YIELD_OUTPUT_KEY].detail).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});

describe('describeJobYield — 展示分母必须与判据分母同源（PR #1076 review）', () => {
  it('degraded 展示的比例就是触发告警的那个比例，且标出阈值', () => {
    // 判据用 resolved = succeeded + failed = 8，failed/resolved = 5/8 = 62.5% > 50%。
    const msg = describeJobYield('x', { attempted: 8, succeeded: 3, failed: 5 }, 'degraded');
    expect(msg).toContain('5/8 resolved unit(s) failed');
    expect(msg).toContain('62.5% > 50% threshold');
    // 绝不能拿 attempted 当分母印出另一个数。
    expect(msg).not.toContain('/8 attempted');
  });

  it('attempted ≠ resolved 时，分母仍是 resolved，attempted 另行标出而非藏起来', () => {
    // 病态输入：handler 传了含前置闸单元的 considered。判据看的是 5/8（62.5%），
    // 旧版本会印成 5/100（5%）——读者据此会判成「几乎没失败，为什么报警」。
    const msg = describeJobYield('x', { attempted: 100, succeeded: 3, failed: 5 }, 'degraded');
    expect(msg).toContain('5/8 resolved unit(s) failed');
    expect(msg).toContain('62.5% > 50% threshold');
    expect(msg).toContain('[attempted=100]');
    expect(msg).not.toContain('5/100');
  });

  it('刚过阈值时不得印出「50% > 50%」这种自相矛盾的话（取整精度）', () => {
    // 63/125 = 50.4% —— 判据用未取整比率判 degraded（严格 >），展示取整到整数会印成
    // 「50% > 50% threshold」，字面为假，运维会当误报忽略。
    const y = { attempted: 125, succeeded: 62, failed: 63 };
    expect(classifyJobYield(y)).toBe('degraded');
    const msg = describeJobYield('x', y, 'degraded');
    expect(msg).toContain('50.4% > 50% threshold');
    expect(msg).not.toContain('50% > 50% threshold');
  });

  it('不变量成立时不加 [attempted=…] 噪声', () => {
    const msg = describeJobYield('x', { attempted: 8, succeeded: 3, failed: 5 }, 'degraded');
    expect(msg).not.toContain('[attempted=');
  });

  it('stalled 也用 resolved 作分母，不再声称「all N attempted 都失败了」', () => {
    const msg = describeJobYield('x', { attempted: 3, succeeded: 0, failed: 3 }, 'stalled');
    expect(msg).toContain('0/3 resolved unit(s) succeeded');
    expect(msg).toContain('3 swallowed failure(s)');
    // 病态输入下不得谎称 100 个单元全失败了（实际只解出 3 个）。
    const skewed = describeJobYield('x', { attempted: 100, succeeded: 0, failed: 3 }, 'stalled');
    expect(skewed).toContain('0/3 resolved unit(s) succeeded');
    expect(skewed).toContain('[attempted=100]');
    expect(skewed).not.toContain('all 100');
  });

  it('resolved === 0 时不得印 NaN——本函数是导出的，level 由调用方给，不保证自洽', () => {
    // 走 reportJobYield 时 {0,0,0} 必然判 idle、到不了 degraded 分支；但直接调用
    // （测试 / 未来调用方）会让 failed/resolved 得出 NaN，印出「NaN% > 50% threshold」。
    expect(describeJobYield('x', { attempted: 0, succeeded: 0, failed: 0 }, 'degraded')).toBeNull();
    expect(describeJobYield('x', { attempted: 0, succeeded: 0, failed: 0 }, 'stalled')).toBeNull();
    // 分母非零时照常出话（守卫不得误伤正常路径）。
    expect(describeJobYield('x', { attempted: 3, succeeded: 0, failed: 3 }, 'stalled')).toContain(
      '0/3 resolved unit(s) succeeded',
    );
  });

  it('展示的百分比与 classifyJobYield 的判定在阈值边界上不会互相矛盾', () => {
    // 恰好 50%：判据严格大于 → ok（无消息）。展示层不得暗示它越了阈值。
    const y = { attempted: 10, succeeded: 5, failed: 5 };
    expect(classifyJobYield(y)).toBe('ok');
    expect(describeJobYield('x', y, classifyJobYield(y))).toBeNull();
  });
});

describe('readJobYieldReport — 防御性回读（orchestrator 侧）', () => {
  it('round-trips reportJobYield 的输出', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = reportJobYield('frontier_fill_nightly', { attempted: 1, succeeded: 0, failed: 1 });
    // JSON round-trip 模拟 pg-boss 的 jsonb 往返。
    const parsed = readJobYieldReport(JSON.parse(JSON.stringify(out)));
    expect(parsed).toEqual(out[JOB_YIELD_OUTPUT_KEY]);
    spy.mockRestore();
  });

  it('任何不认识的形状一律 undefined，绝不抛（观测层不得炸掉 tick）', () => {
    for (const bad of [
      undefined,
      null,
      42,
      'nope',
      {},
      { job_yield: null },
      { job_yield: 'nope' },
      { job_yield: { job: 'x', level: 'bogus', attempted: 1, succeeded: 0, failed: 1 } },
      { job_yield: { job: 7, level: 'stalled', attempted: 1, succeeded: 0, failed: 1 } },
      { job_yield: { job: 'x', level: 'stalled', attempted: 'many', succeeded: 0, failed: 1 } },
      // 旧版本 handler 返回 void → pg-boss 存空 output。
      { some_other_key: 1 },
    ]) {
      expect(readJobYieldReport(bad)).toBeUndefined();
    }
  });

  it('负数计数属于「不认识的形状」，必须被拒（PR #1076 review）', () => {
    // 三个字段都是**计数**，负值无从产生，出现即意味着 output 被篡改/损坏。
    // 放行会算出荒谬比例（下面第二例：resolved=1，failed/resolved=200%）并把一行
    // 胡话盖进节点 detail。宁可整条读不出来（等同「这个 job 没报产出」）也不要报错的。
    for (const bad of [
      { job_yield: { job: 'x', level: 'ok', attempted: -1, succeeded: 0, failed: 0 } },
      { job_yield: { job: 'x', level: 'stalled', attempted: 1, succeeded: -1, failed: 2 } },
      { job_yield: { job: 'x', level: 'ok', attempted: 1, succeeded: 1, failed: -3 } },
    ]) {
      expect(readJobYieldReport(bad)).toBeUndefined();
    }
    // 0 是合法计数，不得被非负校验误伤（空夜的正常形状）。
    expect(
      readJobYieldReport({
        job_yield: { job: 'x', level: 'idle', attempted: 0, succeeded: 0, failed: 0 },
      }),
    ).toMatchObject({ level: 'idle', attempted: 0 });
  });

  it('小数计数必须被拒——它能绕过不变量守卫（PR #1076 review）', () => {
    // {1.5, 0.5, 1} 恰好**满足** attempted === succeeded + failed（1.5 === 0.5 + 1），
    // 所以不变量守卫拦不住它；只有整数校验能。放行会印出「1/1.5 resolved unit(s)
    // failed」——半个单元不存在，这是一句没有意义的话。
    expect(
      readJobYieldReport({
        job_yield: { job: 'x', level: 'degraded', attempted: 1.5, succeeded: 0.5, failed: 1 },
      }),
    ).toBeUndefined();
    // 确认它确实过得了不变量那一关（即证明整数校验不是冗余的）。
    expect(1.5).toBe(0.5 + 1);

    // 非有限值同样被 Number.isInteger 拦下。
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        readJobYieldReport({
          job_yield: { job: 'x', level: 'ok', attempted: bad, succeeded: 0, failed: 0 },
        }),
      ).toBeUndefined();
    }
  });

  it('违反 attempted === succeeded + failed 的三元组必须被拒（PR #1076 review）', () => {
    // 这条不是洁癖：{attempted:0, succeeded:3, failed:5} 三个字段都过 isCount，却会在
    // classifyJobYield 里因 attempted<=0 短路成 idle —— 把 5 次真实吞错说成
    // 「今晚没事可做」，正好是本模块存在的理由被反过来利用。
    const corrupted = { job: 'x', level: 'idle', attempted: 0, succeeded: 3, failed: 5 };
    expect(readJobYieldReport({ job_yield: corrupted })).toBeUndefined();
    // 确认危害真实存在（若放行，判档就是 idle）。
    expect(classifyJobYield({ attempted: 0, succeeded: 3, failed: 5 })).toBe('idle');

    // 另一向的失配同样拒（attempted 虚高）。
    expect(
      readJobYieldReport({
        job_yield: { job: 'x', level: 'ok', attempted: 100, succeeded: 3, failed: 5 },
      }),
    ).toBeUndefined();

    // 合法三元组照常解出（守卫不得误伤正常路径）。
    expect(
      readJobYieldReport({
        job_yield: { job: 'x', level: 'ok', attempted: 8, succeeded: 3, failed: 5 },
      }),
    ).toMatchObject({ attempted: 8, succeeded: 3, failed: 5 });
  });

  it('detail 缺失/非字符串时归一为 null，其余字段照常解出', () => {
    const parsed = readJobYieldReport({
      job_yield: { job: 'x', level: 'ok', attempted: 2, succeeded: 2, failed: 0 },
    });
    expect(parsed).toEqual({
      job: 'x',
      level: 'ok',
      detail: null,
      attempted: 2,
      succeeded: 2,
      failed: 0,
    });
  });
});
