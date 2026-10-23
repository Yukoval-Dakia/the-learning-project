// Merge-attribution resolution and repair. All repair goes through the accept path's
// repairMergeAttributionForFromId, never raw writes, so the two cannot diverge.
//
// Two gaps: merges accepted before accept-time repair left attribution on the archived
// id (fixed by the one-time backfill), and a grading worker holding a stale pre-merge read
// can still write to that id (fixed by the recurring sweep's bounded auto-repair).
//
// Repairs are idempotent: each helper finds rows still referencing the from_id and no-ops
// when there are none.

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { MergeRepairEntryT } from '@/core/schema/event/known';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
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
import { repairMergeAttributionForFromId } from './proposals';

export interface MergeChainResolution {
  fromId: string;
  /** Terminal live winner, or null when unresolvable. */
  winnerId: string | null;
  /** Full hop sequence, including the partial chain on a skip, for forensic logs. */
  chain: string[];
  skipReason?: 'archived_terminal' | 'cycle';
}

/**
 * Walk each absorbed KC's merged_from chain to its terminal live winner. A terminal that
 * is archived without being merged, or a cycle, is skipped rather than guessed.
 */
export async function resolveMergeChains(db: Db | Tx): Promise<MergeChainResolution[]> {
  // Only absorber rows participate; every reachable hop is itself an absorber.
  const rows = await db
    .select({
      id: knowledge.id,
      archived_at: knowledge.archived_at,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge)
    .where(sql`jsonb_array_length(${knowledge.merged_from}) > 0`);

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
    const chain: string[] = [fromId];
    let resolution: MergeChainResolution | null = null;
    while (resolution === null) {
      if (seen.has(cur)) {
        resolution = { fromId, winnerId: null, chain, skipReason: 'cycle' };
        break;
      }
      seen.add(cur);
      const next = absorbedInto.get(cur);
      if (next === undefined) {
        // Nothing absorbs cur, so it is the terminal; it must be live to be a winner.
        resolution = isLive.has(cur)
          ? { fromId, winnerId: cur, chain }
          : { fromId, winnerId: null, chain, skipReason: 'archived_terminal' };
        break;
      }
      chain.push(next);
      cur = next;
    }
    resolutions.push(resolution);
  }
  return resolutions;
}

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

/** Shared tally so census and sweep count identically. */
export function surfaceTotal(c: OrphanSurfaceCounts): number {
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

/**
 * Write-mode counterpart, from the repair's own same-transaction entry. Per-KC state
 * counts when the retire outcome touched a from-row.
 */
export function repairedSurfaceTotal(entry: MergeRepairEntryT): number {
  return (
    entry.question_ids_rewritten.length +
    entry.learning_item_ids_rewritten.length +
    entry.goal_ids_rewritten.length +
    entry.edges_rewired.length +
    (entry.mastery_state !== 'noop' ? 1 : 0) +
    (entry.fsrs_state !== 'noop' ? 1 : 0) +
    (entry.axis_state !== 'noop' ? 1 : 0) +
    (entry.kc_typed_state !== 'noop' ? 1 : 0) +
    entry.misconception_edges_rewritten.length
  );
}

async function countRows(db: Db | Tx, whereSql: ReturnType<typeof sql>, table: 'q' | 'li' | 'g') {
  const tbl = table === 'q' ? question : table === 'li' ? learning_item : goal;
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(tbl).where(whereSql);
  return rows[0]?.n ?? 0;
}

/** Census of every surface still referencing `fromId`; zero writes. */
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

export interface MergeAttributionResult {
  scannedFromIds: number;
  winners: number;
  resolved: number;
  skipped: number;
  orphanSurfacesFound: number;
}

export interface RunMergeAttributionOpts {
  /** True is the read-only CLI census; false repairs. */
  dryRun: boolean;
  now?: Date;
}

/** Shared grouping so the backfill and the sweep cannot drift apart. */
export interface GroupedResolutions {
  /** Winner to its full absorbed set, not just the repaired subset. */
  byWinner: Map<string, string[]>;
  /** Full hop sequence for logs and forensic payloads, including skipped chains. */
  chainByFromId: Map<string, string[]>;
  resolvedFromIds: { fromId: string; winnerId: string }[];
  skipped: number;
}

/** Group by winner, logging and counting skips under the caller's tag. */
export function groupResolvedChains(
  resolutions: MergeChainResolution[],
  logTag: string,
): GroupedResolutions {
  const byWinner = new Map<string, string[]>();
  const chainByFromId = new Map<string, string[]>();
  const resolvedFromIds: { fromId: string; winnerId: string }[] = [];
  let skipped = 0;
  for (const r of resolutions) {
    chainByFromId.set(r.fromId, r.chain);
    if (r.winnerId === null) {
      skipped += 1;
      console.warn(`[${logTag}] skipping unresolved chain`, {
        fromId: r.fromId,
        reason: r.skipReason,
        chain: r.chain,
      });
      continue;
    }
    resolvedFromIds.push({ fromId: r.fromId, winnerId: r.winnerId });
    const group = byWinner.get(r.winnerId);
    if (group) group.push(r.fromId);
    else byWinner.set(r.winnerId, [r.fromId]);
  }
  return { byWinner, chainByFromId, resolvedFromIds, skipped };
}

/**
 * Resolve, then repair through the accept path's function or count in dry-run. A second
 * write run repairs nothing.
 */
export async function runMergeAttributionBackfill(
  db: Db,
  opts: RunMergeAttributionOpts,
): Promise<MergeAttributionResult> {
  const now = opts.now ?? new Date();
  const resolutions = await resolveMergeChains(db);
  const { byWinner, chainByFromId, resolvedFromIds, skipped } = groupResolvedChains(
    resolutions,
    'merge-attribution',
  );
  const result: MergeAttributionResult = {
    scannedFromIds: resolutions.length,
    winners: byWinner.size,
    resolved: resolvedFromIds.length,
    skipped,
    orphanSurfacesFound: 0,
  };

  for (const [winnerId, fromIds] of byWinner) {
    if (opts.dryRun) {
      for (const fromId of fromIds) {
        const census = await countOrphanSurfaces(db, fromId);
        result.orphanSurfacesFound += surfaceTotal(census);
      }
      continue;
    }
    // Repair the whole winner group in one transaction, taking the global write lock
    // first to preserve the accept path's lock order.
    const mergeFromIds = new Set(fromIds);
    await db.transaction(async (tx) => {
      await acquireLearningStateWriteLock(tx);
      for (const fromId of fromIds) {
        // No pre-repair census: the entry already carries same-transaction counts.
        const entry = await repairMergeAttributionForFromId(
          tx,
          fromId,
          winnerId,
          now,
          mergeFromIds,
        );
        result.orphanSurfacesFound += repairedSurfaceTotal(entry);
        // Keep the full chain, so a bad hop is reconstructable from the log alone.
        console.log('[merge-attribution] repaired', {
          fromId,
          winnerId,
          chain: chainByFromId.get(fromId),
        });
      }
    });
  }

  return result;
}
