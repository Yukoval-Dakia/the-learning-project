// YUK-1053 — 学习结算纯决策层单测（无 IO；unit 分区）。
//
// 覆盖 D13/D14/D15/D16 的判定面：
//   - deriveCoarseVerdict：聚合一次（绝不二聚合）、阈值/未映射/无分母语义
//     与 1047 消费投影单源；
//   - ratingForVerdict：D14 三等级 + unsupported ⇒ none；
//   - classifyScoredUnit：blank_marked_zero/pending ⇒ uninformative（空白不
//     当作全部 KC failure）；additive/holistic 分档；
//   - localizeKcObservations：ambiguous/partial 未局部化 ⇒ abstain；混合位
//     ⇒ abstain；uniform ⇒ 1/0；每 KC ≤1 obs；
//   - resolveThetaDecision（bounded evidence adapter）：uniform ⇒ 一次共享
//     update；mixed ⇒ abstain；manual/self_report/assisted ⇒ 排除 θ̂。

import { describe, expect, it } from 'vitest';
import type { ScoringUnitResultT } from './judgment';
import type { ScoringBasisT, ScoringUnitT } from './scoring';
import {
  aggregateMaxPoints,
  classifyScoredUnit,
  deriveCoarseVerdict,
  localizeKcObservations,
  ratingForVerdict,
  resolveThetaDecision,
} from './settlement';

// ---------- fixture helpers ----------

function additiveUnit(id: string, points = 4, slotRefs: string[] = [`${id}_slot`]): ScoringUnitT {
  return {
    scoring_unit_id: id,
    slot_refs: slotRefs,
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: { kind: 'text_key', accepted_texts: ['x'], normalization: 'trim' },
    points,
  };
}

function holisticUnit(id: string, levelPoints?: Record<string, number>): ScoringUnitT {
  return {
    scoring_unit_id: id,
    slot_refs: [`${id}_slot`],
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: {
      kind: 'holistic_level',
      levels: [
        { level_id: 'L0', descriptor_md: 'low', rank: 0 },
        { level_id: 'L1', descriptor_md: 'mid', rank: 1 },
        { level_id: 'L2', descriptor_md: 'top', rank: 2 },
      ],
    },
    points: null,
    ...(levelPoints ? { level_points: levelPoints } : {}),
  };
}

function basis(units: ScoringUnitT[], aggregation?: ScoringBasisT['aggregation']): ScoringBasisT {
  return {
    units,
    aggregation: aggregation ?? { kind: 'sum' },
    blank_scores_zero: true,
  };
}

function scored(
  id: string,
  points: number | null,
  opts: Partial<ScoringUnitResultT> = {},
): ScoringUnitResultT {
  return {
    status: 'scored',
    scoring_unit_id: id,
    points_awarded: points,
    scored_because: 'response',
    ...opts,
  } as ScoringUnitResultT;
}

