// Research-meeting candidate selection: the one owner of the order
// gather → history gate → accountability rank → batched enrichment →
// reproducible + complete-evidence filter → second history gate → image load → final rank.
// Read-only: no transaction, no lock; callers own durability and execution locks.

import type { Db } from '@/db/client';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import {
  type PredictionAccountability,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from './accountability';
import {
  CONJECTURE_RECURRENCE_FLOOR,
  type ConjectureMasteryProjection,
  type EnrichedEvidenceCell,
  type EvidenceCell,
  type LoadedConjectureEvidenceImage,
  collectConjectureEvidenceAssetRefs,
  conjectureKey,
  gatherConjectureEvidence,
} from './evidence';
import { enrichEvidenceCells } from './evidence-enrichment';
import { type ConjectureImageFetchFn, loadConjectureEvidenceImages } from './evidence-images';
import {
  type ConjectureHistory,
  applyConjectureHistoryGate,
  loadConjectureHistory,
} from './history';

/** Enrichment batch for uncapped selections; capped selections batch at their top-K size. */
const UNCAPPED_ENRICH_BATCH_SIZE = 3;

export interface ConjectureCandidate {
  cell: EnrichedEvidenceCell;
  evidenceImages: LoadedConjectureEvidenceImage[];
  priorClaimMd: string | null;
}

export type ConjectureCandidateExclusion =
  | { key: string; reason: 'non_reproducible_evidence' }
  | { key: string; reason: 'invalid_evidence_packet'; detail: string }
  | { key: string; reason: 'lifecycle_gate_after_enrichment' }
  | { key: string; reason: 'evidence_image_unavailable'; error: unknown };

export interface SelectConjectureCandidatesInput {
  failures: FailureAttempt[];
  reasoningTraceByAttemptId: ReadonlyMap<string, string | null>;
  masteryByKnowledgeId: ReadonlyMap<string, ConjectureMasteryProjection>;
  now: Date;
  /**
   * Final top-K cut. Enrichment stops once the validated top-K is provably settled.
   * `null` enriches every lifecycle-eligible cell and returns all of them.
   */
  limit: number | null;
  imageFetchFn: ConjectureImageFetchFn;
  loadKnownConjectureKeysFn?: (db: Db) => Promise<Set<string>>;
}

export interface ConjectureCandidateSelection {
  /** Cause×KC keys with a pending conjecture (the first dedup base). */
  pendingConjectureCount: number;
  rawCellCount: number;
  lifecycleEligibleCount: number;
  /** Cells that passed the reproducible-evidence filter in the batches actually enriched. */
  reproducibleCellCount: number;
  /** Accountability-ranked, at most `limit` long. */
  candidates: ConjectureCandidate[];
  exclusions: ConjectureCandidateExclusion[];
}

/** Pending-conjecture dedup before the owner-decision/terminal history gate. */
async function loadPendingConjectureKeys(db: Db): Promise<Set<string>> {
  const rows = await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' });
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.payload.kind === 'conjecture') {
      const change = row.payload.proposed_change;
      keys.add(conjectureKey(change.cause_category, change.knowledge_id));
    }
  }
  return keys;
}

function invalidEvidencePacketDetail(cell: EnrichedEvidenceCell): string | null {
  if (cell.samples.length === 0) return 'enrichment produced no reviewable evidence samples';
  for (const sample of cell.samples) {
    if (sample.question_prompt_md === null) {
      return `attempt ${sample.attempt_event_id} is missing question_prompt_md`;
    }
    if (sample.cause_category === null) {
      return `attempt ${sample.attempt_event_id} is missing an effective cause_category`;
    }
    if (sample.cause_source === null) {
      return `attempt ${sample.attempt_event_id} is missing an effective cause_source`;
    }
  }
  return null;
}

