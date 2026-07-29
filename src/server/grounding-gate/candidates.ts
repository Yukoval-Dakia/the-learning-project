import {
  type ConjectureEvidenceAssetRef,
  type EnrichedEvidenceCell,
  type EvidenceCell,
  type LoadedConjectureEvidenceImage,
  collectConjectureEvidenceAssetRefs,
  conjectureKey,
  gatherConjectureEvidence,
} from '@/capabilities/agency/server/conjecture/evidence';
import { enrichEvidenceCells } from '@/capabilities/agency/server/conjecture/evidence-enrichment';
import {
  type ConjectureHistory,
  applyConjectureHistoryGate,
  loadConjectureHistory,
} from '@/capabilities/agency/server/conjecture/history';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import {
  type PredictionAccountability,
  loadPredictionAccountabilityByKey,
  rankEvidenceCellsByAccountability,
} from '@/server/conjectures/accountability';
import {
  type FailureAttempt,
  type FailureAttemptWithReasoningTrace,
  getFailureAttemptsWithReasoningTrace,
} from '@/server/events/queries';
import { getMasteryProjection } from '@/server/mastery/state';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { inArray } from 'drizzle-orm';

export const GROUNDING_GATE_WINDOW_DAYS = 14;
export const GROUNDING_GATE_ENRICH_BATCH_SIZE = 3;

export interface GroundingGateCandidate {
  cell: EnrichedEvidenceCell;
  evidence_images: LoadedConjectureEvidenceImage[];
  prior_claim_md: string | null;
}

export interface GroundingGateExclusion {
  key: string;
  reason:
    | 'non_reproducible_evidence'
    | 'lifecycle_gate_after_enrichment'
    | 'evidence_image_unavailable';
  detail?: string;
}

export interface GroundingGateCandidateReport {
  now: Date;
  since: Date;
  recent_failure_count: number;
  synthetic_failure_count: number;
  raw_cell_count: number;
  lifecycle_eligible_count: number;
  reproducible_cell_count: number;
  eligible_count: number;
  pending_conjecture_count: number;
  candidates: GroundingGateCandidate[];
  exclusions: GroundingGateExclusion[];
}

export type LoadGroundingEvidenceImages = (
  db: Db,
  refs: readonly ConjectureEvidenceAssetRef[],
) => Promise<LoadedConjectureEvidenceImage[]>;

export interface CollectGroundingGateCandidatesOptions {
  now: Date;
  loadEvidenceImages: LoadGroundingEvidenceImages;
}

async function loadKnownConjectureKeys(db: Db): Promise<Set<string>> {
  const rows = await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' });
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.payload.kind !== 'conjecture') continue;
    const change = row.payload.proposed_change;
    keys.add(conjectureKey(change.cause_category, change.knowledge_id));
  }
  return keys;
}

function isSyntheticNamespace(value: string): boolean {
  return value.startsWith('synthetic:');
}

async function filterSyntheticFailures(
  db: Db,
  rows: FailureAttemptWithReasoningTrace[],
): Promise<{
  realRows: FailureAttemptWithReasoningTrace[];
  syntheticCount: number;
}> {
  if (rows.length === 0) return { realRows: [], syntheticCount: 0 };
  const ids = rows.map((row) => row.failure.attempt_event_id);
  const sourceRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, ids));
  const syntheticById = new Map(
    sourceRows.map((row) => [
      row.id,
      (row.payload as { __synthetic?: unknown } | null)?.__synthetic === true,
    ]),
  );
  const realRows = rows.filter(({ failure }) => {
    if (syntheticById.get(failure.attempt_event_id) === true) return false;
    if (isSyntheticNamespace(failure.attempt_event_id)) return false;
    if (isSyntheticNamespace(failure.question_id)) return false;
    return !failure.referenced_knowledge_ids.some(isSyntheticNamespace);
  });
  return { realRows, syntheticCount: rows.length - realRows.length };
}

function withReproducibleEvidence(cell: EnrichedEvidenceCell): EnrichedEvidenceCell | null {
  const evidenceEventIds = [...new Set(cell.evidence_event_ids)];
  if (evidenceEventIds.length < 2) return null;
  return {
    ...cell,
    recurrence_count: evidenceEventIds.length,
    evidence_event_ids: evidenceEventIds,
  };
}

function asErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Read-only YUK-814 preparation path.
 *
 * This deliberately reuses the production readers/folds/gates. The only policy
 * difference from the nightly writer is that every eligible cell is returned so
 * the blind set can be selected without a permanent top-3 cut. No proposal,
 * event, rate, or product projection is written here.
 */
