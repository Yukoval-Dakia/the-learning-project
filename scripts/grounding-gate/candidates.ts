import { inArray } from 'drizzle-orm';
import {
  type ConjectureCandidate,
  type ConjectureImageFetchFn,
  selectConjectureCandidates,
} from '@/capabilities/agency/public';
import type { FailureAttempt } from '@/capabilities/knowledge/public';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import {
  type FailureAttemptWithReasoningTrace,
  getFailureAttemptsWithReasoningTraceForDerivation,
} from '@/kernel/read-models/failure-attempts';
import {
  abilityReadingsByIdOrFail,
  readLearnerJudgments,
} from '@/kernel/read-models/learner-judgment';

export const GROUNDING_GATE_WINDOW_DAYS = 14;

export interface GroundingGateCandidate {
  cell: ConjectureCandidate['cell'];
  evidence_images: ConjectureCandidate['evidenceImages'];
  prior_claim_md: string | null;
}

export interface GroundingGateExclusion {
  key: string;
  reason:
    | 'non_reproducible_evidence'
    | 'invalid_evidence_packet'
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

export interface CollectGroundingGateCandidatesOptions {
  now: Date;
  imageFetchFn: ConjectureImageFetchFn;
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

function asErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Read-only grounding-gate preparation path.
 *
 * Deliberately reuses the production candidate selection. The only policy difference from
 * the nightly writer is that every eligible cell is returned (no top-3 cut), so the blind
 * set can be sampled. Nothing is written here.
 */
export async function collectGroundingGateCandidates(
  db: Db,
  options: CollectGroundingGateCandidatesOptions,
): Promise<GroundingGateCandidateReport> {
  const { now, imageFetchFn } = options;
  const since = new Date(now.getTime() - GROUNDING_GATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const loadedRows = await getFailureAttemptsWithReasoningTraceForDerivation(db, {
    includeReviewFailures: true,
    since,
    limit: null,
  });
  const { realRows, syntheticCount } = await filterSyntheticFailures(db, loadedRows);
  const failures: FailureAttempt[] = realRows.map((row) => row.failure);
  const reasoningTraceByAttemptId = new Map(
    realRows.map((row) => [row.failure.attempt_event_id, row.reasoning_trace]),
  );
  const knowledgeIds = [
    ...new Set(failures.flatMap((failure) => failure.referenced_knowledge_ids)),
  ];
  // Probe-topic mastery is evidenced ability only. Insufficient evidence is
  // absent, so selection probes it as unknown instead of a cold-start prior.
  const judgmentBatch = await readLearnerJudgments(db, {
    knowledge_ids: knowledgeIds,
    context: 'any',
    as_of: new Date(),
  });
  const masteryByKnowledgeId = abilityReadingsByIdOrFail(judgmentBatch);

  // Enrichment DB failures fail the whole run. Silently dropping a batch would bias the
  // sampled population, so only deterministic cell-local evidence/image defects become
  // exclusions.
  const selection = await selectConjectureCandidates(db, {
    failures,
    reasoningTraceByAttemptId,
    masteryByKnowledgeId,
    now,
    limit: null,
    imageFetchFn,
  });
  const exclusions: GroundingGateExclusion[] = selection.exclusions.map((exclusion) => {
    switch (exclusion.reason) {
      case 'invalid_evidence_packet':
        return { key: exclusion.key, reason: exclusion.reason, detail: exclusion.detail };
      case 'evidence_image_unavailable':
        return {
          key: exclusion.key,
          reason: exclusion.reason,
          detail: asErrorDetail(exclusion.error),
        };
      default:
        return { key: exclusion.key, reason: exclusion.reason };
    }
  });

  return {
    now,
    since,
    recent_failure_count: realRows.length,
    synthetic_failure_count: syntheticCount,
    raw_cell_count: selection.rawCellCount,
    lifecycle_eligible_count: selection.lifecycleEligibleCount,
    reproducible_cell_count: selection.reproducibleCellCount,
    eligible_count: selection.candidates.length,
    pending_conjecture_count: selection.pendingConjectureCount,
    candidates: selection.candidates.map((candidate) => ({
      cell: candidate.cell,
      evidence_images: candidate.evidenceImages,
      prior_claim_md: candidate.priorClaimMd,
    })),
    exclusions,
  };
}
