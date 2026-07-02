// YUK-543 — retroactive + recurring merge-attribution repair.
//
// applyMerge (post-YUK-543) repairs all 9 downstream attribution surfaces at accept time. Two gaps
// remain that this module closes with the SAME repair mechanics (repairMergeAttributionForFromId —
// never raw table writes, so it stays guard-compliant + can never diverge from the live path):
//
//   1. PRE-FIX HISTORY — merges accepted before YUK-543 archived a `from` KC + appended merged_from[]
//      but LEFT the downstream surfaces (question/learning_item/goal knowledge_ids, edges, per-KC
//      state, misconception targets) pointing at the now-archived id. The one-time backfill
//      (scripts/backfill-merge-attribution.ts) repairs them.
//   2. ASYNC-GRADING RACE RESIDUAL — a background grading worker whose knowledgeIds arg was resolved
//      from a stale pre-merge read can, AFTER the merge commits, upsert a fresh mastery/fsrs row keyed
//      to the archived from_id (the in-tx advisory lock narrows but cannot fully close this without
//      touching the grading path itself). A low-frequency report-only sweep (registered as a knowledge
//      capability job) surfaces any such residual for the owner — zero writes.
//
// Idempotent by construction: every repair helper queries "rows still referencing fromId" and no-ops
// when none exist, so a second run finds nothing (the backfill test asserts this).

import type { Db, Tx } from '@/db/client';
import {
  goal,
  kc_typed_state,
  knowledge,
  knowledge_edge,
  learner_axis_state,
  learning_item,
  mastery_state,
  material_fsrs_state,
  misconception_edge,
  question,
} from '@/db/schema';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { repairMergeAttributionForFromId } from './proposals';

// ── merge-chain resolution (spec §4 decision 4b) ─────────────────────────────────────────────────

export interface MergeChainResolution {
  fromId: string;
  /** the terminal LIVE winner this from_id ultimately merged into, or null when unresolvable. */
  winnerId: string | null;
  /** why the chain was NOT resolved to a live winner (skip, do not guess). */
  skipReason?: 'archived_terminal' | 'cycle';
}

/**
 * Resolve every absorbed KC (an id appearing in some node's merged_from[]) to its TERMINAL LIVE
 * winner by walking the merged_from chain (loser → winner → further-merged-winner). When the terminal
 * node is itself archived-but-NOT-merged (an already-inconsistent state) or the chain cycles, the
 * from_id is returned with winnerId=null + a skipReason — logged and skipped, never guessed.
 */
export async function resolveMergeChains(db: Db | Tx): Promise<MergeChainResolution[]> {
  const rows = await db
    .select({
      id: knowledge.id,
      archived_at: knowledge.archived_at,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge);

  // absorbedInto[fromId] = the node id that absorbed it (its merged_from contains fromId).
  const absorbedInto = new Map<string, string>();
  const isLive = new Set<string>();
  for (const r of rows) {
    if (r.archived_at === null) isLive.add(r.id);
    for (const fromId of (r.merged_from as string[]) ?? []) {
      absorbedInto.set(fromId, r.id);
    }
  }

  const resolutions: MergeChainResolution[] = [];
  for (const fromId of absorbedInto.keys()) {
    let cur = fromId;
    const seen = new Set<string>();
    let resolution: MergeChainResolution | null = null;
    while (resolution === null) {
      if (seen.has(cur)) {
        resolution = { fromId, winnerId: null, skipReason: 'cycle' };
        break;
      }
      seen.add(cur);
      const next = absorbedInto.get(cur);
      if (next === undefined) {
        // cur is not absorbed into anything: it is the terminal. It must be LIVE to be a winner.
        resolution = isLive.has(cur)
          ? { fromId, winnerId: cur }
          : { fromId, winnerId: null, skipReason: 'archived_terminal' };
        break;
      }
      cur = next;
    }
    resolutions.push(resolution);
  }
  return resolutions;
}

// ── read-only orphan-surface census (report-only sweep) ──────────────────────────────────────────

export interface OrphanSurfaceCounts {
  questions: number;
  learningItems: number;
  goals: number;
  edges: number;
  masteryState: boolean;
  fsrsState: boolean;
  axisState: boolean;
  kcTypedState: boolean;
  misconceptionEdges: number;
}

function surfaceTotal(c: OrphanSurfaceCounts): number {
  return (
    c.questions +
    c.learningItems +
    c.goals +
    c.edges +
    (c.masteryState ? 1 : 0) +
    (c.fsrsState ? 1 : 0) +
    (c.axisState ? 1 : 0) +
    (c.kcTypedState ? 1 : 0) +
    c.misconceptionEdges
  );
}

async function countRows(db: Db | Tx, whereSql: ReturnType<typeof sql>, table: 'q' | 'li' | 'g') {
  const tbl = table === 'q' ? question : table === 'li' ? learning_item : goal;
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(tbl).where(whereSql);
  return rows[0]?.n ?? 0;
}

/** READ-ONLY census of every surface still referencing `fromId`. Zero writes. */
export async function countOrphanSurfaces(
  db: Db | Tx,
  fromId: string,
): Promise<OrphanSurfaceCounts> {
  const contains = JSON.stringify([fromId]);
  const questions = await countRows(db, sql`${question.knowledge_ids} @> ${contains}::jsonb`, 'q');
  const learningItems = await countRows(
    db,
    sql`${learning_item.knowledge_ids} @> ${contains}::jsonb`,
    'li',
  );
  const goals = await countRows(db, sql`${goal.scope_knowledge_ids} @> ${contains}::jsonb`, 'g');
  const edgeRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(knowledge_edge)
    .where(
      and(
        isNull(knowledge_edge.archived_at),
        or(
          eq(knowledge_edge.from_knowledge_id, fromId),
          eq(knowledge_edge.to_knowledge_id, fromId),
        ),
      ),
    );
  const misconRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.to_kind, 'knowledge'),
        eq(misconception_edge.to_id, fromId),
        isNull(misconception_edge.archived_at),
      ),
    );
  const masteryRows = await db
    .select({ id: mastery_state.subject_id })
    .from(mastery_state)
    .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, fromId)))
    .limit(1);
  const fsrsRows = await db
    .select({ id: material_fsrs_state.subject_id })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'knowledge'),
        eq(material_fsrs_state.subject_id, fromId),
      ),
    )
    .limit(1);
  const axisRows = await db
    .select({ id: learner_axis_state.subject_id })
    .from(learner_axis_state)
    .where(
      and(
        eq(learner_axis_state.subject_kind, 'knowledge'),
        eq(learner_axis_state.subject_id, fromId),
      ),
    )
    .limit(1);
  const typedRows = await db
    .select({ id: kc_typed_state.subject_id })
    .from(kc_typed_state)
    .where(
      or(
        and(eq(kc_typed_state.subject_kind, 'knowledge'), eq(kc_typed_state.subject_id, fromId)),
        eq(kc_typed_state.confused_with_kc_id, fromId),
      ),
    )
    .limit(1);

  return {
    questions,
    learningItems,
    goals,
    edges: edgeRows[0]?.n ?? 0,
    masteryState: masteryRows.length > 0,
    fsrsState: fsrsRows.length > 0,
    axisState: axisRows.length > 0,
    kcTypedState: typedRows.length > 0,
    misconceptionEdges: misconRows[0]?.n ?? 0,
  };
}

