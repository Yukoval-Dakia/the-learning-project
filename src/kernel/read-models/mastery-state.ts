// YUK-1570 — canonical mastery_state read model (row reads + hierarchical-Elo
// ability_global resolution). Moved verbatim from src/server/mastery/state.ts;
// the server module remains the SOLE writer of `mastery_state` (ADR-0035) and
// keeps an explicit compat re-export for current tests/external users.

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

// A2 (YUK-434) — per-domain global ability θ_global storage. We REUSE mastery_state
// (zero new tables/columns): a θ_global row has subject_kind = ABILITY_GLOBAL_KIND
// and subject_id = the KC's effective_domain id. One row per domain the learner has
// touched. subject_id is a DOMAIN id here (not a KC id) — the (subject_kind,
// subject_id) unique index keeps the per-(kind,id) keying clean and orthogonal to
// the 'knowledge' per-KC rows (no collision: a KC id and a domain id live in
// different subject_kind partitions). When HIERARCHICAL_ELO_ENABLED=false NO global
// row is ever read or written, so this kind never appears in the table (dark-ship).
const ABILITY_GLOBAL_KIND = 'ability_global';

export interface MasteryStateRow {
  subject_kind: string;
  subject_id: string;
  theta_hat: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date | null;
  // YUK-361 Phase 2 — 累积 Fisher information（SE 从此派生，见 thetaSe）+ 上次 Δθ̂。
  theta_precision: number;
  last_theta_delta: number | null;
  // A4 inc-2 (YUK-436) — the shadow grid-Bayes θ_KC offset posterior (null until the
  // dark-ship write path THETA_GRID_ENABLED is on). Surfaced here so the selection read
  // path (candidate-signals) can feed it to klpScoreFromGrid when wired. ADDITIVE: the
  // many existing MasteryStateRow consumers ignore it; it stays NULL on the live path.
  theta_grid_json: ThetaGridPosterior | null;
}

/** Project a raw `mastery_state` row to the public {@link MasteryStateRow} shape. Single source
 *  shared by {@link getMasteryState} (single) and {@link getMasteryStates} (batch) so the two
 *  can never drift. */
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
 * YUK-716 — batch twin of {@link getMasteryState}: read the p(L) state rows for MANY knowledge
 * nodes in ONE `inArray` query, keyed by `subject_id`. Nodes with no row (cold start) are simply
 * ABSENT from the map — callers apply the same cold-start defaults they use for a null single
 * read. RAW rows only (no A5/A6 KG soft-layer): this is the selection-read primitive that
 * replaces the per-KC `getMasteryState` N+1 in `collectCandidateSignals` while preserving the
 * `theta_grid_json` column the projection read model drops.
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
 * A2 (YUK-434) — read the per-domain θ_global for an ALREADY-RESOLVED domain id.
 *
 * FLAG OFF (DEFAULT): returns 0 WITHOUT touching the DB (dark-ship — no global row
 *   exists, callers add 0 → effective == θ_KC, bit-identical to today).
 * FLAG ON: reads the domain's 'ability_global' mastery_state row (null → 0).
 *
 * Use this when the caller has ALREADY resolved the raw domain string (e.g.
 * target-discovery resolves getEffectiveDomain for subjectId anyway) — it avoids a
 * second domain walk. KC-keyed callers that have NOT resolved a domain should use
 * {@link effectiveThetaForKc}, which resolves the domain for them.
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
 * Resolve the exact hierarchical-Elo write target for every KC at one point in time.
 *
 * Durable judging freezes this map alongside the question snapshot. Re-resolving a KC after
 * enqueue would let a later reparent silently move the worker's write from the domain recorded
 * in immutable pending evidence to a different domain, breaking the late-arrival watermark.
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
 * YUK-777 B1 — the `ability_global` subject ids `updateThetaForAttempt` WOULD write for
 * these KCs, exposed so an out-of-order check can cover them.
 *
 * Why this needs to exist: `mastery_state(subject_kind='ability_global', subject_id=<domain>)`
 * is a SHARED row — every KC under a domain writes it (see the per-domain block below). So
 * two attempts on SIBLING KCs of one domain collide there while sharing no knowledge id at
 * all, which is exactly the case a KC-keyed ordering check cannot see (codex #TuxJJ): the
 * older attempt passes, then walks the domain's θ̂ backwards and rewrites `last_outcome_at`
 * to an earlier instant.
 *
 * It resolves all KC domains through the shared archived-inclusive batch tree walk. Null results
 * preserve the write path's orphan→degrade behavior while avoiding serial parent-chain queries.
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
 * A2 (YUK-434) — read-side effective ability for a KC = θ_global(domain-of-KC) +
 * θ_KC, mirroring the write-path's effective-theta input.
 *
 * FLAG OFF (DEFAULT): θ_global ≡ 0 → returns `thetaKc` UNCHANGED. No domain is
 *   resolved, no global row is read — so the selection read paths are
 *   BYTE-IDENTICAL to single-layer Elo (they pass today's theta_hat straight
 *   through). This is the guarantee the regression tests pin.
 * FLAG ON: resolve the KC's effective_domain (getEffectiveDomain — the same
 *   resolver the write path uses; orphan/null-root → degrade to θ_global=0), read
 *   that domain's θ_global row (null → 0), return θ_global + thetaKc.
 *
 * `thetaKc` is the per-KC `theta_hat` (the offset) the caller already read from a
 * 'knowledge' mastery_state row (or the cold-start default). Keeping the caller's
 * already-fetched value avoids a redundant per-KC SELECT — this helper only adds the
 * (memoizable-by-caller) domain + global-row reads, and ONLY when the flag is on.
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
 * YUK-716 — batch twin of {@link effectiveThetaForKc}: resolve `θ_global(domain) + θ_KC` for
 * MANY KCs while collapsing the per-KC domain walk + per-KC θ_global read into two bulk reads
 * (one archived-inclusive tree walk for the domains, one `inArray` for the `ability_global`
 * rows). Reads are O(1) in KC count, not O(N×domain-depth).
 *
 * FLAG OFF (DEFAULT, dark-ship): θ_global ≡ 0 → returns `thetaKc` for every entry WITHOUT
 *   touching the DB — byte-identical to the per-KC {@link effectiveThetaForKc} flag-off path.
 * FLAG ON: {@link batchResolveEffectiveDomains} resolves each KC's effective domain
 *   (caught-to-null exactly where the per-KC `getEffectiveDomain` throws → θ_global=0), then a
 *   single {@link getMasteryStates} reads every distinct domain's `ability_global` row (null →
 *   0). effective_k = θ_global(domain_k) + θ_KC_k — the same arithmetic as the single path.
 *
 * `entries` should carry each KC's already-read `thetaKc` (the caller's `mastery_state.theta_hat`
 * or cold-start default) so no per-KC `mastery_state` SELECT is re-issued here.
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
