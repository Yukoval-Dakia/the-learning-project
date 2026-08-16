// P5.4-L2 / YUK-174 — Adaptive accept-learned proposal-quality bias.
//
// Spec: docs/superpowers/specs/2026-05-31-p5.4-l2-adaptive-bias-design.md
//
// An ADDITIVE soft layer on top of T-AR (the proposal_signals accept/dismiss
// signal) + L1 (the deterministic rubric floor, rubric-validator.ts). This
// module owns BOTH L2 products (AB-1):
//
//   (Facet A) a per-`(kind, relation)` feedback digest — rate + counts + recent
//             dismiss reasons + recent L1 rubric gates — read-only, injected
//             into the Dreaming / Coach / Copilot proposal prompts so a frontier
//             LLM can self-correct against the specific failure mode (in-context
//             learning, §6); and
//   (Facet B) a `computeGateBump` decision passed as an OPTIONAL adaptive input
//             to L1's `validateProposalQuality`. The validator stays PURE and
//             does NOT import this module; it only consumes the carried
//             AdaptiveGateInput (§3.4).
//
// Core invariant (ND-5): additive only, never suppresses L1, no-op on cold
// start. The relation dimension is DERIVED from `proposal_signals.cooldown_key`
// (no schema change, AB-6); reads are bounded (AB-7) — the rate/dismiss read
// hits the maintained aggregate, and the rubric-gate read reuses L1's
// recency-windowed LIMIT 20 event shape (review.ts:308–:319), never the
// unbounded event log.

import { and, desc, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, proposal_signals } from '@/db/schema';
import type { ProposalFeedbackBudget } from '@/kernel/tools/budgets';

type DbLike = Db | Tx;

export interface ProposalFeedbackCell {
  kind: string; // e.g. 'knowledge_edge'
  relation: string | null; // derived from cooldown_key for edges; null for non-edge kinds
  accept_count: number;
  dismiss_count: number;
  total: number;
  acceptance_rate: number; // accept_count / total (T-AR semantics)
  top_dismiss_reasons: string[]; // recent proposal_signals.dismiss_reason (free-form), bounded
  top_rubric_gates: string[]; // recent rubric_verdict.gate from the rubric_rejected bucket, bounded (edge cells only)
}

export interface GateBiasConfig {
  /** Below this acceptance_rate the gate tightens (medium/rescue → strong). */
  acceptanceThreshold: number;
  /** Sample guard: the bump stays off until total decisions ≥ this. */
  minSamples: number;
}

export interface AdaptiveGateInput {
  /** True when this (kind, relation)'s aggregate says: raise the bar one notch
   *  for borderline (medium) evidence. Computed by computeGateBump (AB-3). */
  tightenMediumToStrong: boolean;
  /** Audit metadata for the adaptive reject reason (codex#2). The validator
   *  stays PURE (it does NOT import this module), so the rate/threshold/sample
   *  that drove the bump are carried IN — letting the folded `rubric_verdict.reason`
   *  cite them without the validator re-reading the signal. All optional;
   *  omitted on the pure-L1 path. */
  acceptanceRate?: number;
  sampleCount?: number;
  threshold?: number;
}

const KNOWLEDGE_EDGE_KIND = 'knowledge_edge';

// Derive the relation dimension from a proposal_signals cooldown_key.
//
// Production edge cooldown_key = `knowledge_edge:${from}|${to}|${relation_type}`
// (proposal-tools.ts:82 edgeCooldownKeys; review.ts:355), so the relation is the
// substring after the LAST `|` — and ONLY `|`. A relation may itself contain `:`
// (e.g. an `experimental:*` relation type), so splitting on `:` would truncate
// it; we pin on `|` exclusively (§3.1 / §5 Q2). Non-edge kinds have no relation
// dimension → null (they roll up exactly like the per-kind T-AR row).
export function deriveRelationFromCooldownKey(kind: string, cooldownKey: string): string | null {
  if (kind !== KNOWLEDGE_EDGE_KIND) return null;
  const lastPipe = cooldownKey.lastIndexOf('|');
  if (lastPipe === -1) return null;
  const relation = cooldownKey.slice(lastPipe + 1);
  return relation.length > 0 ? relation : null;
}

