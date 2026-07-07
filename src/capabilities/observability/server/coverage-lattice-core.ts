// YUK-579 — 覆盖细目表**纯函数核**（零 DB import，故可进 unit 分区，镜像 effectiveness-trend-
// summary.ts「本模块零 DB import」先例）。读模型 coverage-lattice.ts 从这里 import 同一套纯函数
// + 常量注入——单一真相，无漂移。
//
// 只 type-only import target-discovery（运行期擦除，绝不拉进 @/db/client 的 throw-on-missing-
// DATABASE_URL 链）；三个常量（depth threshold / near window / cooldown days）**注入**而非 import
// value，使本模块可在无 DB 的 unit 分区直接测。
//
// 诚实约束（design §2）：scanCoverageGaps 四规则全 KC 池级，**绝不产逐格覆盖矩阵**。池级布尔从
// 哪些 gapKind 触发**反读**（§2.1 免漂移等价），零池 KC 三轴 null（扫描器短路，target-discovery.ts:401）。

import type {
  DifficultyBand,
  QuestionSupplyTarget,
  ScanInput,
  SupplyGapKind,
  SupplyRoute,
} from '@/server/question-supply/target-discovery';

const DAY_MS = 24 * 60 * 60 * 1000;

export const COVERAGE_SCOPE_NOTE =
  'covers the four single-KC pool rules of scanCoverageGaps (R1-R4); ' +
  'NOT the full union of supply gaps — confusable_contrast (misconception mesh) is out of scope.';

/** 注入常量（避免 core 运行期 import DB-tainted 模块拿 value）。 */
export interface LatticeConstants {
  coverageDepthThreshold: number;
  nearWindow: number;
  cooldownDays: number;
}

// ── 输出契约（design §2.5）───────────────────────────────────────────────────

/** 一个缺口的最近供给活动注记（MF1：从 fingerprint 聚合派生，纯只读）。 */
export interface GapActivity {
  lastActivityAt: string | null;
  lastStatus: string | null;
  lastDispatchedAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
}

/** 一条 emitted 缺口 target 的细目行（+ 活动注记）。 */
export interface LatticeGap {
  gapKind: SupplyGapKind;
  kind: string;
  difficultyBand: DifficultyBand;
  minSourceTier: 1 | 2 | 3;
  desiredCount: number;
  priority: number;
  reason: string;
  fingerprint: string;
  routePreference: SupplyRoute[];
  /** MF3：frontier_zero 的 kind/band/tier 是硬编脚手架常量 → UI 置灰标「not scanned」。 */
  scaffold: boolean;
  lastActivity: GapActivity | null;
}

/** 一个 active-goal KC 的池级覆盖行（Zone A）。 */
export interface KcCoverageRow {
  knowledgeId: string;
  thetaHat: number;
  evidenceCount: number;
  usableCount: number;
  depthMet: boolean;
  hasHighTier: boolean | null;
  hasNearThetaAnchor: boolean | null;
  formatDiverse: boolean | null;
  gapKinds: SupplyGapKind[];
  gaps: LatticeGap[];
}

export interface SubjectCoverage {
  subjectId: string;
  displayName: string | null;
  kcs: KcCoverageRow[];
}

export interface CoverageLatticeRead {
  generated_at: string;
  scan_ms: number;
  coverage_depth_threshold: number;
  near_window: number;
  cooldown_days: number;
  scope_note: string;
  subjects: SubjectCoverage[];
  totals: {
    activeKcs: number;
    kcsWithGaps: number;
    totalGaps: number;
    gapsByKind: Record<string, number>;
  };
}

// ── 纯函数 1：活动事件聚合（MF1，单测靶）─────────────────────────────────────

/** 一条 experimental:question_supply 事件的最小投影（fingerprint 聚合用）。 */
export interface SupplyActivityEvent {
  fingerprint: string;
  status: string;
  createdAt: Date;
}

/**
 * MF1：按 fingerprint 聚合供给活动。lastActivity/lastStatus = 每 fingerprint 最新一条（任意
 * status）；inCooldown/cooldownUntil **只**从最近 status='dispatched' 事件算（cooldown 凭证 =
 * dispatched 行，dispatcher.ts:331-333）。纯函数：now / cooldownDays 注入以可测。
 */
export function aggregateSupplyActivity(
  events: SupplyActivityEvent[],
  now: Date,
  cooldownDays: number,
): Map<string, GapActivity> {
  const byFingerprint = new Map<string, SupplyActivityEvent[]>();
  for (const e of events) {
    if (!e.fingerprint) continue;
    const list = byFingerprint.get(e.fingerprint) ?? [];
    list.push(e);
    byFingerprint.set(e.fingerprint, list);
  }

  const out = new Map<string, GapActivity>();
  const cooldownMs = cooldownDays * DAY_MS;
  for (const [fingerprint, list] of byFingerprint) {
    // 最新一条（任意 status）。
    const latest = list.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
    // 最近 status='dispatched'（cooldown 凭证）。
    const dispatched = list.filter((e) => e.status === 'dispatched');
    const lastDispatched =
      dispatched.length > 0
        ? dispatched.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
        : null;
    const cooldownUntilMs = lastDispatched ? lastDispatched.createdAt.getTime() + cooldownMs : null;
    const inCooldown = cooldownUntilMs !== null && cooldownUntilMs > now.getTime();
    out.set(fingerprint, {
      lastActivityAt: latest.createdAt.toISOString(),
      lastStatus: latest.status,
      lastDispatchedAt: lastDispatched ? lastDispatched.createdAt.toISOString() : null,
      inCooldown,
      cooldownUntil: cooldownUntilMs !== null ? new Date(cooldownUntilMs).toISOString() : null,
    });
  }
  return out;
}

