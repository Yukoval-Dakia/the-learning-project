// YUK-579 — 覆盖细目表纯函数核单测（无 DB；只 import ./coverage-lattice-core，其对 target-
// discovery 仅 type-only import → 运行期擦除 → 不拉 @/db/client 的 throw-on-missing-DATABASE_URL 链）。
//
// 断言（design + 面板 mustFix/should）：
//   should#2 一致性：depthMet ⟺ usableCount ≥ threshold ⟺ frontier_zero 缺席；usableCount===0
//     ⟺ 三轴皆 null（零池未评估）。
//   §2.1 免漂移：池级布尔从 gapKind 反读（source_quality→!hasHighTier / diagnostic→!hasNearTheta
//     / format_diversity→!formatDiverse）。
//   MF3：frontier_zero gap → scaffold=true；其它 → false。
//   MF1：aggregateSupplyActivity —— lastActivity/lastStatus 取最新任意 status；inCooldown/
//     cooldownUntil 只从最近 status='dispatched' 算（无 dispatched → false/null）。

import type {
  DifficultyBand,
  FrontierKnowledgeInput,
  PoolQuestion,
  QuestionSupplyTarget,
  ScanInput,
  SupplyGapKind,
} from '@/server/question-supply/target-discovery';
import { describe, expect, it } from 'vitest';
import {
  type LatticeConstants,
  type SupplyActivityEvent,
  aggregateSupplyActivity,
  buildCoverageLattice,
} from './coverage-lattice-core';

const CONSTS: LatticeConstants = { coverageDepthThreshold: 2, nearWindow: 0.75, cooldownDays: 7 };

function mkFrontier(
  knowledgeId: string,
  subjectId: string,
  thetaHat: number,
  evidenceCount: number,
): FrontierKnowledgeInput {
  return { knowledgeId, subjectId, thetaHat, thetaPrecision: 1, evidenceCount };
}

function mkQ(id: string, knowledgeIds: string[]): PoolQuestion {
  return {
    id,
    kind: 'choice',
    source: 'manual',
    metadata: null,
    difficulty: 3,
    calibrationB: null,
    knowledgeIds,
  };
}

function mkTarget(
  knowledgeId: string,
  subjectId: string,
  gapKind: SupplyGapKind,
  opts: {
    kind?: string;
    difficultyBand?: DifficultyBand;
    minSourceTier?: 1 | 2 | 3;
    priority?: number;
    fingerprint?: string;
  } = {},
): QuestionSupplyTarget {
  return {
    id: `t_${knowledgeId}_${gapKind}`,
    fingerprint: opts.fingerprint ?? `fp_${knowledgeId}_${gapKind}`,
    gapKind,
    subjectId,
    knowledgeIds: [knowledgeId],
    kind: opts.kind ?? 'any',
    difficultyBand: opts.difficultyBand ?? 'near',
    desiredCount: 1,
    minSourceTier: opts.minSourceTier ?? 2,
    routePreference: [],
    priority: opts.priority ?? 0.5,
    reason: `${gapKind} for ${knowledgeId}`,
    constraints: {},
  };
}

// 四个 KC：空池 / thin(1题) / 满覆盖(2题) / 多题(3题，仅题型缺口)。
function fixture(): { scanInput: ScanInput; targets: QuestionSupplyTarget[] } {
  const scanInput: ScanInput = {
    frontier: [
      mkFrontier('kn_empty', 'wenyan', 0, 0),
      mkFrontier('kn_thin', 'wenyan', 0.5, 3),
      mkFrontier('kn_good', 'wenyan', 0.2, 10),
      mkFrontier('kn_math', 'math', -0.3, 2),
    ],
    questions: [
      mkQ('q1', ['kn_thin']),
      mkQ('q2', ['kn_good']),
      mkQ('q3', ['kn_good']),
      mkQ('q4', ['kn_math']),
      mkQ('q5', ['kn_math']),
      mkQ('q6', ['kn_math']),
    ],
    routePreferenceBySubject: {},
  };
  const targets: QuestionSupplyTarget[] = [
    // 空池：仅 frontier_zero（scanner 短路），desiredCount=2 语义上但此处用默认 1 无碍断言。
    mkTarget('kn_empty', 'wenyan', 'frontier_zero', { priority: 1.0 }),
    // thin：frontier_zero + source_quality + diagnostic（usableCount 1，轴已评估）。
    mkTarget('kn_thin', 'wenyan', 'frontier_zero', { priority: 1.0 }),
    mkTarget('kn_thin', 'wenyan', 'source_quality', { priority: 0.5 }),
    mkTarget('kn_thin', 'wenyan', 'diagnostic', { priority: 0.7 }),
    // kn_good：无缺口（满覆盖）。
    // kn_math：仅 format_diversity。
    mkTarget('kn_math', 'math', 'format_diversity', { kind: 'short_answer', priority: 0.4 }),
  ];
  return { scanInput, targets };
}

