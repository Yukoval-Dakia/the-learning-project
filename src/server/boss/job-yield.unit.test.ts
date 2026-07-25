// YUK-779 — 「静默空跑」判据单测。核心断言是那条分界线：
// **正常的零产出不报警，异常的零产出报警。**

import { describe, expect, it, vi } from 'vitest';

import {
  JOB_YIELD_OUTPUT_KEY,
  YIELD_DEGRADED_FAILURE_RATE,
  YIELD_DEGRADED_MIN_SAMPLE,
  classifyJobYield,
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