// ── backfill / sweep runner ──────────────────────────────────────────────────────────────────────

export interface MergeAttributionResult {
  /** distinct absorbed from_ids seen (appearing in some merged_from[]). */
  scannedFromIds: number;
  /** distinct terminal live winners the from_ids resolved to. */
  winners: number;
  /** from_ids that resolved to a live winner (repaired in write mode; would-repair in dry-run). */
  resolved: number;
  /** from_ids skipped (archived-not-merged terminal or a merged_from cycle). */
  skipped: number;
  /** total downstream surfaces that still referenced an absorbed id (census over resolved from_ids). */
  orphanSurfacesFound: number;
}

export interface RunMergeAttributionOpts {
  /** true = READ-ONLY census (the recurring sweep); false = repair (the one-time backfill). */
  dryRun: boolean;
  now?: Date;
}

/**
 * Resolve every absorbed KC to its terminal live winner, then either REPAIR each surface (write mode,
 * via repairMergeAttributionForFromId — the SAME function applyMerge uses) or COUNT the still-dangling
 * surfaces (dry-run / sweep — zero writes). Idempotent in write mode: a second run repairs nothing.
 */
export async function runMergeAttributionBackfill(
  db: Db,
  opts: RunMergeAttributionOpts,
): Promise<MergeAttributionResult> {
  const now = opts.now ?? new Date();
  const resolutions = await resolveMergeChains(db);
  const result: MergeAttributionResult = {
    scannedFromIds: resolutions.length,
    winners: 0,
    resolved: 0,
    skipped: 0,
    orphanSurfacesFound: 0,
  };

  // Group resolved from_ids by their winner so edge rewires see the FULL loser set (loser→loser edges
  // collapse rather than dangling), mirroring a multi-from_id applyMerge.
  const byWinner = new Map<string, string[]>();
  for (const r of resolutions) {
    if (r.winnerId === null) {
      result.skipped += 1;
      console.warn('[merge-attribution] skipping unresolved chain', {
        fromId: r.fromId,
        reason: r.skipReason,
      });
      continue;
    }
    result.resolved += 1;
    const group = byWinner.get(r.winnerId);
    if (group) group.push(r.fromId);
    else byWinner.set(r.winnerId, [r.fromId]);
  }
  result.winners = byWinner.size;

  for (const [winnerId, fromIds] of byWinner) {
    if (opts.dryRun) {
      for (const fromId of fromIds) {
        const census = await countOrphanSurfaces(db, fromId);
        result.orphanSurfacesFound += surfaceTotal(census);
      }
      continue;
    }
    // Write mode: repair the whole winner group in ONE tx (atomic per winner).
    const mergeFromIds = new Set(fromIds);
    await db.transaction(async (tx) => {
      for (const fromId of fromIds) {
        // Census BEFORE repair so the write-mode result reports what it actually fixed.
        result.orphanSurfacesFound += surfaceTotal(await countOrphanSurfaces(tx, fromId));
        await repairMergeAttributionForFromId(tx, fromId, winnerId, now, mergeFromIds);
      }
    });
  }

  return result;
}
