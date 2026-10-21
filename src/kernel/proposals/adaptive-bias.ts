// Adaptive proposal-quality bias, additive over the proposal_signals accept/dismiss
// aggregate and the deterministic L1 rubric floor.
//
// Facet A: a per-(kind, relation) feedback digest injected into proposal prompts so
// the model can correct against the observed failure mode.
// Facet B: a computeGateBump input to L1's validator, which stays pure and never
// imports this module.
//
// The bump only tightens, never suppresses L1, and is a no-op on cold start. The
// relation is derived from proposal_signals.cooldown_key, so no schema change; reads
// use the maintained aggregate and bounded recency windows.

import { and, desc, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, proposal_signals } from '@/db/schema';
import type { ProposalFeedbackBudget } from '@/kernel/tools/budgets';

type DbLike = Db | Tx;

export interface ProposalFeedbackCell {
  kind: string; // e.g. 'knowledge_edge'
  relation: string | null; // derived from cooldown_key for edges; null otherwise
  accept_count: number;
  dismiss_count: number;
  total: number;
  acceptance_rate: number; // accept_count / total
  top_dismiss_reasons: string[]; // recent dismiss reasons, bounded
  top_rubric_gates: string[]; // recent rubric gates from rejected events (edge cells only)
}

export interface GateBiasConfig {
  /** Below this acceptance_rate the gate tightens (medium/rescue → strong). */
  acceptanceThreshold: number;
  /** Sample guard: the bump stays off until total decisions ≥ this. */
  minSamples: number;
}

export interface AdaptiveGateInput {
  /** True when this cell's aggregate says to raise the bar one notch for borderline evidence. */
  tightenMediumToStrong: boolean;
  /** Audit metadata carried into the folded rubric_verdict.reason; omitted on the pure-L1 path. */
  acceptanceRate?: number;
  sampleCount?: number;
  threshold?: number;
}

const KNOWLEDGE_EDGE_KIND = 'knowledge_edge';

// Edge cooldown keys are `knowledge_edge:${from}|${to}|${relation_type}`. Split on
// the last `|` only: a relation may itself contain `:`. Non-edge kinds have no
// relation dimension.
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
  // Recent dismiss reasons, only from rows whose latest decision is still a
  // dismiss (cooldown_until non-null); accepted rows retain stale reasons.
  dismissReasons: string[];
}

// Key for (kind, relation) coalescing. JSON keeps the pair distinct without a
// delimiter byte; a literal NUL once made git treat this file as binary. Never
// serialized or parsed back.
function cellKey(kind: string, relation: string | null): string {
  return JSON.stringify([kind, relation]);
}

/**
 * Per-(kind, relation) feedback digest: the maintained signal aggregate plus, for
 * edge cells, recent gates from rubric-rejected events. Cold start returns [] so
 * downstream feeds degrade to a no-op.
 *
 * Sorted by acceptance rate then volume, capped by budget. Dismiss reasons are
 * emitted only for net-negative cells so a stale reason cannot claim a cell the
 * user has since accepted.
 */
export async function getProposalFeedbackDigest(
  db: DbLike,
  budget: ProposalFeedbackBudget,
): Promise<ProposalFeedbackCell[]> {
  // Read raw rows by recency so the symmetric cooldown_key variants coalesce into
  // one relation cell and dismiss reasons come newest-first. updated_at is the
  // best recency proxy the aggregate row has.
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
    // Accept nulls cooldown_until but retains the old dismiss_reason, so a
    // dismiss-then-accept row would otherwise inject a reason the user has since
    // accepted. cooldown_until non-null means the latest decision is still a dismiss.
    if (
      row.dismiss_reason !== null &&
      row.dismiss_reason !== undefined &&
      row.cooldown_until !== null
    ) {
      acc.dismissReasons.push(row.dismiss_reason);
    }
  }

  // Edge relations to surface rubric gates for. Seed from both signal rows and the
  // rubric_rejected bucket: all-rejected relations never reach the inbox, so the
  // signal rows alone would hide their gates and let the model repeat the failure.
  // Both reads stay bounded by a recent LIMIT.
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

  // Materialize a rubric-only cell for rejected relations with no signal row so
  // their gates still surface. total 0 keeps the gate bump inert.
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
    // Keep decision cells and gate-only edge cells; drop empty cells.
    .filter((cell) => cell.total > 0 || cell.top_rubric_gates.length > 0)
    .sort((a, b) => b.acceptance_rate - a.acceptance_rate || b.total - a.total);

  return cells.slice(0, budget.maxKindRelations);
}

// Last | segment of an edge cooldown_key. Only | delimits, so a relation containing
// ':' survives intact.
const cooldownKeyRelationExpr = sql<
  string | null
>`substring(${event.payload}->'ai_proposal'->>'cooldown_key' from '[^|]*$')`;

const signalCooldownKeyRelationExpr = sql<
  string | null
>`substring(${proposal_signals.cooldown_key} from '[^|]*$')`;

// Distinct relations in the most recent rubric_rejected events.
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

// Recent L1 gates for one relation from the rejected bucket.
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
        // Equality, not LIKE: relation names contain '_' and may contain '%', so a
        // suffix LIKE would over-match.
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
 * Tighten-only gate bump. Cold start, too few samples, or an acceptance rate at or
 * above the threshold returns false. A true bump only suppresses the medium/rescue
 * pass, so it cannot turn a reject into a pass or block strong evidence.
 *
 * Rate, sample, and threshold ride along so the folded reject reason can cite them
 * without importing this module.
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
 * Find the cell for one (kind, relation). A miss is that cell's cold start, which
 * computeGateBump treats as a no-op.
 */
export function findFeedbackCell(
  digest: ProposalFeedbackCell[],
  kind: string,
  relation: string | null,
): ProposalFeedbackCell | undefined {
  return digest.find((cell) => cell.kind === kind && cell.relation === relation);
}

// Accept/dismiss counts for one relation, summed over its cooldown_key variants.
// Equality on the derived segment keeps the read exact and independent of any cap.
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
 * Resolve the gate bump for one edge relation with a relation-scoped read. The
 * display digest is sorted and capped, so a low-acceptance cell can be sliced off;
 * summing only this relation's rows keeps the bump independent of the cap and
 * avoids a full aggregate scan on every edge write.
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