describe('buildCoverageLattice (YUK-579 read model core)', () => {
  const { scanInput, targets } = fixture();
  const read = buildCoverageLattice(scanInput, targets, new Map(), CONSTS, {
    now: new Date('2026-07-07T00:00:00Z'),
    scanMs: 123,
  });
  const rows = read.subjects.flatMap((s) => s.kcs);
  const byKid = new Map(rows.map((r) => [r.knowledgeId, r]));

  it('empty-pool KC: three axes null (未评估), depthMet false, frontier_zero scaffold', () => {
    const r = byKid.get('kn_empty');
    expect(r).toBeDefined();
    expect(r?.usableCount).toBe(0);
    expect(r?.depthMet).toBe(false);
    expect(r?.hasHighTier).toBeNull();
    expect(r?.hasNearThetaAnchor).toBeNull();
    expect(r?.formatDiverse).toBeNull();
    expect(r?.gapKinds).toEqual(['frontier_zero']);
    expect(r?.gaps[0]?.scaffold).toBe(true);
  });

  it('thin KC (1<threshold): booleans read off gapKind, non-null (pool evaluated)', () => {
    const r = byKid.get('kn_thin');
    expect(r?.usableCount).toBe(1);
    expect(r?.depthMet).toBe(false);
    expect(r?.hasHighTier).toBe(false); // source_quality present
    expect(r?.hasNearThetaAnchor).toBe(false); // diagnostic present
    expect(r?.formatDiverse).toBe(true); // no format_diversity gap
    expect(r?.gaps).toHaveLength(3);
    // MF3: only frontier_zero is scaffold.
    const scaffoldKinds = r?.gaps.filter((g) => g.scaffold).map((g) => g.gapKind);
    expect(scaffoldKinds).toEqual(['frontier_zero']);
  });

  it('fully-covered KC: all axes true, no gaps', () => {
    const r = byKid.get('kn_good');
    expect(r?.usableCount).toBe(2);
    expect(r?.depthMet).toBe(true);
    expect(r?.hasHighTier).toBe(true);
    expect(r?.hasNearThetaAnchor).toBe(true);
    expect(r?.formatDiverse).toBe(true);
    expect(r?.gaps).toHaveLength(0);
  });

  it('multi-question KC with only format gap', () => {
    const r = byKid.get('kn_math');
    expect(r?.usableCount).toBe(3);
    expect(r?.depthMet).toBe(true);
    expect(r?.hasHighTier).toBe(true);
    expect(r?.hasNearThetaAnchor).toBe(true);
    expect(r?.formatDiverse).toBe(false);
    expect(r?.gaps).toHaveLength(1);
    expect(r?.gaps[0]?.scaffold).toBe(false);
  });

  it('should#2 consistency invariants hold for every row', () => {
    for (const r of rows) {
      // depthMet ⟺ usableCount ≥ threshold ⟺ frontier_zero 缺席
      expect(r.depthMet).toBe(r.usableCount >= CONSTS.coverageDepthThreshold);
      expect(r.depthMet).toBe(!r.gapKinds.includes('frontier_zero'));
      // usableCount===0 ⟺ 三轴皆 null
      const allNull =
        r.hasHighTier === null && r.hasNearThetaAnchor === null && r.formatDiverse === null;
      expect(allNull).toBe(r.usableCount === 0);
    }
  });

  it('totals + gapsByKind', () => {
    expect(read.totals.activeKcs).toBe(4);
    expect(read.totals.kcsWithGaps).toBe(3); // empty, thin, math
    expect(read.totals.totalGaps).toBe(5);
    expect(read.totals.gapsByKind).toEqual({
      frontier_zero: 2,
      source_quality: 1,
      diagnostic: 1,
      format_diversity: 1,
    });
  });

  it('grouped by subject (sorted) with gaps-first KC ordering', () => {
    expect(read.subjects.map((s) => s.subjectId)).toEqual(['math', 'wenyan']);
    const wenyan = read.subjects.find((s) => s.subjectId === 'wenyan');
    // gaps-first by max priority (empty & thin both p1.0 → tie → knowledgeId), covered (kn_good) last.
    expect(wenyan?.kcs.map((k) => k.knowledgeId)).toEqual(['kn_empty', 'kn_thin', 'kn_good']);
  });

  it('discloses injected constants + scope note + scan_ms (should#1/#6)', () => {
    expect(read.coverage_depth_threshold).toBe(2);
    expect(read.near_window).toBe(0.75);
    expect(read.cooldown_days).toBe(7);
    expect(read.scan_ms).toBe(123);
    expect(read.scope_note).toContain('scanCoverageGaps');
    expect(read.scope_note).toContain('confusable_contrast');
  });

  it('joins activity by fingerprint (present → set, absent → null)', () => {
    const activity = new Map([
      [
        'fp_kn_thin_source_quality',
        {
          lastActivityAt: '2026-07-04T00:00:00.000Z',
          lastStatus: 'dispatched',
          lastDispatchedAt: '2026-07-04T00:00:00.000Z',
          inCooldown: true,
          cooldownUntil: '2026-07-11T00:00:00.000Z',
        },
      ],
    ]);
    const r2 = buildCoverageLattice(scanInput, targets, activity, CONSTS);
    const thin = r2.subjects.flatMap((s) => s.kcs).find((k) => k.knowledgeId === 'kn_thin');
    const sq = thin?.gaps.find((g) => g.gapKind === 'source_quality');
    const fz = thin?.gaps.find((g) => g.gapKind === 'frontier_zero');
    expect(sq?.lastActivity?.inCooldown).toBe(true);
    expect(fz?.lastActivity).toBeNull(); // no activity row for this fingerprint
  });
});