describe('deriveCoarseVerdict（与 1047 投影同一阈值语义）', () => {
  const b = basis([additiveUnit('u1', 4)]);

  it('pending 状态 ⇒ unsupported(evaluation_pending)', () => {
    const v = deriveCoarseVerdict({ status: 'pending', aggregate: null }, b);
    expect(v.verdict).toBe('unsupported');
    expect(v.reason).toBe('evaluation_pending');
  });

  it('unresolved 聚合 ⇒ unsupported(aggregate_unresolved)', () => {
    const v = deriveCoarseVerdict(
      {
        status: 'completed',
        aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'x' },
      },
      b,
    );
    expect(v.verdict).toBe('unsupported');
  });

  it('level 无映射点（points=null）⇒ unsupported(level_unmapped)，不凭空造分', () => {
    const v = deriveCoarseVerdict(
      { status: 'completed', aggregate: { kind: 'level', level_id: 'LX', points: null } },
      b,
    );
    expect(v.verdict).toBe('unsupported');
    expect(v.reason).toBe('level_unmapped');
  });

  it('满分 ⇒ correct；零分 ⇒ incorrect；中间 ⇒ partial（0.85 阈值）', () => {
    const mk = (points: number) =>
      deriveCoarseVerdict(
        {
          status: 'completed',
          aggregate: { kind: 'points_total', points, policy: { kind: 'sum' } },
        },
        b,
      );
    expect(mk(4).verdict).toBe('correct');
    expect(mk(0).verdict).toBe('incorrect');
    expect(mk(3.4).verdict).toBe('correct'); // 恰好阈值
    expect(mk(3.39).verdict).toBe('partial');
    expect(mk(0.01).verdict).toBe('partial');
  });

  it('weighted_sum：权重折进分母', () => {
    const wb = basis([additiveUnit('a', 10), additiveUnit('b', 10)], {
      kind: 'weighted_sum',
      weights: { a: 2, b: 1 },
    });
    // 分母 = 10*2 + 10*1 = 30；a 满分 20 ⇒ 20/30 ≈ .67 ⇒ partial
    const v = deriveCoarseVerdict(
      {
        status: 'completed',
        aggregate: {
          kind: 'points_total',
          points: 20,
          policy: { kind: 'weighted_sum', weights: { a: 2, b: 1 } },
        },
      },
      wb,
    );
    expect(v.maxPoints).toBe(30);
    expect(v.verdict).toBe('partial');
  });

  it('capped_sum：cap 封顶作分母', () => {
    const cb = basis([additiveUnit('a', 10), additiveUnit('b', 10)], {
      kind: 'capped_sum',
      cap: 15,
    });
    const v = deriveCoarseVerdict(
      {
        status: 'completed',
        aggregate: { kind: 'points_total', points: 15, policy: { kind: 'capped_sum', cap: 15 } },
      },
      cb,
    );
    expect(v.maxPoints).toBe(15);
    expect(v.verdict).toBe('correct');
  });
});

describe('ratingForVerdict（D14 三等级）', () => {
  it('correct→good / partial→hard / incorrect→again / unsupported→null', () => {
    expect(ratingForVerdict('correct')).toBe('good');
    expect(ratingForVerdict('partial')).toBe('hard');
    expect(ratingForVerdict('incorrect')).toBe('again');
    expect(ratingForVerdict('unsupported')).toBeNull();
  });
});

function matched(levelId: string) {
  return { matched: { level_id: levelId, option_ids: [] } };
}

describe('classifyScoredUnit（D13 证据分类）', () => {
  it('blank_marked_zero ⇒ uninformative（空白不当 failure 证据）', () => {
    const unit = additiveUnit('u', 4);
    const r = scored('u', 0, { scored_because: 'blank_marked_zero' });
    expect(classifyScoredUnit(unit, r).kind).toBe('uninformative');
  });

  it('pending ⇒ uninformative（未决不惩罚）', () => {
    const unit = additiveUnit('u', 4);
    const r: ScoringUnitResultT = {
      status: 'pending',
      scoring_unit_id: 'u',
      pending: { reason: 'infra_failure', retryable: true, detail: 'x' },
    } as ScoringUnitResultT;
    expect(classifyScoredUnit(unit, r).kind).toBe('uninformative');
  });

  it('additive：0 ⇒ zero；满 ⇒ full；中间 ⇒ partial；零分单元 ⇒ uninformative', () => {
    const unit = additiveUnit('u', 4);
    expect(classifyScoredUnit(unit, scored('u', 0)).kind).toBe('zero');
    expect(classifyScoredUnit(unit, scored('u', 4)).kind).toBe('full');
    expect(classifyScoredUnit(unit, scored('u', 2)).kind).toBe('partial');
    const freebie = additiveUnit('f', 0);
    expect(classifyScoredUnit(freebie, scored('f', 0)).kind).toBe('uninformative');
  });

  it('holistic：level_points 映射分档；纯档位按 rank', () => {
    const mapped = holisticUnit('h', { L0: 0, L1: 1, L2: 2 });
    expect(classifyScoredUnit(mapped, scored('h', null, matched('L2'))).kind).toBe('full');
    expect(classifyScoredUnit(mapped, scored('h', null, matched('L0'))).kind).toBe('zero');
    expect(classifyScoredUnit(mapped, scored('h', null, matched('L1'))).kind).toBe('partial');
    // 未映射档 ⇒ unmapped（不造证据）
    expect(classifyScoredUnit(mapped, scored('h', null, matched('LX'))).kind).toBe('unmapped');
    // 纯档位（无映射）按 rank
    const ordinal = holisticUnit('o');
    expect(classifyScoredUnit(ordinal, scored('o', null, matched('L2'))).kind).toBe('full');
    expect(classifyScoredUnit(ordinal, scored('o', null, matched('L1'))).kind).toBe('partial');
  });
});

