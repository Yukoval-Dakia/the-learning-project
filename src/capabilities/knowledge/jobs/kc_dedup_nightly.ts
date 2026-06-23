// P5 (YUK-489) — dedup-on-maintenance. Auto-approve of new KCs (the unified
// tagging PROPOSE path, P2/P3 — live) accrues near-duplicate KCs over time: two
// uploads that name the same concept slightly differently each mint their own
// child KC under the subject root. This DEDICATED nightly job detects near-dup KC
// pairs by pgvector cosine distance and emits MERGE PROPOSALS (pending inbox
// items) for the human to accept — reusing the live `applyMerge` accept path via
// the standard propose writer.
//
// IRON RULE — PROPOSE-ONLY, NEVER auto-merge. A merge is DESTRUCTIVE: applyMerge
// archives the `from` KCs, sets `into.merged_from[]`, and the accept flow rewrites
// knowledge_ids attribution. That stays behind the human accept gate. The
// enforcement here is STRUCTURAL: this file MUST NOT import or call `applyMerge`.
// It only writes propose events via `writeKnowledgeProposeEvent`. (A reviewer
// greps this file for `applyMerge` → zero hits.)
//
// Why a dedicated job (not feeding a candidate table to KnowledgeReviewTask):
// observability (its own audit event), zero-LLM deterministic detection, and
// structural propose-only. Mirrors the `reference_answer_backfill` (P4a) file
// shape: `run<Name>(db, opts)` returning a counts object + `build<Name>Handler(db)`
// builder; per-pair best-effort; nightly JobDecl.
//
// Detection reuses the `<=>` cosine fragment + `toSqlVector` pattern from
// match-similarity.ts, but NOT matchKnowledgeBySimilarity itself — that is a
// single-query top-K retriever; pairwise dedup needs a SELF-JOIN (a different
// query shape).

import {
  DEDUP_DISTANCE_MAX,
  DEDUP_MAX_PAIRS,
  DEDUP_WINDOW_DAYS,
} from '@/capabilities/knowledge/server/dedup-flags';
import {
  type WriteProposalEntry,
  writeKnowledgeProposeEvent,
} from '@/capabilities/knowledge/server/proposals';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

export interface KcDedupNightlyResult {
  /** unordered near-dup pairs the SELF-JOIN returned (within distance, ≤ maxPairs). */
  scanned_pairs: number;
  /** pairs for which a merge proposal event was successfully written. */
  merge_proposals_created: number;
  /** pairs NOT proposed: already proposed within the window (cross-run dedup) OR the
   *  propose write threw (best-effort; counted, batch continues). */
  skipped: number;
}

/** Inject `writeKnowledgeProposeEvent` in tests to capture WHAT is proposed
 *  without exercising the full event-write stack. Returns the new proposal id. */
export type ProposeFn = (db: Db, entry: WriteProposalEntry) => Promise<string>;

export interface RunKcDedupNightlyOpts {
  /** cosine-distance ceiling; default DEDUP_DISTANCE_MAX. */
  distanceMax?: number;
  /** recent-auto-created lookback window in days; default DEDUP_WINDOW_DAYS. */
  windowDays?: number;
  /** per-run proposal cap; default DEDUP_MAX_PAIRS. */
  maxPairs?: number;
  /** propose writer seam; default writeKnowledgeProposeEvent. */
  proposeFn?: ProposeFn;
}

interface NearDupPairRow {
  a_id: string;
  b_id: string;
  a_name: string;
  b_name: string;
  a_version: number;
  b_version: number;
  a_created_at: Date;
  b_created_at: Date;
  distance: number;
}

