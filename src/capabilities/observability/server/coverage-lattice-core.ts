// Pure coverage-lattice core with no DB imports, so it can run in the unit lane. The
// read model imports these same functions and injects the three constants.
//
// The scanner's four rules are pool-level; this never produces a per-cell matrix. Pool
// booleans are read back from which gap kinds fired, and an empty pool leaves the three
// axes null because the scanner short-circuits.

import type {
  DifficultyBand,
  QuestionSupplyTarget,
  ScanInput,
  SupplyGapKind,
  SupplyRoute,
} from '@/capabilities/practice/public';

const DAY_MS = 24 * 60 * 60 * 1000;

export const COVERAGE_SCOPE_NOTE =
  'covers the four single-KC pool rules of scanCoverageGaps (R1-R4); ' +
  'NOT the full union of supply gaps — confusable_contrast (misconception mesh) is out of scope.';

/** Injected so the core never imports DB-tainted value modules. */
export interface LatticeConstants {
  coverageDepthThreshold: number;
  nearWindow: number;
  cooldownDays: number;
}

/** Recent supply activity per gap, derived from fingerprints. */
export interface GapActivity {
  lastActivityAt: string | null;
  lastStatus: string | null;
  lastDispatchedAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
}

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
  /** frontier_zero uses fixed scaffolding constants; the UI greys it as not scanned. */
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

/** Minimal supply-event projection for fingerprint aggregation. */
export interface SupplyActivityEvent {
  fingerprint: string;
  status: string;
  createdAt: Date;
}

/**
 * Aggregate by fingerprint: last activity and status from the newest event; cooldown
 * only from the newest dispatched event, because that is the cooldown credential.
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
    const latest = list.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
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

export interface BuildLatticeOptions {
  now?: Date;
  scanMs?: number;
  displayNameById?: Record<string, string | null>;
}

/**
 * Pure transform from scan input, targets, activity and constants to the read model.
 * Pool booleans are derived from gap kinds; usable counts use the scanner's own
 * question-to-KC bucketing.
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

  // A question with several KCs counts in each bucket, matching the scanner.
  const usableCountByKid = new Map<string, number>();
  for (const q of scanInput.questions) {
    for (const kid of q.knowledgeIds) {
      usableCountByKid.set(kid, (usableCountByKid.get(kid) ?? 0) + 1);
    }
  }

  // Scanner targets always carry exactly one KC.
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

  // The frontier is the authoritative active-goal set; fully covered KCs still get a row.
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
      scaffold: t.gapKind === 'frontier_zero',
      lastActivity: activityByFingerprint.get(t.fingerprint) ?? null,
    }));

    if (gaps.length > 0) {
      kcsWithGaps += 1;
      totalGaps += gaps.length;
      for (const g of gaps) gapsByKind[g.gapKind] = (gapsByKind[g.gapKind] ?? 0) + 1;
    }

    // An empty pool short-circuits the scanner, so those axes are unassessed (null).
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