describe('aggregateSupplyActivity (YUK-579 MF1)', () => {
  const now = new Date('2026-07-10T00:00:00Z');

  it('lastActivity/lastStatus = latest (any status); cooldown only from dispatched', () => {
    const events: SupplyActivityEvent[] = [
      { fingerprint: 'fp1', status: 'manual', createdAt: new Date('2026-07-05T00:00:00Z') },
      { fingerprint: 'fp1', status: 'dispatched', createdAt: new Date('2026-07-06T00:00:00Z') },
      { fingerprint: 'fp1', status: 'skipped', createdAt: new Date('2026-07-08T00:00:00Z') },
    ];
    const m = aggregateSupplyActivity(events, now, 7);
    const a = m.get('fp1');
    expect(a?.lastStatus).toBe('skipped'); // latest any-status
    expect(a?.lastActivityAt).toBe('2026-07-08T00:00:00.000Z');
    expect(a?.lastDispatchedAt).toBe('2026-07-06T00:00:00.000Z'); // dispatched only
    // cooldownUntil = dispatched(07-06) + 7d = 07-13 > now(07-10) → inCooldown
    expect(a?.inCooldown).toBe(true);
    expect(a?.cooldownUntil).toBe('2026-07-13T00:00:00.000Z');
  });

  it('no dispatched event → lastDispatchedAt null, inCooldown false', () => {
    const events: SupplyActivityEvent[] = [
      { fingerprint: 'fp2', status: 'manual', createdAt: new Date('2026-07-09T00:00:00Z') },
      { fingerprint: 'fp2', status: 'skipped', createdAt: new Date('2026-07-09T12:00:00Z') },
    ];
    const a = aggregateSupplyActivity(events, now, 7).get('fp2');
    expect(a?.lastStatus).toBe('skipped');
    expect(a?.lastDispatchedAt).toBeNull();
    expect(a?.inCooldown).toBe(false);
    expect(a?.cooldownUntil).toBeNull();
  });

  it('dispatched outside cooldown window → inCooldown false but cooldownUntil (past) set', () => {
    const events: SupplyActivityEvent[] = [
      { fingerprint: 'fp3', status: 'dispatched', createdAt: new Date('2026-06-25T00:00:00Z') },
    ];
    const a = aggregateSupplyActivity(events, now, 7).get('fp3');
    // 06-25 + 7d = 07-02 < now(07-10) → elapsed
    expect(a?.inCooldown).toBe(false);
    expect(a?.cooldownUntil).toBe('2026-07-02T00:00:00.000Z');
    expect(a?.lastDispatchedAt).toBe('2026-06-25T00:00:00.000Z');
  });
});