function dedupeTruncate(values: string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) continue;
    const truncated = trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
    if (seen.has(truncated)) continue;
    seen.add(truncated);
    out.push(truncated);
    if (out.length >= maxItems) break;
  }
  return out;
}

interface CellAccumulator {
  kind: string;
  relation: string | null;
  accept_count: number;
  dismiss_count: number;
  // Recent (by row updated_at DESC) non-null dismiss_reason snapshots for this
  // cell, collected ONLY from rows whose latest decision is still a dismiss
  // (cooldown_until non-null, codex#5) — an accepted row's retained-but-stale
  // reason is skipped.
  dismissReasons: string[];
}

// Internal-only Map key for `(kind, relation)` coalescing. Collision-free and
// control-char-free: JSON.stringify keeps `kind` and `relation` (incl. null)
// distinct without a delimiter byte (a prior literal 0x00 separator made git
// treat the file as binary). The key is never serialized to output and never
// parsed back — the accumulator stores `kind` / `relation` as separate fields.
function cellKey(kind: string, relation: string | null): string {
  return JSON.stringify([kind, relation]);
}

/**
 * Per-`(kind, relation)` accept-learned feedback digest (Facet A + C).
 *
 * Reads the maintained `proposal_signals` aggregate (rate + counts +
 * dismiss_reason) plus, for EDGE cells, the recent L1 `rubric_verdict.gate`
 * values from the `rubric_rejected` propose-event bucket. Cold start (no signal
 * rows) → `[]`, identical to getProposalAcceptanceRates's honest empty-list
 * cold-start, so every downstream feed degrades to a no-op.
 *
 * Sorted by acceptance_rate DESC, total DESC (callers take "top N"). Capped to
 * `budget.maxKindRelations`. `top_dismiss_reasons` are emitted ONLY for
 * net-negative cells (`dismiss_count > accept_count`) — a per-cooldown_key
 * last-dismiss snapshot stays a stale "currently rejected" claim on a cell the
 * user has since come around on (§3.1 semantics caveat).
 */
