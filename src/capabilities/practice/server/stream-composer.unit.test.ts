// M2 (YUK-316) — composeDailyStream 纯函数核心的混排规则测试。
// 规则来源：P2 spec §2.1 + 设计稿数据形状（docs/design/loom-refresh，PFACE.items：
// decay 热身 → decay/variant 穿插 → 卷收口 → new_check 收尾）。

import { describe, expect, it } from 'vitest';
import { type ComposerInputs, composeDailyStream } from './stream-composer';

function inputs(partial: Partial<ComposerInputs>): ComposerInputs {
  return {
    date: '2026-06-11',
    dueItems: [],
    variantItems: [],
    newCheckItems: [],
    pendingPapers: [],
    ...partial,
  };
}

const due = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ questionId: `q_due_${i}`, knowledgeLabel: `kp_${i}` }));
const variants = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    questionId: `q_var_${i}`,
    rootQuestionId: `q_root_${i}`,
  }));

describe('composeDailyStream — 混排规则', () => {
  it('空输入产出空流（不报错，不发明 item）', () => {
    const plan = composeDailyStream(inputs({}));
    expect(plan.items).toEqual([]);
    expect(plan.truncated).toBe(false);
    expect(plan.warned).toBe(false);
  });

  it('R1 热身：有 decay 时第一项必是 decay', () => {
    const plan = composeDailyStream(
      inputs({
        dueItems: due(3),
        variantItems: variants(2),
        newCheckItems: [{ questionId: 'q_nc', knowledgeId: 'k1' }],
      }),
    );
    expect(plan.items[0].source).toBe('decay');
  });

  it('R2 variant 穿插在散题段中（不在流首），R3 卷在散题后、new_check 永远最后', () => {
    const plan = composeDailyStream(
      inputs({
        dueItems: due(4),
        variantItems: variants(2),
        newCheckItems: [{ questionId: 'q_nc', knowledgeId: 'k1' }],
        pendingPapers: [{ paperId: 'pp_1', title: '虚词小卷', source: 'paper' }],
      }),
    );
    const sources = plan.items.map((i) => i.source);
    expect(sources[0]).not.toBe('variant');
    // 卷之后只允许 new_check
    const paperIdx = sources.indexOf('paper');
    expect(paperIdx).toBeGreaterThan(-1);
    for (const s of sources.slice(paperIdx + 1)) expect(s).toBe('new_check');
    // new_check 收尾
    expect(sources[sources.length - 1]).toBe('new_check');
    // variant 全部位于卷之前的散题段
    for (const [i, s] of sources.entries()) if (s === 'variant') expect(i).toBeLessThan(paperIdx);
  });

  it('R4 去重：同 questionId 在 due 与 variant 同时出现时保留 decay，一题只排一次', () => {
    const plan = composeDailyStream(
      inputs({
        dueItems: [{ questionId: 'q_x' }, { questionId: 'q_y' }],
        variantItems: [{ questionId: 'q_x', rootQuestionId: 'q_r' }],
      }),
    );
    const refs = plan.items.map((i) => i.ref_id);
    expect(refs.filter((r) => r === 'q_x')).toHaveLength(1);
    expect(plan.items.find((i) => i.ref_id === 'q_x')?.source).toBe('decay');
  });

  it('R5 容量：超 max 截断置 truncated；超 warn 不截断只置 warned（护栏两层语义）', () => {
    const truncatedPlan = composeDailyStream(
      inputs({ dueItems: due(40), capacity: { warn: 12, max: 30 } }),
    );
    expect(truncatedPlan.items).toHaveLength(30);
    expect(truncatedPlan.truncated).toBe(true);
    expect(truncatedPlan.warned).toBe(true);

    const warnedPlan = composeDailyStream(
      inputs({ dueItems: due(15), capacity: { warn: 12, max: 30 } }),
    );
    expect(warnedPlan.items).toHaveLength(15);
    expect(warnedPlan.truncated).toBe(false);
    expect(warnedPlan.warned).toBe(true);
  });

  it('R6 position 从 1 起连续；R7 reasoning 非空', () => {
    const plan = composeDailyStream(
      inputs({
        dueItems: due(2),
        pendingPapers: [{ paperId: 'pp_1', title: '小卷', source: 'on_demand' }],
      }),
    );
    expect(plan.items.map((i) => i.position)).toEqual([1, 2, 3]);
    for (const it of plan.items) expect(it.reasoning.length).toBeGreaterThan(0);
  });

  // ── B3 frontier（YUK-349 #3）─────────────────────────────────────────────────
  const frontiers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      questionId: `q_fr_${i}`,
      knowledgeId: `k_fr_${i}`,
    }));

  it('B3 NO-OP：frontierItems 缺省 / [] → 输出与无 frontier 的 7-rule fixture 逐字相同', () => {
    const base = inputs({
      dueItems: due(4),
      variantItems: variants(2),
      newCheckItems: [{ questionId: 'q_nc', knowledgeId: 'k1' }],
      pendingPapers: [{ paperId: 'pp_1', title: '小卷', source: 'paper' }],
    });
    const baseline = composeDailyStream(base); // frontierItems 缺省（undefined）
    const withEmpty = composeDailyStream({ ...base, frontierItems: [] });
    // 缺省与显式 [] 必须产出**逐字相同**的 plan（NO-OP defer-flip）。
    expect(withEmpty).toEqual(baseline);
  });

  it('B3：frontier 追加在 new_check 之后；due/variant/new_check 位置不变', () => {
    const base = inputs({
      dueItems: due(2),
      newCheckItems: [{ questionId: 'q_nc', knowledgeId: 'k1' }],
    });
    const baseline = composeDailyStream(base);
    const withFrontier = composeDailyStream({ ...base, frontierItems: frontiers(2) });

    // 非 frontier 前缀逐字等同 baseline（位置/source/ref 全不变）。
    const prefix = withFrontier.items.slice(0, baseline.items.length);
    expect(prefix).toEqual(baseline.items);
    // frontier 在尾部、在 new_check 之后。
    const sources = withFrontier.items.map((i) => i.source);
    const lastNewCheck = sources.lastIndexOf('new_check');
    const firstFrontier = sources.indexOf('frontier');
    expect(firstFrontier).toBeGreaterThan(lastNewCheck);
    // 末两项是 frontier，position 连续。
    expect(sources.slice(-2)).toEqual(['frontier', 'frontier']);
    expect(withFrontier.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('B3 R4 去重：frontier 题与已排 due 题同 id 时不重复排入', () => {
    const plan = composeDailyStream(
      inputs({
        dueItems: [{ questionId: 'q_shared' }],
        frontierItems: [{ questionId: 'q_shared', knowledgeId: 'k_fr' }],
      }),
    );
    const refs = plan.items.map((i) => i.ref_id);
    expect(refs.filter((r) => r === 'q_shared')).toHaveLength(1);
    expect(plan.items.find((i) => i.ref_id === 'q_shared')?.source).toBe('decay');
  });

  it('paper item 携带卷自身的来源（on_demand/import 保留，不统一成 paper）', () => {
    const plan = composeDailyStream(
      inputs({
        pendingPapers: [
          { paperId: 'pp_a', title: 'A', source: 'import' },
          { paperId: 'pp_b', title: 'B', source: 'on_demand' },
        ],
      }),
    );
    expect(plan.items.map((i) => i.source)).toEqual(['import', 'on_demand']);
    expect(plan.items.every((i) => i.item_kind === 'paper')).toBe(true);
  });
});
