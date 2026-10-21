// Nightly near-duplicate KC detection. Unified tagging can mint several KCs for the
// same concept, so this scans recent KCs by cosine distance and proposes merges for
// the human to accept.
//
// Propose-only by construction: this file must not import or call applyMerge, which
// archives KCs and repairs downstream attribution. Only the accept path may do that.
//
// Detection is deterministic and needs a pairwise self-join, so it does not reuse the
// single-query top-K similarity retriever.

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  dedupDistanceMax,
  dedupMaxPairs,
  dedupWindowDays,
} from '@/capabilities/knowledge/server/dedup-flags';
import {
  type WriteProposalEntry,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';

export interface KcDedupNightlyResult {
  scanned_pairs: number;
  merge_proposals_created: number;
  /** Already proposed in the window, or the propose write failed. */
  skipped: number;
}

/** Test seam capturing what is proposed without the full event stack. */
export type ProposeFn = (db: Db, entry: WriteProposalEntry) => Promise<string>;

export interface RunKcDedupNightlyOpts {
  distanceMax?: number;
  windowDays?: number;
  maxPairs?: number;
  proposeFn?: ProposeFn;
}

type NearDupPairRow = {
  a_id: string;
  b_id: string;
  a_name: string;
  b_name: string;
  a_version: number;
  b_version: number;
  a_created_at: string;
  b_created_at: string;
  distance: number;
};

/**
 * Detect and propose merges for near-duplicate recent KCs; never merges itself.
 * One side must be minted within the window, which bounds cost to recent churn.
 * Proposal-minted KCs enter the window immediately but only pair once embedded.
 */
export async function runKcDedupNightly(
  db: Db,
  opts: RunKcDedupNightlyOpts = {},
): Promise<KcDedupNightlyResult> {
  const distanceMax = opts.distanceMax ?? dedupDistanceMax();
  const windowDays = opts.windowDays ?? dedupWindowDays();
  const maxPairs = opts.maxPairs ?? dedupMaxPairs();
  const proposeFn = opts.proposeFn ?? writeKnowledgeProposeEvent;

  // Pairwise self-join over live embedded rows: a.id < b.id visits each unordered
  // pair once, at least one side must be recently minted, and distance must be under
  // the ceiling. Closest pairs are proposed first, capped per run.
  const pairRows = await db.execute<NearDupPairRow>(sql`
    WITH recent_auto AS (
      SELECT DISTINCT subject_id AS id
      FROM event
      WHERE action = 'experimental:auto_tag_kc_created'
        AND subject_kind = 'knowledge'
        AND outcome = 'success'
        AND created_at > now() - make_interval(days => ${windowDays})
      UNION
      -- YUK-1010 — proposal-minted KCs were invisible to the window: propose_new /
      -- split mints carry no auto_tag event; the minted id lives in
      -- materialized_id_index anchored to its propose/split event. Genesis-anchored
      -- rows are excluded (baseline backfill, not a recent mint).
      -- The window keys on m.created_at (the ACCEPT-time mint stamp), not
      -- e.created_at (propose time): a proposal pending longer than windowDays
      -- still mints a fresh KC that belongs in the window (OCR review).
      SELECT m.materialized_id AS id
      FROM materialized_id_index m
      JOIN event e ON e.id = m.anchor_event_id
      WHERE m.subject_kind = 'knowledge'
        AND e.action IN ('propose', 'experimental:knowledge_split')
        AND e.subject_kind = 'knowledge'
        AND m.created_at > now() - make_interval(days => ${windowDays})
    )
    SELECT
      a.id AS a_id,
      b.id AS b_id,
      a.name AS a_name,
      b.name AS b_name,
      a.version AS a_version,
      b.version AS b_version,
      a.created_at AS a_created_at,
      b.created_at AS b_created_at,
      (a.embedding <=> b.embedding) AS distance
    FROM knowledge a
    JOIN knowledge b
      ON a.id < b.id
    WHERE a.archived_at IS NULL
      AND b.archived_at IS NULL
      AND a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND (a.id IN (SELECT id FROM recent_auto) OR b.id IN (SELECT id FROM recent_auto))
      AND (a.embedding <=> b.embedding) <= ${distanceMax}
    ORDER BY distance ASC
    LIMIT ${maxPairs}
  `);

  let merge_proposals_created = 0;
  let skipped = 0;

  // Cross-run dedup: the propose writer has no merge cooldown, so an unresolved pair
  // would otherwise produce a duplicate pending item every night. After the window a
  // remaining duplicate may be proposed again.
  const priorMergeRows = await db.execute<{
    payload: { into_id?: string; from_ids?: string[] } | null;
  }>(sql`
    SELECT payload FROM event
    WHERE action = 'experimental:knowledge_merge'
      AND created_at > now() - make_interval(days => ${windowDays})
  `);
  const proposedPairKeys = new Set<string>();
  for (const row of priorMergeRows) {
    const into = row.payload?.into_id;
    if (!into) continue;
    for (const f of row.payload?.from_ids ?? []) proposedPairKeys.add([into, f].sort().join('::'));
  }

  for (const pair of pairRows) {
    // Normalize raw-execute values, which may arrive as strings by type parser.
    const aCreatedMs = new Date(pair.a_created_at).getTime();
    const bCreatedMs = new Date(pair.b_created_at).getTime();
    const distance = Number(pair.distance);

    // Keep the older, better-attributed KC as the merge target; tie-break by id.
    const aOlder = aCreatedMs < bCreatedMs || (aCreatedMs === bCreatedMs && pair.a_id < pair.b_id);

    const intoId = aOlder ? pair.a_id : pair.b_id;
    const fromId = aOlder ? pair.b_id : pair.a_id;
    const fromVersion = Number(aOlder ? pair.b_version : pair.a_version);

    // applyMerge needs exactly one version per from_id and none for the target; its
    // own guard rejects an accept when the KC changed since proposal.
    const expected_versions: Record<string, number> = { [fromId]: fromVersion };

    if (proposedPairKeys.has([intoId, fromId].sort().join('::'))) {
      skipped += 1;
      continue;
    }

    const reasoning = `kc_dedup_nightly: cosine_distance ${distance.toFixed(4)} ≤ ${distanceMax} near-duplicate auto-created KCs ("${pair.a_name}" / "${pair.b_name}"); proposing merge of ${fromId} into ${intoId} (older = into)`;

    try {
      await proposeFn(db, {
        payload: {
          mutation: 'merge',
          from_ids: [fromId],
          into_id: intoId,
          expected_versions,
        },
        reasoning,
        actor_ref: 'kc_dedup_nightly',
      });
      merge_proposals_created += 1;
    } catch (err) {
      // Best effort per pair; one failed write must not abort the scan.
      console.error('[kc_dedup_nightly] propose failed for pair', pair.a_id, pair.b_id, err);
      skipped += 1;
    }
  }

  const result: KcDedupNightlyResult = {
    scanned_pairs: pairRows.length,
    merge_proposals_created,
    skipped,
  };

  // One audit event per scan. The action is not folded, so it stays out of the inbox;
  // only the merge proposals are user-actionable. A failed audit write must not throw,
  // because the proposals already committed and a retry would rescan.
  try {
    await writeEvent(db, {
      id: newId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'kc_dedup_nightly',
      action: 'experimental:kc_dedup_scan',
      subject_kind: 'knowledge',
      // A scan has no single KC; this sentinel satisfies the non-null subject.
      subject_id: 'kc_dedup_scan',
      outcome: 'success',
      payload: {
        scanned_pairs: result.scanned_pairs,
        merge_proposals_created: result.merge_proposals_created,
        skipped: result.skipped,
        threshold: distanceMax,
        window_days: windowDays,
        max_pairs: maxPairs,
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
    });
  } catch (err) {
    console.error('[kc_dedup_nightly] audit event write failed (proposals already committed)', err);
  }

  return result;
}

// Per-pair failures are absorbed above, so a throw here is an infra fault and should
// reach pg-boss for retry.
export function buildKcDedupNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const { scanned_pairs, merge_proposals_created, skipped } = await runKcDedupNightly(db);
      console.log(
        '[kc_dedup_nightly] scanned_pairs',
        scanned_pairs,
        'merge_proposals_created',
        merge_proposals_created,
        'skipped',
        skipped,
      );
    } catch (err) {
      console.error('[kc_dedup_nightly] failed', err);
      throw err;
    }
  };
}