export async function getProposalFeedbackDigest(
  db: DbLike,
  budget: ProposalFeedbackBudget,
): Promise<ProposalFeedbackCell[]> {
  // (a) Rate + counts + dismiss reason — from the maintained aggregate. Pull the
  //     raw per-(kind, cooldown_key) rows ordered by recency so the symmetric-
  //     relation cooldown_key variants edgeCooldownKeys emits (directional +
  //     sorted + reversed) coalesce into ONE relation cell, and so dismiss
  //     reasons are taken most-recent-first. updated_at is bumped by a later
  //     accept too, so it is the best recency proxy the aggregate row has
  //     (§5 Q3).
  const rows = await db
    .select({
      kind: proposal_signals.kind,
      cooldown_key: proposal_signals.cooldown_key,
      accept_count: proposal_signals.accept_count,
      dismiss_count: proposal_signals.dismiss_count,
      dismiss_reason: proposal_signals.dismiss_reason,
      cooldown_until: proposal_signals.cooldown_until,
    })
    .from(proposal_signals)
    .orderBy(desc(proposal_signals.updated_at), desc(proposal_signals.id));

  const accumulators = new Map<string, CellAccumulator>();
  for (const row of rows) {
    const relation = deriveRelationFromCooldownKey(row.kind, row.cooldown_key);
    const key = cellKey(row.kind, relation);
    let acc = accumulators.get(key);
    if (!acc) {
      acc = {
        kind: row.kind,
        relation,
        accept_count: 0,
        dismiss_count: 0,
        dismissReasons: [],
      };
      accumulators.set(key, acc);
    }
    acc.accept_count += Number(row.accept_count ?? 0);
    acc.dismiss_count += Number(row.dismiss_count ?? 0);
    // Only collect dismiss_reason when the row's latest decision is still a
    // dismiss (codex#5). ACCEPT nulls cooldown_until but RETAINS the prior
    // dismiss_reason (signals.ts recordProposalDecisionSignalLocked) and bumps
    // updated_at (so an accepted key sorts FIRST here), so a dismiss-then-accept
    // cooldown_key would otherwise inject a reason the user has SINCE accepted.
    // cooldown_until non-null ⟺ the latest decision is a dismiss (accept is the
    // only path that nulls it) ⟺ the reason is still valid.
    if (
      row.dismiss_reason !== null &&
      row.dismiss_reason !== undefined &&
      row.cooldown_until !== null
    ) {
      acc.dismissReasons.push(row.dismiss_reason);
    }
  }

  // (b) Edge relations to surface rubric gates for — EDGE cells only (L1 gates only
  //     knowledge_edge, so non-edge cells carry an empty top_rubric_gates). Seed
  //     from TWO sources (codex#1):
  //       1. the accumulators above (relations that reached the decidable inbox and
  //          accrued a proposal_signals row), and
  //       2. the rubric_rejected propose-event bucket (relations whose proposals
  //          were ALL rubric-rejected before reaching the inbox → no signal row, so
  //          source 1 never sees them and their top_rubric_gates would silently
  //          never surface, letting Dreaming/Coach/Copilot repeat the same rubric
  //          failure).
  //     Reads stay bounded (AB-7): the rejected-relation seed and the per-relation
  //     gate read both reuse L1's recency-windowed LIMIT shape on the event log,
  //     never aggregate-indexed and never a full unbounded scan.
  const accumulatorEdgeRelations = [...accumulators.values()]
    .filter((acc) => acc.kind === KNOWLEDGE_EDGE_KIND && acc.relation !== null)
    .map((acc) => acc.relation as string);
  const rejectedEdgeRelations = await loadRejectedEdgeRelations(db);
  const edgeRelations = [...new Set([...accumulatorEdgeRelations, ...rejectedEdgeRelations])];

  const rubricGatesByRelation = new Map<string, string[]>();
  for (const relation of edgeRelations) {
    rubricGatesByRelation.set(
      relation,
      await loadRubricGatesForEdgeRelation(db, relation, budget.maxRubricGatesPerCell),
    );
  }

  // Materialize a rubric-only EDGE accumulator (accept=dismiss=0) for any rejected
  // relation that has NO proposal_signals row, so its top_rubric_gates still reach
  // Facet A. Such a cell has total 0 + acceptance_rate 0 → computeGateBump stays
  // inert (the minSamples guard fires), so Facet B is unaffected (ND-5).
  for (const relation of rejectedEdgeRelations) {
    const key = cellKey(KNOWLEDGE_EDGE_KIND, relation);
    if (!accumulators.has(key)) {
      accumulators.set(key, {
        kind: KNOWLEDGE_EDGE_KIND,
        relation,
        accept_count: 0,
        dismiss_count: 0,
        dismissReasons: [],
      });
    }
  }

  const cells: ProposalFeedbackCell[] = [...accumulators.values()]
    .map((acc) => {
      const total = acc.accept_count + acc.dismiss_count;
      const netNegative = acc.dismiss_count > acc.accept_count;
      const topDismissReasons = netNegative
        ? dedupeTruncate(acc.dismissReasons, budget.maxDismissReasonsPerCell, budget.maxChars)
        : [];
      const topRubricGates =
        acc.kind === KNOWLEDGE_EDGE_KIND && acc.relation !== null
          ? (rubricGatesByRelation.get(acc.relation) ?? [])
          : [];
      return {
        kind: acc.kind,
        relation: acc.relation,
        accept_count: acc.accept_count,
        dismiss_count: acc.dismiss_count,
        total,
        acceptance_rate: total === 0 ? 0 : acc.accept_count / total,
        top_dismiss_reasons: topDismissReasons,
        top_rubric_gates: topRubricGates,
      };
    })
    // Keep cells with decision signal (total > 0) AND rubric-only edge cells that
    // carry gates (total 0 but non-empty top_rubric_gates, from the rejected-only
    // relations seeded above, codex#1); drop genuinely empty cells.
    .filter((cell) => cell.total > 0 || cell.top_rubric_gates.length > 0)
    .sort((a, b) => b.acceptance_rate - a.acceptance_rate || b.total - a.total);

  return cells.slice(0, budget.maxKindRelations);
}

