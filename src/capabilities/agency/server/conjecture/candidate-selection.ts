// Research-meeting candidate selection: the one owner of the order
// gather → abstention replay → history gate → note-weighted accountability rank →
// batched enrichment → reproducible + complete-evidence filter → abstention replay
// on the reproducible ids → second history gate → image load → final rank.
// Read-only: no transaction, no lock; callers own durability and execution locks.

import type { Db } from '@/db/client';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import {
  type AgentNoteInput,
  agentNoteInputs,
  readAgentNotes,
} from '@/kernel/read-models/agent-note-hints';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import {
  type ReopenedAbstention,
  decideAbstentionReplay,
  loadSemanticAbstentionsByCell,
  reopenedAbstention,
} from './abstention';
import {
  type PredictionAccountability,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from './accountability';
import {
  type ContrastCorrectSample,
  contrastSamplesForCell,
  loadContrastCorrectSamples,
} from './contrast-correct';
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
import { researchMeetingNoteWeight } from './meeting-notes';

/** Enrichment batch for uncapped selections; capped selections batch at their top-K size. */
const UNCAPPED_ENRICH_BATCH_SIZE = 3;

export interface ConjectureCandidate {
  cell: EnrichedEvidenceCell;
  evidenceImages: LoadedConjectureEvidenceImage[];
  priorClaimMd: string | null;
  /** Set when this cell was abstained and tonight has failure ids the abstention had not seen. */
  priorAbstention: ReopenedAbstention | null;
  contrastCorrectSamples: ContrastCorrectSample[];
  agentNotes: AgentNoteInput[];
}

export type ConjectureCandidateExclusion =
  | { key: string; reason: 'non_reproducible_evidence' }
  | { key: string; reason: 'invalid_evidence_packet'; detail: string }
  | { key: string; reason: 'lifecycle_gate_after_enrichment' }
  | { key: string; reason: 'evidence_image_unavailable'; error: unknown }
  | { key: string; reason: 'abstained_without_new_evidence' };

export interface SelectConjectureCandidatesInput {
  failures: FailureAttempt[];
  reasoningTraceByAttemptId: ReadonlyMap<string, string | null>;
  masteryByKnowledgeId: ReadonlyMap<string, ConjectureMasteryProjection>;
  now: Date;
  /** Correct-answer window. Same bound the caller used for the failure scan. */
  since: Date;
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
  const { failures, reasoningTraceByAttemptId, masteryByKnowledgeId, now, since, limit } = input;
  const loadKnownConjectureKeysFn = input.loadKnownConjectureKeysFn ?? loadPendingConjectureKeys;
  const knownConjectureKeys = await loadKnownConjectureKeysFn(db);

  const gatheredCells = gatherConjectureEvidence({
    failures,
    masteryByKnowledgeId,
    knownConjectureKeys,
  });
  const exclusions: ConjectureCandidateExclusion[] = [];
  const abstentionByKey =
    gatheredCells.length > 0 ? await loadSemanticAbstentionsByCell(db, gatheredCells) : new Map();
  const meetingNotes =
    gatheredCells.length > 0
      ? await readAgentNotes(db, { for_agent: 'research_meeting', now })
      : [];
  const abstentionKept: EvidenceCell[] = [];
  for (const cell of gatheredCells) {
    const replay = decideAbstentionReplay(
      cell.evidence_event_ids,
      abstentionByKey.get(cell.key) ?? null,
    );
    if (replay.kind === 'skip_unchanged') {
      exclusions.push({ key: cell.key, reason: 'abstained_without_new_evidence' });
      continue;
    }
    abstentionKept.push(cell);
  }
  const historyByKey =
    abstentionKept.length > 0
      ? await loadConjectureHistory(db, abstentionKept)
      : new Map<string, ConjectureHistory>();
  const historyGate = applyConjectureHistoryGate(abstentionKept, failures, historyByKey, now);
  const accountabilityByKey =
    historyGate.cells.length > 0
      ? await loadPredictionAccountabilityByKey(db, historyGate.cells)
      : new Map<string, PredictionAccountability>();
  const noteWeightByKey = new Map(
    historyGate.cells.map(
      (cell) => [cell.key, researchMeetingNoteWeight(cell, meetingNotes)] as const,
    ),
  );
  const cells = rankEvidenceCellsByAccountability(
    historyGate.cells,
    accountabilityByKey,
    noteWeightByKey,
  );
  const contrastByKnowledge =
    cells.length > 0
      ? await loadContrastCorrectSamples(db, {
          knowledgeIds: [...new Set(cells.map((cell) => cell.knowledge_id))],
          since,
        })
      : new Map<string, ContrastCorrectSample[]>();
  const agentNotes = agentNoteInputs(meetingNotes);

  // Enrich in bounded salience batches and refill from lower-ranked cells when mutable or
  // missing question context leaves a candidate ungrounded. Raw recurrence is only an
  // UPPER BOUND: after enrichment validates the immutable evidence ids, re-apply
  // accountability to the reproducible count before the final cut. Enrichment DB faults
  // propagate; only cell-local evidence/image defects become exclusions.
  const batchSize = limit ?? UNCAPPED_ENRICH_BATCH_SIZE;
  const prepared: ConjectureCandidate[] = [];
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

    // Enrichment can drop the only failure id that was new since the abstention.
    // Re-check against the ids that would actually be shown, and free the slot.
    const openCells: EnrichedEvidenceCell[] = [];
    for (const cell of reproducibleCells) {
      const replay = decideAbstentionReplay(
        cell.evidence_event_ids,
        abstentionByKey.get(cell.key) ?? null,
      );
      if (replay.kind === 'skip_unchanged') {
        exclusions.push({ key: cell.key, reason: 'abstained_without_new_evidence' });
        continue;
      }
      openCells.push(cell);
    }

    // A terminal conjecture may clear the raw two-fresh-failures gate before enrichment
    // removes a missing/mutated attempt. Re-run the lifecycle gate over only reproducible
    // ids so older pre-terminal evidence cannot substitute for post-terminal failures.
    const reproducibleHistoryGate = applyConjectureHistoryGate(
      openCells,
      failures,
      historyByKey,
      now,
    );
    const secondGateKeys = new Set(reproducibleHistoryGate.cells.map((cell) => cell.key));
    for (const cell of openCells) {
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
          priorAbstention: reopenedAbstention(
            decideAbstentionReplay(cell.evidence_event_ids, abstentionByKey.get(cell.key) ?? null),
          ),
          contrastCorrectSamples: contrastSamplesForCell(cell, contrastByKnowledge),
          agentNotes,
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
        noteWeightByKey,
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
    noteWeightByKey,
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