/**
 * Detect near-duplicate auto-created KC pairs by cosine distance and PROPOSE a
 * merge for each. PROPOSE-ONLY: writes pending `experimental:knowledge_merge`
 * proposals (human-acceptable via the live applyMerge accept path) — it NEVER
 * archives or merges a KC itself. Returns {scanned_pairs, merge_proposals_created,
 * skipped} and writes one `experimental:kc_dedup_scan` audit event with the counts.
 *
 * Budget: the scan is bounded to pairs where at least one side is a KC minted by
 * auto-tagging within `windowDays` (an `experimental:auto_tag_kc_created` event),
 * AND is still live (non-archived). This keeps the nightly cost proportional to
 * recent auto-tagging churn, not the whole tree.
 */
export async function runKcDedupNightly(
  db: Db,
  opts: RunKcDedupNightlyOpts = {},
): Promise<KcDedupNightlyResult> {
  const distanceMax = opts.distanceMax ?? DEDUP_DISTANCE_MAX;
  const windowDays = opts.windowDays ?? DEDUP_WINDOW_DAYS;
  const maxPairs = opts.maxPairs ?? DEDUP_MAX_PAIRS;
  const proposeFn = opts.proposeFn ?? writeKnowledgeProposeEvent;

  // Pairwise SELF-JOIN over non-archived, embedded `knowledge` rows:
  //   - `a.id < b.id` enumerates each unordered pair exactly once.
  //   - at least ONE side is in the recent-auto-created set (the budget bound):
  //     a live KC whose id appears as subject_id of an `experimental:auto_tag_kc_created`
  //     event inside the window. We confirm "still live" by joining only against
  //     non-archived knowledge rows (the WHERE archived_at IS NULL on a/b), so an
  //     auto-created KC later archived is excluded.
  //   - cosine distance within the ceiling.
  // ORDER BY distance ASC, LIMIT maxPairs → propose the closest pairs first.
  //
  // `<=>` is pgvector cosine distance (match-similarity.ts pattern); the recent
  // set is materialized inline as a CTE of distinct subject_ids. Bind the window
  // as days via make_interval so the parameter is a plain number (no string
  // interpolation into the SQL text).
  // drizzle + the `postgres` driver returns the rows array directly (house cast
  // convention: `as unknown as Array<Row>` — see due-list.ts / mastery/state.ts).
  const pairRows = (await db.execute(sql`
    WITH recent_auto AS (
      SELECT DISTINCT subject_id AS id
      FROM event
      WHERE action = 'experimental:auto_tag_kc_created'
        AND subject_kind = 'knowledge'
        AND outcome = 'success'
        AND created_at > now() - make_interval(days => ${windowDays})
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
  `)) as unknown as NearDupPairRow[];

  let merge_proposals_created = 0;
  let skipped = 0;

  // Cross-run idempotency (OCR #1/#5): build a skip-set of unordered KC pairs ALREADY
  // proposed for merge within the window. The raw writeKnowledgeProposeEvent path does NOT
  // enforce a cooldown (proposalGateCandidate in review.ts returns null for merge — there is
  // no merge dedup anywhere), so without this a still-unresolved pair would re-propose every
  // night → duplicate pending inbox items. Semantics: accept → the `from` KC is archived
  // (excluded by the scan's archived filter next run); reject → not re-proposed within the
  // window (respects the rejection); pending → no duplicate. After the window a still-present
  // dup may re-propose (acceptable). The merge event payload carries top-level `into_id` +
  // `from_ids` (proposals.ts generic branch spreads `...rest` into event_override.payload).
  const priorMergeRows = (await db.execute(sql`
    SELECT payload FROM event
    WHERE action = 'experimental:knowledge_merge'
      AND created_at > now() - make_interval(days => ${windowDays})
  `)) as unknown as Array<{ payload: { into_id?: string; from_ids?: string[] } | null }>;
  const proposedPairKeys = new Set<string>();
  for (const row of priorMergeRows) {
    const into = row.payload?.into_id;
    if (!into) continue;
    for (const f of row.payload?.from_ids ?? []) proposedPairKeys.add([into, f].sort().join('::'));
  }

  for (const pair of pairRows) {
    // Coerce driver-native shapes defensively: the `postgres` driver returns
    // timestamptz as Date and numeric/int as number, but raw-execute results can
    // surface them as strings depending on type parsing — normalize like
    // mastery/state.ts wraps `Number(beta)`.
    const aCreatedMs = new Date(pair.a_created_at).getTime();
    const bCreatedMs = new Date(pair.b_created_at).getTime();
    const distance = Number(pair.distance);

    // into/from selection (deterministic): keep the OLDER KC as `into_id` (the
    // more-established attribution target), merge the NEWER as `from_ids:[newer]`.
    // Tie-break a created_at tie by lexical id (smaller id = into) so the choice
    // is stable across runs regardless of row order.
    const aOlder = aCreatedMs < bCreatedMs || (aCreatedMs === bCreatedMs && pair.a_id < pair.b_id);

    const intoId = aOlder ? pair.a_id : pair.b_id;
    const fromId = aOlder ? pair.b_id : pair.a_id;
    const fromVersion = Number(aOlder ? pair.b_version : pair.a_version);

    // expected_versions: applyMerge (proposals.ts ~:414-418) requires
    //   `for (const fromId of payload.from_ids) if (!(fromId in expected_versions)) throw`
    // — i.e. EXACTLY one entry per from_id; the INTO version is NOT required (the
    // into row is re-read live + version-bumped without an optimistic check). So we
    // map ONLY the from_id → its current version. (Stale-at-accept-time is handled
    // by applyMerge's own `WHERE version = expected_versions[fromId]` guard, which
    // makes the accept a no-op-throw if the KC changed between propose and accept.)
    const expected_versions: Record<string, number> = { [fromId]: fromVersion };

    // Cross-run dedup: this unordered pair already has a merge proposal within the window
    // → skip rather than pile up a duplicate pending item (OCR #1/#5).
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
      // Best-effort per-pair: a single propose-write failure is counted + skipped,
      // the batch continues (mirrors reference_answer_backfill's per-row contract).
      // Never abort the whole scan over one bad pair.
      console.error('[kc_dedup_nightly] propose failed for pair', pair.a_id, pair.b_id, err);
      skipped += 1;
    }
  }

  const result: KcDedupNightlyResult = {
    scanned_pairs: pairRows.length,
    merge_proposals_created,
    skipped,
  };

  // Observability (design §8): one audit event per scan with the counts. Action
  // `experimental:kc_dedup_scan` is NOT folded by proposalWhere() (inbox.ts ~:176
  // folds only `propose` / `experimental:knowledge_%` / `experimental:proposal` /
  // `experimental:propose_learning_intent`) — a generic `experimental:kc_dedup_scan`
  // matches none, so it is audit-only, never a pending inbox item. The merge
  // proposals themselves (action `experimental:knowledge_merge`) ARE folded → those
  // are the human-acceptable items.
  // Best-effort (OCR #2): a failed audit write must NOT throw — the merge proposals already
  // committed above, and throwing would send the job to pg-boss DLQ whose retry would re-scan
  // (the idempotency skip-set above bounds the damage, but a needless retry is still wrong for
  // a counts-only observability write). Log + continue with the real result.
  try {
    await writeEvent(db, {
      id: newId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'kc_dedup_nightly',
      action: 'experimental:kc_dedup_scan',
      subject_kind: 'knowledge',
      // No single KC is the subject of a scan; pin a stable sentinel so the audit
      // row has a non-null subject_id (writeEvent requires one) without implying a
      // target KC. The counts live in the payload.
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

// pg-boss handler builder (mirrors buildReferenceAnswerBackfillHandler /
// buildAnswerClassBackfillHandler): takes the db injected by
// register-capability-jobs, runs the scan, logs counts. Per-pair propose
// failures are already absorbed inside runKcDedupNightly (counted as skipped),
// so a throw HERE is a genuine infra fault (DB down, etc.) → propagates to
// pg-boss for DLQ retry; the next nightly run re-scans the window.
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
