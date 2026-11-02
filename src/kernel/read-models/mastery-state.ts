// Canonical mastery_state reads and hierarchical-Elo global-ability resolution.
// Online diagnostic writes belong to kernel/records/mastery-state (ADR-0035).

import { and, eq, inArray } from 'drizzle-orm';

import { HIERARCHICAL_ELO_ENABLED } from '@/core/theta';
import type { ThetaGridPosterior } from '@/core/theta-grid';
import type { Db, Tx } from '@/db/client';
import { mastery_state } from '@/db/schema';
import {
  batchResolveEffectiveDomains,
  getEffectiveDomain,
} from '@/kernel/read-models/knowledge-tree';

type DbLike = Db | Tx;

// Global ability reuses mastery_state: subject_kind = ability_global, subject_id =
// the KC's effective domain. One row per touched domain. When
// HIERARCHICAL_ELO_ENABLED is false, no such row is read or written.
const ABILITY_GLOBAL_KIND = 'ability_global';

export interface MasteryStateRow {
  subject_kind: string;
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date | null;
  // Cumulative Fisher information; SE derives from it.
  theta_precision: number;
  last_theta_delta: number | null;
  // Shadow grid-Bayes offset posterior; null until the dark-ship write path is on.
  theta_grid_json: ThetaGridPosterior | null;
}

/** Shared by single and batch reads so their shape cannot drift. */
function toMasteryStateRow(row: typeof mastery_state.$inferSelect): MasteryStateRow {
  return {
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    theta_hat: row.theta_hat,
    evidence_count: row.evidence_count,
    success_count: row.success_count,
    fail_count: row.fail_count,
    last_outcome_at: row.last_outcome_at ?? null,
    theta_precision: row.theta_precision,
    last_theta_delta: row.last_theta_delta ?? null,
    theta_grid_json: (row.theta_grid_json as ThetaGridPosterior | null) ?? null,
  };
}

/**
 * Read the current p(L) state row for a knowledge node, or null (cold start).
 */
export async function getMasteryState(
  db: DbLike,
  knowledgeId: string,
  subjectKind = 'knowledge',
): Promise<MasteryStateRow | null> {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, subjectKind), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return toMasteryStateRow(row);
}

/**
 * Batch twin of getMasteryState: one inArray query. Absent ids stay absent, so
 * callers apply the same cold-start defaults. Includes theta_grid_json.
 */
export async function getMasteryStates(
  db: DbLike,
  knowledgeIds: string[],
  subjectKind = 'knowledge',
): Promise<Map<string, MasteryStateRow>> {
  const ids = Array.from(new Set(knowledgeIds.filter((id) => id.length > 0)));
  const out = new Map<string, MasteryStateRow>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, subjectKind), inArray(mastery_state.subject_id, ids)),
    );
  for (const row of rows) out.set(row.subject_id, toMasteryStateRow(row));
  return out;
}

/**
 * Per-domain global theta for an already-resolved domain. Flag off returns 0 without
 * touching the DB; flag on reads the ability_global row (missing -> 0). KC callers
 * that have not resolved a domain should use effectiveThetaForKc.
 */
export async function globalThetaForDomain(db: DbLike, domain: string | null): Promise<number> {
  if (!HIERARCHICAL_ELO_ENABLED || domain === null) return 0;
  const row = await getMasteryState(db, domain, ABILITY_GLOBAL_KIND);
  return row?.theta_hat ?? 0;
}

/** The `mastery_state.subject_kind` partition the hierarchical-Elo domain rows live in. */
export const ABILITY_GLOBAL_SUBJECT_KIND = ABILITY_GLOBAL_KIND;

export type AbilityGlobalByKnowledgeId = Readonly<Record<string, string>>;

/**
 * Freeze the hierarchical-Elo write target per KC. Durable judging stores this map
 * so a later reparent cannot move the worker's write away from the domain recorded
 * in pending evidence.
 */
export async function resolveAbilityGlobalByKnowledgeId(
  db: DbLike,
  knowledgeIds: string[],
): Promise<Record<string, string>> {
  if (!HIERARCHICAL_ELO_ENABLED) return {};
  const kcIds = Array.from(new Set(knowledgeIds)).filter((k) => k.length > 0);
  if (kcIds.length === 0) return {};
  const domainByKc = await batchResolveEffectiveDomains(db, kcIds);
  const resolved: Record<string, string> = {};
  for (const id of kcIds) {
    const domain = domainByKc.get(id);
    if (domain !== null && domain !== undefined) resolved[id] = domain;
  }
  return resolved;
}

/**
 * The ability_global ids updateThetaForAttempt would write for these KCs. Every KC
 * under a domain shares that row, so an out-of-order check keyed only by KC id
 * cannot see sibling collisions.
 */
export async function resolveAbilityGlobalSubjectIds(
  db: DbLike,
  knowledgeIds: string[],
): Promise<string[]> {
  return Array.from(
    new Set(Object.values(await resolveAbilityGlobalByKnowledgeId(db, knowledgeIds))),
  );
}

/**
 * Effective ability for a KC = global(domain) + thetaKc, mirroring the write path.
 * Flag off returns thetaKc unchanged without a domain walk or row read.
 */
export async function effectiveThetaForKc(
  db: DbLike,
  knowledgeId: string,
  thetaKc: number,
): Promise<number> {
  if (!HIERARCHICAL_ELO_ENABLED) return thetaKc; // dark-ship: bit-identical to today.
  let domain: string | null;
  try {
    domain = await getEffectiveDomain(db, knowledgeId);
  } catch {
    return thetaKc; // orphan / null-root-domain → no domain anchor → θ_global=0.
  }
  return (await globalThetaForDomain(db, domain)) + thetaKc;
}

/**
 * Batch twin of effectiveThetaForKc: one tree walk for domains and one inArray read
 * for global rows. Entries carry already-read thetaKc, so no per-KC mastery SELECT
 * is re-issued. Flag off returns every thetaKc unchanged.
 */
export async function effectiveThetaForKcBatch(
  db: DbLike,
  entries: Array<{ knowledgeId: string; thetaKc: number }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!HIERARCHICAL_ELO_ENABLED) {
    for (const e of entries) out.set(e.knowledgeId, e.thetaKc); // dark-ship: bit-identical.
    return out;
  }
  const kcIds = Array.from(new Set(entries.map((e) => e.knowledgeId)));
  const domainByKc = await batchResolveEffectiveDomains(db, kcIds);
  const distinctDomains = Array.from(
    new Set([...domainByKc.values()].filter((d): d is string => d !== null)),
  );
  const globalRows = await getMasteryStates(db, distinctDomains, ABILITY_GLOBAL_KIND);
  const globalByDomain = new Map<string, number>();
  for (const d of distinctDomains) globalByDomain.set(d, globalRows.get(d)?.theta_hat ?? 0);
  for (const e of entries) {
    const domain = domainByKc.get(e.knowledgeId) ?? null;
    const global = domain !== null ? (globalByDomain.get(domain) ?? 0) : 0;
    out.set(e.knowledgeId, global + e.thetaKc);
  }
  return out;
}