describe('localizeKcObservations（D13 per-KC 局部证据）', () => {
  const locOf = (
    unitPartIds: Record<string, string[]>,
    partKcIds: Record<string, string[]>,
    groupKcIds: string[],
  ) => ({
    unitPartIds: new Map(Object.entries(unitPartIds).map(([k, v]) => [k, new Set(v)])),
    partKcIds: new Map(Object.entries(partKcIds)),
    groupKcIds,
  });

  it('单 KC 全对 ⇒ bit=1；全错 ⇒ bit=0；partial ⇒ abstain（partial→1 已 REJECTED）', () => {
    const b = basis([additiveUnit('u1', 4)]);
    const loc = locOf({ u1: ['p1'] }, { p1: ['kc_a'] }, ['kc_a']);
    const full = localizeKcObservations(b, [scored('u1', 4)], loc);
    expect(full).toEqual([{ kc_id: 'kc_a', bit: 1, basis: 'all_full' }]);
    const zero = localizeKcObservations(b, [scored('u1', 0)], loc);
    expect(zero).toEqual([{ kc_id: 'kc_a', bit: 0, basis: 'all_zero' }]);
    const partial = localizeKcObservations(b, [scored('u1', 2)], loc);
    expect(partial).toEqual([{ kc_id: 'kc_a', bit: 'abstain', basis: 'mixed_or_partial' }]);
  });

  it('两 KC 各自独立判定；跨单元混合 ⇒ 各自 abstain', () => {
    const b = basis([additiveUnit('u1', 4), additiveUnit('u2', 4)]);
    const loc = locOf({ u1: ['p1'], u2: ['p2'] }, { p1: ['kc_a'], p2: ['kc_b'] }, ['kc_a', 'kc_b']);
    const obs = localizeKcObservations(b, [scored('u1', 4), scored('u2', 0)], loc);
    expect(obs).toEqual([
      { kc_id: 'kc_a', bit: 1, basis: 'all_full' },
      { kc_id: 'kc_a'.replace('a', 'b'), bit: 0, basis: 'all_zero' },
    ]);
    const mixed = localizeKcObservations(b, [scored('u1', 4), scored('u2', 2)], loc);
    expect(mixed[0]).toEqual({ kc_id: 'kc_a', bit: 1, basis: 'all_full' });
    expect(mixed[1]).toEqual({ kc_id: 'kc_b', bit: 'abstain', basis: 'mixed_or_partial' });
  });

  it('共享单元（无槽引用）证据归组级 KC：一单元混合两 KC ⇒ 两 KC 同票', () => {
    const b = basis([{ ...additiveUnit('u1', 4), slot_refs: [] }]);
    const loc = locOf({ u1: [] }, {}, ['kc_a', 'kc_b']);
    const obs = localizeKcObservations(b, [scored('u1', 4)], loc);
    expect(obs).toEqual([
      { kc_id: 'kc_a', bit: 1, basis: 'all_full' },
      { kc_id: 'kc_b', bit: 1, basis: 'all_full' },
    ]);
  });

  it('blank_marked_zero 不产生票 ⇒ no_supported_evidence（不是 all-KC failure）', () => {
    const b = basis([additiveUnit('u1', 4)]);
    const loc = locOf({ u1: ['p1'] }, { p1: ['kc_a'] }, ['kc_a']);
    const obs = localizeKcObservations(
      b,
      [scored('u1', 0, { scored_because: 'blank_marked_zero' })],
      loc,
    );
    expect(obs).toEqual([{ kc_id: 'kc_a', bit: 'abstain', basis: 'no_supported_evidence' }]);
  });

  it('YUK-1093 P1-4：evidence_slot_refs-only 单元按证据槽所属 part 的 KC 计，不落组级', () => {
    // 单元无 slot_refs（判据不直对作答槽），只有 evidence_slot_refs → part p1
    // （kc_a）。buggy：slot_refs 空 ⇒ 组级 ⇒ 票打到 kc_b 上。
    const unit: ScoringUnitT = {
      ...additiveUnit('u_ev', 4),
      slot_refs: [],
      evidence_slot_refs: ['ev_slot_1'],
    };
    const b = basis([unit]);
    const loc = locOf({ u_ev: ['p1'] }, { p1: ['kc_a'] }, ['kc_a', 'kc_b']);
    const obs = localizeKcObservations(b, [scored('u_ev', 4)], loc);
    expect(obs).toEqual([
      { kc_id: 'kc_a', bit: 1, basis: 'all_full' },
      { kc_id: 'kc_b', bit: 'abstain', basis: 'no_supported_evidence' },
    ]);
  });

  it('YUK-1093 P1-4 对偶：slot_refs + evidence_slot_refs 双空仍归组级', () => {
    const unit: ScoringUnitT = {
      ...additiveUnit('u_grp', 4),
      slot_refs: [],
      evidence_slot_refs: [],
    };
    const b = basis([unit]);
    const loc = locOf({ u_grp: [] }, {}, ['kc_a', 'kc_b']);
    const obs = localizeKcObservations(b, [scored('u_grp', 4)], loc);
    expect(obs).toEqual([
      { kc_id: 'kc_a', bit: 1, basis: 'all_full' },
      { kc_id: 'kc_b', bit: 1, basis: 'all_full' },
    ]);
  });

  it('每 KC ≤1 obs：同一 KC 的多单元证据聚合成一条', () => {
    const b = basis([additiveUnit('u1', 4), additiveUnit('u2', 4)]);
    const loc = locOf({ u1: ['p1'], u2: ['p1'] }, { p1: ['kc_a'] }, ['kc_a']);
    const obs = localizeKcObservations(b, [scored('u1', 4), scored('u2', 4)], loc);
    expect(obs).toHaveLength(1);
    expect(obs[0].bit).toBe(1);
  });
});