export async function selectConjectureCandidates(
  db: Db,
  input: SelectConjectureCandidatesInput,
): Promise<ConjectureCandidateSelection> {
  const { failures, reasoningTraceByAttemptId, masteryByKnowledgeId, now, limit } = input;
  const loadKnownConjectureKeysFn = input.loadKnownConjectureKeysFn ?? loadPendingConjectureKeys;
  const knownConjectureKeys = await loadKnownConjectureKeysFn(db);

  const gatheredCells = gatherConjectureEvidence({
    failures,
    masteryByKnowledgeId,
    knownConjectureKeys,
  });
  const historyByKey =
    gatheredCells.length > 0
      ? await loadConjectureHistory(db, gatheredCells)
      : new Map<string, ConjectureHistory>();
  const historyGate = applyConjectureHistoryGate(gatheredCells, failures, historyByKey, now);
  const accountabilityByKey =
    historyGate.cells.length > 0
      ? await loadPredictionAccountabilityByKey(db, historyGate.cells)
      : new Map<string, PredictionAccountability>();
  const cells = rankEvidenceCellsByAccountability(historyGate.cells, accountabilityByKey);

  // Enrich in bounded salience batches and refill from lower-ranked cells when mutable or
  // missing question context leaves a candidate ungrounded. Raw recurrence is only an
  // UPPER BOUND: after enrichment validates the immutable evidence ids, re-apply
  // accountability to the reproducible count before the final cut. Enrichment DB faults
  // propagate; only cell-local evidence/image defects become exclusions.
  const batchSize = limit ?? UNCAPPED_ENRICH_BATCH_SIZE;
  const prepared: ConjectureCandidate[] = [];
  const exclusions: ConjectureCandidateExclusion[] = [];
  let reproducibleCellCount = 0;
  let cellOffset = 0;
  while (cellOffset < cells.length) {
    const batch = cells.slice(cellOffset, cellOffset + batchSize);
    cellOffset += batch.length;
    const enriched = await enrichEvidenceCells(db, {
      cells: batch,
      failures,
      reasoningTraceByAttemptId,
    });
    const reproducibleCells: EnrichedEvidenceCell[] = [];
    for (const cell of enriched) {
      // Recurrence is a claim about reproducible historical context, not the raw attempt
      // tally. Enrichment validates every attempt and keeps all reproducible ids even
      // though prompt text samples are capped.
      const evidenceEventIds = [...new Set(cell.evidence_event_ids)];
      if (evidenceEventIds.length < CONJECTURE_RECURRENCE_FLOOR) {
        exclusions.push({ key: cell.key, reason: 'non_reproducible_evidence' });
        continue;
      }
      const reproducible = {
        ...cell,
        recurrence_count: evidenceEventIds.length,
        evidence_event_ids: evidenceEventIds,
      };
      // A sample without its prompt or cause cannot ground a claim; drop the cell here so
      // it never reaches paid induction and a lower-ranked cell can take its slot.
      const invalidDetail = invalidEvidencePacketDetail(reproducible);
      if (invalidDetail) {
        exclusions.push({
          key: cell.key,
          reason: 'invalid_evidence_packet',
          detail: invalidDetail,
        });
        continue;
      }
      reproducibleCells.push(reproducible);
    }
    reproducibleCellCount += reproducibleCells.length;

    // A terminal conjecture may clear the raw two-fresh-failures gate before enrichment
    // removes a missing/mutated attempt. Re-run the lifecycle gate over only reproducible
    // ids so older pre-terminal evidence cannot substitute for post-terminal failures.
    const reproducibleHistoryGate = applyConjectureHistoryGate(
      reproducibleCells,
      failures,
      historyByKey,
      now,
    );
    const secondGateKeys = new Set(reproducibleHistoryGate.cells.map((cell) => cell.key));
    for (const cell of reproducibleCells) {
      if (!secondGateKeys.has(cell.key)) {
        exclusions.push({ key: cell.key, reason: 'lifecycle_gate_after_enrichment' });
      }
    }
    const imageResults = await Promise.allSettled(
      reproducibleHistoryGate.cells.map((cell) =>
        loadConjectureEvidenceImages(
          db,
          collectConjectureEvidenceAssetRefs(cell),
          input.imageFetchFn,
        ),
      ),
    );
    for (const [index, result] of imageResults.entries()) {
      const cell = reproducibleHistoryGate.cells[index];
      if (!cell) throw new Error(`conjecture candidate image result missing cell at ${index}`);
      if (result.status === 'fulfilled') {
        prepared.push({
          cell,
          evidenceImages: result.value,
          priorClaimMd: reproducibleHistoryGate.priorClaimMdByKey.get(cell.key) ?? null,
        });
      } else {
        // A deterministic bad/missing asset must not occupy a top-K slot; a lower
        // candidate can still take it.
        exclusions.push({
          key: cell.key,
          reason: 'evidence_image_unavailable',
          error: result.reason,
        });
      }
    }
    if (limit !== null && prepared.length >= limit) {
      const preparedKeys = new Set(prepared.map((candidate) => candidate.cell.key));
      // Unprocessed cells retain their raw recurrence count as an upper bound, so this
      // early stop can only enrich an extra batch — never skip a validated top-K cell.
      const bestPossibleTopKeys = rankEvidenceCellsByAccountability<EvidenceCell>(
        [...prepared.map((candidate) => candidate.cell), ...cells.slice(cellOffset)],
        accountabilityByKey,
      )
        .slice(0, limit)
        .map((candidate) => candidate.key);
      if (bestPossibleTopKeys.every((key) => preparedKeys.has(key))) break;
    }
  }

  const preparedByKey = new Map(prepared.map((candidate) => [candidate.cell.key, candidate]));
  const ranked = rankEvidenceCellsByAccountability(
    prepared.map((candidate) => candidate.cell),
    accountabilityByKey,
  );
  const candidates = (limit === null ? ranked : ranked.slice(0, limit)).map((cell) => {
    const candidate = preparedByKey.get(cell.key);
    if (!candidate) throw new Error(`conjecture candidate missing for ${cell.key}`);
    return candidate;
  });

  return {
    pendingConjectureCount: knownConjectureKeys.size,
    rawCellCount: gatheredCells.length,
    lifecycleEligibleCount: cells.length,
    reproducibleCellCount,
    candidates,
    exclusions,
  };
}