export async function collectGroundingGateCandidates(
  db: Db,
  options: CollectGroundingGateCandidatesOptions,
): Promise<GroundingGateCandidateReport> {
  const { now, loadEvidenceImages } = options;
  const since = new Date(now.getTime() - GROUNDING_GATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const loadedRows = await getFailureAttemptsWithReasoningTrace(db, {
    includeReviewFailures: true,
    since,
  });
  const { realRows, syntheticCount } = await filterSyntheticFailures(db, loadedRows);
  const failures: FailureAttempt[] = realRows.map((row) => row.failure);
  const reasoningTraceByAttemptId = new Map(
    realRows.map((row) => [row.failure.attempt_event_id, row.reasoning_trace]),
  );
  const knowledgeIds = [
    ...new Set(failures.flatMap((failure) => failure.referenced_knowledge_ids)),
  ];
  const [masteryByKnowledgeId, knownConjectureKeys] = await Promise.all([
    knowledgeIds.length > 0 ? getMasteryProjection(db, knowledgeIds) : Promise.resolve(new Map()),
    loadKnownConjectureKeys(db),
  ]);

  const rawCells = gatherConjectureEvidence({
    failures,
    masteryByKnowledgeId,
    knownConjectureKeys,
  });
  const historyByKey: Map<string, ConjectureHistory> =
    rawCells.length > 0 ? await loadConjectureHistory(db, rawCells) : new Map();
  const firstHistoryGate = applyConjectureHistoryGate(rawCells, failures, historyByKey, now);
  const accountabilityByKey: Map<string, PredictionAccountability> =
    firstHistoryGate.cells.length > 0
      ? await loadPredictionAccountabilityByKey(db, firstHistoryGate.cells)
      : new Map();
  const rankedCells = rankEvidenceCellsByAccountability(
    firstHistoryGate.cells,
    accountabilityByKey,
  );

  const candidates: GroundingGateCandidate[] = [];
  const exclusions: GroundingGateExclusion[] = [];
  let reproducibleCellCount = 0;
  for (let offset = 0; offset < rankedCells.length; offset += GROUNDING_GATE_ENRICH_BATCH_SIZE) {
    const batch = rankedCells.slice(offset, offset + GROUNDING_GATE_ENRICH_BATCH_SIZE);
    const enriched = await enrichEvidenceCells(db, {
      cells: batch,
      failures,
      reasoningTraceByAttemptId,
    });
    const reproducible: EnrichedEvidenceCell[] = [];
    for (const cell of enriched) {
      const normalized = withReproducibleEvidence(cell);
      if (normalized) {
        reproducible.push(normalized);
      } else {
        exclusions.push({ key: cell.key, reason: 'non_reproducible_evidence' });
      }
    }
    reproducibleCellCount += reproducible.length;

    const secondHistoryGate = applyConjectureHistoryGate(reproducible, failures, historyByKey, now);
    const secondGateKeys = new Set(secondHistoryGate.cells.map((cell) => cell.key));
    for (const cell of reproducible) {
      if (!secondGateKeys.has(cell.key)) {
        exclusions.push({ key: cell.key, reason: 'lifecycle_gate_after_enrichment' });
      }
    }
    for (const cell of secondHistoryGate.cells) {
      try {
        const refs = collectConjectureEvidenceAssetRefs(cell);
        const evidenceImages = await loadEvidenceImages(db, refs);
        candidates.push({
          cell,
          evidence_images: evidenceImages,
          prior_claim_md: secondHistoryGate.priorClaimMdByKey.get(cell.key) ?? null,
        });
      } catch (error) {
        exclusions.push({
          key: cell.key,
          reason: 'evidence_image_unavailable',
          detail: asErrorDetail(error),
        });
      }
    }
  }

  const candidateByKey = new Map(candidates.map((candidate) => [candidate.cell.key, candidate]));
  const rankedCandidates = rankEvidenceCellsByAccountability(
    candidates.map((candidate) => candidate.cell),
    accountabilityByKey,
  ).map((cell) => {
    const candidate = candidateByKey.get(cell.key);
    if (!candidate) throw new Error(`grounding gate candidate missing for ${cell.key}`);
    return candidate;
  });

  return {
    now,
    since,
    recent_failure_count: realRows.length,
    synthetic_failure_count: syntheticCount,
    raw_cell_count: rawCells.length,
    lifecycle_eligible_count: rankedCells.length,
    reproducible_cell_count: reproducibleCellCount,
    eligible_count: rankedCandidates.length,
    pending_conjecture_count: knownConjectureKeys.size,
    candidates: rankedCandidates,
    exclusions,
  };
}