describe('resolveThetaDecision（bounded evidence adapter）', () => {
  const auto = { source: 'automatic' as const, assisted: false };

  it('uniform 非 abstain 位 ⇒ 恰好一次共享 update（按 id 排序）', () => {
    const d = resolveThetaDecision(
      [
        { kc_id: 'kc_b', bit: 1, basis: 'all_full' },
        { kc_id: 'kc_a', bit: 1, basis: 'all_full' },
        { kc_id: 'kc_c', bit: 'abstain', basis: 'no_supported_evidence' },
      ],
      auto,
    );
    expect(d).toEqual({ kind: 'update', outcome: 1, knowledgeIds: ['kc_a', 'kc_b'] });
  });

  it('mixed 位 ⇒ abstain(mixed_kc_bits)：one-bit updater 表达不了，也不能按 KC 重调', () => {
    const d = resolveThetaDecision(
      [
        { kc_id: 'kc_a', bit: 1, basis: 'all_full' },
        { kc_id: 'kc_b', bit: 0, basis: 'all_zero' },
      ],
      auto,
    );
    expect(d).toEqual({ kind: 'abstain', reason: 'mixed_kc_bits' });
  });

  it('全 abstain / 无 KC ⇒ abstain(no_kc_evidence)', () => {
    expect(resolveThetaDecision([], auto)).toEqual({ kind: 'abstain', reason: 'no_kc_evidence' });
    expect(
      resolveThetaDecision([{ kc_id: 'a', bit: 'abstain', basis: 'mixed_or_partial' }], auto),
    ).toEqual({ kind: 'abstain', reason: 'no_kc_evidence' });
  });

  it('D15/D16：manual/self_report/assisted ⇒ provenance_excluded（无 self-report θ̂；assisted 排除 hard mastery）', () => {
    const obs = [{ kc_id: 'a', bit: 1 as const, basis: 'all_full' as const }];
    for (const p of [
      { source: 'manual' as const, assisted: false },
      { source: 'self_report' as const, assisted: false },
      { source: 'automatic' as const, assisted: true },
      { source: 'manual' as const, assisted: true },
    ]) {
      expect(resolveThetaDecision(obs, p)).toEqual({
        kind: 'abstain',
        reason: 'provenance_excluded',
      });
    }
  });
});

describe('aggregateMaxPoints', () => {
  it('threshold_levels 分母 = 最高档阈值', () => {
    const b = basis([additiveUnit('a', 10)], {
      kind: 'threshold_levels',
      thresholds: [{ level_id: 'L', min_points: 7 }],
    });
    expect(aggregateMaxPoints(b)).toBe(7);
  });
});