// SQL for the relation segment of an edge `ai_proposal.cooldown_key`: the last
// `|`-delimited segment of `knowledge_edge:${from}|${to}|${relation_type}`
// (proposal-tools.ts:82). `substring(... from '[^|]*$')` returns the trailing run
// of non-`|` characters — i.e. the relation, and ONLY `|` is treated as a
// delimiter, so an `experimental:*` relation that itself contains `:` survives
// intact (mirrors deriveRelationFromCooldownKey's `|`-only parse).
const cooldownKeyRelationExpr = sql<
  string | null
>`substring(${event.payload}->'ai_proposal'->>'cooldown_key' from '[^|]*$')`;

const signalCooldownKeyRelationExpr = sql<
  string | null
>`substring(${proposal_signals.cooldown_key} from '[^|]*$')`;

// Distinct edge relations present in the rubric_rejected propose-event bucket.
// Seeds getProposalFeedbackDigest's edge-relation set so relations whose
// proposals were ALL rubric-rejected (no proposal_signals row) still surface
// their gates (codex#1). Reuses the rejected-bucket predicate; bounded by a
// recency-windowed LIMIT (AB-7), reading the most recent rejected events.
async function loadRejectedEdgeRelations(db: DbLike): Promise<string[]> {
  const rows = await db
    .select({ relation: cooldownKeyRelationExpr })
    .from(event)
    .where(
      and(
        sql`${event.payload}->'ai_proposal'->>'kind' = ${KNOWLEDGE_EDGE_KIND}`,
        sql`(${event.payload}->'rubric_verdict'->>'ok') = 'false'`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(20);
  return [
    ...new Set(
      rows
        .map((row) => row.relation)
        .filter(
          (relation): relation is string => typeof relation === 'string' && relation.length > 0,
        ),
    ),
  ];
}

// Recent L1 rubric gates for an edge relation. Reuses L1's bounded
// pending-dedup query shape (review.ts:308–:319) — filter on the propose event's
// `ai_proposal.kind`, ORDER BY created_at DESC LIMIT 20 — but SELECTS the REJECTED
// bucket (`rubric_verdict.ok = 'false'`), the exact inverse of RB-7's dedup
// predicate (review.ts:315 `IS DISTINCT FROM 'false'`, which EXCLUDES rejects).
async function loadRubricGatesForEdgeRelation(
  db: DbLike,
  relation: string,
  maxGates: number,
): Promise<string[]> {
  const rejectedRows = await db
    .select({
      gate: sql<string | null>`${event.payload}->'rubric_verdict'->>'gate'`,
    })
    .from(event)
    .where(
      and(
        sql`${event.payload}->'ai_proposal'->>'kind' = ${KNOWLEDGE_EDGE_KIND}`,
        sql`(${event.payload}->'rubric_verdict'->>'ok') = 'false'`,
        // Match the relation by EQUALITY on the derived last-`|`-segment, NOT a
        // `LIKE '%|' || relation` suffix (codex#4): relation types carry LIKE
        // metacharacters — `related_to` / `contrasts_with` / `derived_from` all
        // contain `_` (a LIKE single-char wildcard) and `experimental:*` can carry
        // `%` — so a LIKE match would over-match (e.g. `related_to` would also
        // catch `related_xo`). Equality on the `|`-delimited segment is exact and
        // wildcard-safe.
        sql`${cooldownKeyRelationExpr} = ${relation}`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(20);

  const gates = rejectedRows
    .map((row) => row.gate)
    .filter((gate): gate is string => typeof gate === 'string' && gate.length > 0);
  return dedupeGates(gates, maxGates);
}

function dedupeGates(gates: string[], maxGates: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gate of gates) {
    if (seen.has(gate)) continue;
    seen.add(gate);
    out.push(gate);
    if (out.length >= maxGates) break;
  }
  return out;
}

/**
 * Facet B gate-bump decision (AB-3). Given a `(kind, relation)` feedback cell and
 * the gate-bias config, decide whether L1 should raise the borderline evidence
 * bar one notch (medium/rescue → strong) for that cell.
 *
 * Tighten-only / never-lock / cold-start invariants (§3.4):
 *   - returns `{ tightenMediumToStrong: false }` when the cell is undefined,
 *     below `minSamples`, or its acceptance_rate is `>= acceptanceThreshold`
 *     (the validator then runs the pure L1 path);
 *   - the bump it produces only ever SUPPRESSES the medium/rescue pass in L1, so
 *     it can never loosen a reject into a pass and never blocks `strong`
 *     evidence.
 *
 * Carries the rate/sample/threshold so the validator's folded reject reason can
 * cite them WITHOUT importing this module (codex#2 / traceability §8).
 */
export function computeGateBump(
  cell: ProposalFeedbackCell | undefined,
  config: GateBiasConfig,
): AdaptiveGateInput {
  if (
    !cell ||
    cell.total < config.minSamples ||
    cell.acceptance_rate >= config.acceptanceThreshold
  ) {
    return { tightenMediumToStrong: false };
  }
  return {
    tightenMediumToStrong: true,
    acceptanceRate: cell.acceptance_rate,
    sampleCount: cell.total,
    threshold: config.acceptanceThreshold,
  };
}

/**
 * Resolve the digest cell for a single `(kind, relation)` from a digest list.
 * For edges the relation is derived from the cooldown_key; non-edge kinds match
 * the `relation: null` cell. Returns `undefined` when no matching cell exists
 * (cold start for that cell) → computeGateBump degrades to the pure-L1 no-op.
 */
export function findFeedbackCell(
  digest: ProposalFeedbackCell[],
  kind: string,
  relation: string | null,
): ProposalFeedbackCell | undefined {
  return digest.find((cell) => cell.kind === kind && cell.relation === relation);
}

// Relation-scoped accept/dismiss counts for one `(knowledge_edge, relation)`,
// summed directly over the proposal_signals rows for that relation (coalescing
// the symmetric-relation cooldown_key variants edgeCooldownKeys emits). Matches
// the relation by EQUALITY on the derived last-`|`-segment, so it is independent
// of any display cap and wildcard-safe (same rationale as
// loadRubricGatesForEdgeRelation). `null` SUMs (no rows) → 0.
async function loadEdgeRelationCounts(
  db: DbLike,
  relation: string,
): Promise<{ accept_count: number; dismiss_count: number }> {
  const [row] = await db
    .select({
      accept_count: sql<number>`COALESCE(SUM(${proposal_signals.accept_count}), 0)::int`,
      dismiss_count: sql<number>`COALESCE(SUM(${proposal_signals.dismiss_count}), 0)::int`,
    })
    .from(proposal_signals)
    .where(
      and(
        sql`${proposal_signals.kind} = ${KNOWLEDGE_EDGE_KIND}`,
        sql`${signalCooldownKeyRelationExpr} = ${relation}`,
      ),
    );
  return {
    accept_count: Number(row?.accept_count ?? 0),
    dismiss_count: Number(row?.dismiss_count ?? 0),
  };
}

/**
 * Resolve the Facet-B gate-bump for one edge `(knowledge_edge, relationType)` at
 * an edge write-path call site (§3.4).
 *
 * This does a RELATION-SCOPED direct read (codex#2/#3): it sums only the
 * accept/dismiss counts for THIS relation's cooldown_keys, then computes the
 * bump. It does NOT build + sort + slice the whole digest. The digest is sorted
 * acceptance_rate DESC and capped to `maxKindRelations`, so a low-acceptance cell
 * (exactly the one computeGateBump must tighten) would be sliced off when there
 * are >12 cells — silently degrading the bump to a no-op and coupling it to other
 * relations' counts. The scoped read computes the one cell independently of the
 * display cap, and removes the per-edge-write full scan of proposal_signals (the
 * hot path: every edge write resolves a bump). `budget` is unused here — kept in
 * the signature so call sites stay uniform with the digest readers.
 */
export async function resolveEdgeGateBump(
  db: DbLike,
  relationType: string,
  _budget: ProposalFeedbackBudget,
  config: GateBiasConfig,
): Promise<AdaptiveGateInput> {
  const { accept_count, dismiss_count } = await loadEdgeRelationCounts(db, relationType);
  const total = accept_count + dismiss_count;
  if (total === 0) return computeGateBump(undefined, config);
  const cell: ProposalFeedbackCell = {
    kind: KNOWLEDGE_EDGE_KIND,
    relation: relationType,
    accept_count,
    dismiss_count,
    total,
    acceptance_rate: accept_count / total,
    top_dismiss_reasons: [],
    top_rubric_gates: [],
  };
  return computeGateBump(cell, config);
}
