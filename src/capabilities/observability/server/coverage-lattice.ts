// YUK-579 — 供题治理覆盖细目表（coverage lattice）只读读模型 IO 层。READ-ONLY：零写、零 LLM、
// 零 schema、零新查询子系统。纯函数核在 coverage-lattice-core.ts（可 unit 测）；本层做 DB IO +
// 注入真常量。设计真理源 docs/design/2026-07-07-yuk579-coverage-lattice.md。
//
// 单次 DB 遍历（assembleScanInput 复用发现引擎两私有 loader）+ 一条 experimental:question_supply
// 活动聚合查询（MF1）。派题、cooldown 皆不改（只读）。should#1：本蓝图只覆盖 scanCoverageGaps 四
// 规则，confusable_contrast（独立 discovery，同事件不同来源）fingerprint 不匹配 → 正确不 join。

import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { SUPPLY_DISPATCH_COOLDOWN_DAYS } from '@/server/question-supply/dispatcher';
import {
  COVERAGE_DEPTH_THRESHOLD,
  NEAR_WINDOW,
  assembleScanInput,
  scanCoverageGaps,
} from '@/server/question-supply/target-discovery';
import { getDefaultSubjectRegistry } from '@/subjects/profile';
import { and, asc, eq, gte } from 'drizzle-orm';
import {
  type CoverageLatticeRead,
  type LatticeConstants,
  type SupplyActivityEvent,
  aggregateSupplyActivity,
  buildCoverageLattice,
} from './coverage-lattice-core';

export type {
  CoverageLatticeRead,
  GapActivity,
  KcCoverageRow,
  LatticeGap,
  SubjectCoverage,
} from './coverage-lattice-core';

const SUPPLY_EVENT_ACTION = 'experimental:question_supply';
const DAY_MS = 24 * 60 * 60 * 1000;
// 活动查询回看窗（design §4）：≥ cooldown_days，取 30d。命中 event_action_outcome_idx 的
// leading `action` 列做等值扫；`created_at` 是该复合索引第三列（中间 outcome 未约束），故只是
// 索引内 post-filter 而非纯范围——单用户量级（~数百行/30d）无关紧要。
const ACTIVITY_LOOKBACK_DAYS = Math.max(30, SUPPLY_DISPATCH_COOLDOWN_DAYS);

const LATTICE_CONSTANTS: LatticeConstants = {
  coverageDepthThreshold: COVERAGE_DEPTH_THRESHOLD,
  nearWindow: NEAR_WINDOW,
  cooldownDays: SUPPLY_DISPATCH_COOLDOWN_DAYS,
};

/** subjectId → displayName（registry 只读派生）。 */
function displayNameMap(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of getDefaultSubjectRegistry().listProfiles()) {
    out[p.id] = p.displayName;
  }
  return out;
}

/**
 * READ-ONLY 端到端：assembleScanInput（复用私有 loader，含 scan_ms 计时）→ scanCoverageGaps（纯）
 * → 一条 fingerprint 聚合活动查询 → buildCoverageLattice（纯）。零写、零 LLM、零新查询子系统。
 */
export async function loadCoverageLattice(
  db: Db,
  now: Date = new Date(),
): Promise<CoverageLatticeRead> {
  const t0 = Date.now();
  const scanInput = await assembleScanInput(db);
  const scanMs = Date.now() - t0;
  const targets = scanCoverageGaps(scanInput);

  // MF1：单条按 action + 回看窗过滤的活动查询（无 status 过滤），内存按 fingerprint 聚合。
  const cutoff = new Date(now.getTime() - ACTIVITY_LOOKBACK_DAYS * DAY_MS);
  const rows = await db
    .select({ payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(and(eq(event.action, SUPPLY_EVENT_ACTION), gte(event.created_at, cutoff)))
    // NIT-1 (review): stable order so per-fingerprint latest/dispatched pick is deterministic
    // even when two same-fingerprint events share an exact-millisecond created_at.
    .orderBy(asc(event.created_at));

  const activityEvents: SupplyActivityEvent[] = [];
  for (const r of rows) {
    const p = r.payload as Record<string, unknown> | null;
    const fingerprint = p?.fingerprint;
    const status = p?.status;
    if (typeof fingerprint !== 'string' || typeof status !== 'string') continue;
    activityEvents.push({ fingerprint, status, createdAt: r.created_at });
  }
  const activityByFingerprint = aggregateSupplyActivity(
    activityEvents,
    now,
    SUPPLY_DISPATCH_COOLDOWN_DAYS,
  );

  return buildCoverageLattice(scanInput, targets, activityByFingerprint, LATTICE_CONSTANTS, {
    now,
    scanMs,
    displayNameById: displayNameMap(),
  });
}