// ── 纯函数 2：覆盖点阵变换（design §2，单测靶）───────────────────────────────

export interface BuildLatticeOptions {
  now?: Date;
  scanMs?: number;
  /** subjectId → displayName（registry 派生；测试可注入）。 */
  displayNameById?: Record<string, string | null>;
}

/**
 * 纯变换：(ScanInput, targets, activityByFingerprint, constants) → CoverageLatticeRead。无 IO。
 *
 * 池级布尔从 gapKind 反读（design §2.1，零漂移）；零池 KC 三轴 null。usableCount 单源于扫描器
 * 同一 questionsByKid 分桶（should#2）。
 */
export function buildCoverageLattice(
  scanInput: ScanInput,
  targets: QuestionSupplyTarget[],
  activityByFingerprint: Map<string, GapActivity>,
  constants: LatticeConstants,
  opts: BuildLatticeOptions = {},
): CoverageLatticeRead {
  const now = opts.now ?? new Date();
  const displayNameById = opts.displayNameById ?? {};

  // 现有题按 KC 分桶（镜像 scanCoverageGaps target-discovery.ts:328-335：一题挂多 KC → 每桶收）。
  const usableCountByKid = new Map<string, number>();
  for (const q of scanInput.questions) {
    for (const kid of q.knowledgeIds) {
      usableCountByKid.set(kid, (usableCountByKid.get(kid) ?? 0) + 1);
    }
  }

  // targets 按 KC 分组（scanCoverageGaps 的 target.knowledgeIds 恒单元素 [f.knowledgeId]）。
  const targetsByKid = new Map<string, QuestionSupplyTarget[]>();
  for (const t of targets) {
    const kid = t.knowledgeIds[0];
    if (kid === undefined) continue;
    const list = targetsByKid.get(kid) ?? [];
    list.push(t);
    targetsByKid.set(kid, list);
  }

  const gapsByKind: Record<string, number> = {};
  let totalGaps = 0;
  let kcsWithGaps = 0;

  // 按 subjectId → KC 分组（frontier 是权威 active-goal KC 集，满覆盖 KC 亦成行）。
  const rowsBySubject = new Map<string, KcCoverageRow[]>();
  for (const f of scanInput.frontier) {
    const usableCount = usableCountByKid.get(f.knowledgeId) ?? 0;
    const kcTargets = targetsByKid.get(f.knowledgeId) ?? [];
    const gapKindSet = new Set<SupplyGapKind>(kcTargets.map((t) => t.gapKind));

    const gaps: LatticeGap[] = kcTargets.map((t) => ({
      gapKind: t.gapKind,
      kind: t.kind,
      difficultyBand: t.difficultyBand,
      minSourceTier: t.minSourceTier,
      desiredCount: t.desiredCount,
      priority: t.priority,
      reason: t.reason,
      fingerprint: t.fingerprint,
      routePreference: t.routePreference,
      // MF3：frontier_zero 坐标是硬编脚手架常量，非扫描依据 → 置灰标记。
      scaffold: t.gapKind === 'frontier_zero',
      lastActivity: activityByFingerprint.get(t.fingerprint) ?? null,
    }));

    if (gaps.length > 0) {
      kcsWithGaps += 1;
      totalGaps += gaps.length;
      for (const g of gaps) gapsByKind[g.gapKind] = (gapsByKind[g.gapKind] ?? 0) + 1;
    }

    // 池级布尔从 gapKind 反读（§2.1）；零池 KC 扫描器短路 R2/R3/R4 → null 未评估。
    const emptyPool = usableCount === 0;
    const row: KcCoverageRow = {
      knowledgeId: f.knowledgeId,
      thetaHat: f.thetaHat,
      evidenceCount: f.evidenceCount,
      usableCount,
      depthMet: usableCount >= constants.coverageDepthThreshold,
      hasHighTier: emptyPool ? null : !gapKindSet.has('source_quality'),
      hasNearThetaAnchor: emptyPool ? null : !gapKindSet.has('diagnostic'),
      formatDiverse: emptyPool ? null : !gapKindSet.has('format_diversity'),
      gapKinds: [...gapKindSet],
      gaps,
    };
    const list = rowsBySubject.get(f.subjectId) ?? [];
    list.push(row);
    rowsBySubject.set(f.subjectId, list);
  }

  // KC 排序：有缺口者优先（按最高缺口 priority 降序），满覆盖者随后（按 knowledgeId）。
  const maxPriority = (r: KcCoverageRow) =>
    r.gaps.reduce((m, g) => Math.max(m, g.priority), Number.NEGATIVE_INFINITY);
  const sortRows = (rows: KcCoverageRow[]) =>
    [...rows].sort((a, b) => {
      const aHas = a.gaps.length > 0;
      const bHas = b.gaps.length > 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && bHas) {
        const d = maxPriority(b) - maxPriority(a);
        if (d !== 0) return d;
      }
      return a.knowledgeId.localeCompare(b.knowledgeId);
    });

  const subjects: SubjectCoverage[] = [...rowsBySubject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subjectId, rows]) => ({
      subjectId,
      displayName: displayNameById[subjectId] ?? null,
      kcs: sortRows(rows),
    }));

  return {
    generated_at: now.toISOString(),
    scan_ms: opts.scanMs ?? 0,
    coverage_depth_threshold: constants.coverageDepthThreshold,
    near_window: constants.nearWindow,
    cooldown_days: constants.cooldownDays,
    scope_note: COVERAGE_SCOPE_NOTE,
    subjects,
    totals: {
      activeKcs: scanInput.frontier.length,
      kcsWithGaps,
      totalGaps,
      gapsByKind,
    },
  };
}
