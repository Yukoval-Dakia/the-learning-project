// Read-only coverage lattice. Practice still owns the supply scanner and installs
// its facts; this module cannot import a capability. Pool booleans are read back
// from which gap kinds fired. An empty pool leaves the three axes null because
// the scanner short-circuits those rules.

import { and, asc, eq, gte } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getDefaultSubjectRegistry } from '@/subjects/profile';

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPLY_EVENT_ACTION = 'experimental:question_supply';
const ACTIVITY_LOOKBACK_FLOOR_DAYS = 30;

const COVERAGE_SCOPE_NOTE =
  'covers the four single-KC pool rules of scanCoverageGaps (R1-R4); ' +
  'NOT the full union of supply gaps — confusable_contrast (misconception mesh) is out of scope.';

export type CoverageGapKind =
  | 'frontier_zero'
  | 'source_quality'
  | 'diagnostic'
  | 'format_diversity'
  | 'placement_starter'
  | 'confusable_contrast';

export type DifficultyBand = 'below' | 'near' | 'above' | 'stretch';

export type CoverageSupplyRoute =
  | 'author_question'
  | 'sourcing_web'
  | 'ingest_existing'
  | 'image_candidate'
  | 'quiz_gen'
  | 'jyeoo_fetch';

/** Open-goal KC row the scanner already loaded. */
export interface CoverageScanFrontier {
  knowledgeId: string;
  subjectId: string;
  thetaHat: number;
  evidenceCount: number;
}

/** Usable question, counted once per attached KC. */
export interface CoverageScanQuestion {
  knowledgeIds: readonly string[];
}

/** One emitted gap. Scanner targets carry exactly one KC. */
export interface CoverageScanTarget {
  knowledgeIds: readonly string[];
  gapKind: CoverageGapKind;
  kind: string;
  difficultyBand: DifficultyBand;
  minSourceTier: 1 | 2 | 3;
  desiredCount: number;
  priority: number;
  reason: string;
  fingerprint: string;
  routePreference: readonly CoverageSupplyRoute[];
}

/**
 * Practice-owned scan facts. `assembleMs` is only the DB assemble, not the
 * pure scan, so the displayed scan_ms stays the previous clock.
 */
export interface CoverageScanFacts {
  frontier: readonly CoverageScanFrontier[];
  questions: readonly CoverageScanQuestion[];
  targets: readonly CoverageScanTarget[];
  coverageDepthThreshold: number;
  nearWindow: number;
  cooldownDays: number;
  assembleMs: number;
}

export type ReadCoverageScan = (db: Db | Tx) => Promise<CoverageScanFacts>;

/** Recent supply activity per gap, derived from fingerprints. */
export interface GapActivity {
  lastActivityAt: string | null;
  lastStatus: string | null;
  lastDispatchedAt: string | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
}

export interface LatticeGap {
  gapKind: CoverageGapKind;
  kind: string;
  difficultyBand: DifficultyBand;
  minSourceTier: 1 | 2 | 3;
  desiredCount: number;
  priority: number;
  reason: string;
  fingerprint: string;
  routePreference: readonly CoverageSupplyRoute[];
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
  gapKinds: CoverageGapKind[];
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

interface SupplyActivityEvent {
  fingerprint: string;
  status: string;
  createdAt: Date;
}

let readScan: ReadCoverageScan | undefined;

export function installCoverageScanReader(reader: ReadCoverageScan): void {
  readScan = reader;
}

/**
 * Aggregate by fingerprint: last activity and status from the newest event; cooldown
 * only from the newest dispatched event, because that is the cooldown credential.
 */
function aggregateSupplyActivity(
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

function buildCoverageLattice(
  facts: CoverageScanFacts,
  activityByFingerprint: Map<string, GapActivity>,
  now: Date,
  displayNameById: Record<string, string | null>,
): CoverageLatticeRead {
  const usableCountByKid = new Map<string, number>();
  for (const q of facts.questions) {
    for (const kid of q.knowledgeIds) {
      usableCountByKid.set(kid, (usableCountByKid.get(kid) ?? 0) + 1);
    }
  }

  const targetsByKid = new Map<string, CoverageScanTarget[]>();
  for (const t of facts.targets) {
    const kid = t.knowledgeIds[0];
    if (kid === undefined) continue;
    const list = targetsByKid.get(kid) ?? [];
    list.push(t);
    targetsByKid.set(kid, list);
  }

  const gapsByKind: Record<string, number> = {};
  let totalGaps = 0;
  let kcsWithGaps = 0;

  const rowsBySubject = new Map<string, KcCoverageRow[]>();
  for (const f of facts.frontier) {
    const usableCount = usableCountByKid.get(f.knowledgeId) ?? 0;
    const kcTargets = targetsByKid.get(f.knowledgeId) ?? [];
    const gapKindSet = new Set<CoverageGapKind>(kcTargets.map((t) => t.gapKind));

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

    const emptyPool = usableCount === 0;
    const row: KcCoverageRow = {
      knowledgeId: f.knowledgeId,
      thetaHat: f.thetaHat,
      evidenceCount: f.evidenceCount,
      usableCount,
      depthMet: usableCount >= facts.coverageDepthThreshold,
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
    scan_ms: facts.assembleMs,
    coverage_depth_threshold: facts.coverageDepthThreshold,
    near_window: facts.nearWindow,
    cooldown_days: facts.cooldownDays,
    scope_note: COVERAGE_SCOPE_NOTE,
    subjects,
    totals: {
      activeKcs: facts.frontier.length,
      kcsWithGaps,
      totalGaps,
      gapsByKind,
    },
  };
}

function displayNameMap(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const profile of getDefaultSubjectRegistry().listProfiles()) {
    out[profile.id] = profile.displayName;
  }
  return out;
}

/** Load the lattice for the current scan window. Read-only. */
export async function loadCoverageLattice(
  db: Db | Tx,
  now: Date = new Date(),
): Promise<CoverageLatticeRead> {
  const reader = readScan;
  if (!reader) {
    throw new Error(
      'coverage scan facts are not installed; call installCoverageLatticeScan before reading the lattice',
    );
  }
  const facts = await reader(db);
  const lookbackDays = Math.max(ACTIVITY_LOOKBACK_FLOOR_DAYS, facts.cooldownDays);
  const cutoff = new Date(now.getTime() - lookbackDays * DAY_MS);
  const rows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(and(eq(event.action, SUPPLY_EVENT_ACTION), gte(event.created_at, cutoff)))
    .orderBy(asc(event.created_at));

  const activityEvents: SupplyActivityEvent[] = [];
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown> | null;
    const fingerprint = payload?.fingerprint;
    const status = payload?.status;
    if (typeof fingerprint !== 'string' || typeof status !== 'string') continue;
    activityEvents.push({ fingerprint, status, createdAt: row.created_at });
  }
  const activityByFingerprint = aggregateSupplyActivity(activityEvents, now, facts.cooldownDays);
  return buildCoverageLattice(facts, activityByFingerprint, now, displayNameMap());
}
