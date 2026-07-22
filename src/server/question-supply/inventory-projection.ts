import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { isPoolVisible } from '@/db/predicates';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  COVERAGE_DEPTH_THRESHOLD,
  type QuestionSupplyTarget,
  type ScanInput,
} from './target-discovery';

export const EVIDENCE_INVENTORY_VERSION = 1 as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const PIPELINE_COMMITMENT_TTL_DAYS = 7;
// Dispatch events are fetched over a wider window than the commitment TTL so the projection can
// still surface recently-expired commitments (expiredPipelineCommitments) for diagnostics. Events
// older than the TTL yield commitments whose expiresAt is already past `now`, so they only feed the
// expired count and are never eligible as live pipeline commitments (see projectEvidenceInventory).
export const PIPELINE_COMMITMENT_LOOKBACK_DAYS = PIPELINE_COMMITMENT_TTL_DAYS * 4;
export const INVENTORY_FAMILY_PROXY_LABEL =
  'distinct_question_count_upper_bound_not_family_truth' as const;

export type InventoryRecommendation = 'stop' | 'wait' | 'produce';

export interface InventoryQuestionInput {
  id: string;
  /** Pool-visible and not otherwise quarantined. */
  ready: boolean;
  exposureBlocked?: boolean;
  quarantined?: boolean;
  expired?: boolean;
  /** Missing allowed-use metadata is an explicit Phase-A fail-open assumption. */
  allowedUseEligible?: boolean;
}

export interface PipelineCommitmentInput {
  id: string;
  expiresAt: Date;
  /** Number of candidate slots promised by this dispatch; legacy events default to one. */
  count?: number;
}

export interface InventoryProjectionInput {
  subjectId: string;
  knowledgeId: string;
  eligibleGoal: number;
  now: Date;
  questions: InventoryQuestionInput[];
  commitments: PipelineCommitmentInput[];
}

export interface EvidenceInventoryProjection {
  version: typeof EVIDENCE_INVENTORY_VERSION;
  subjectId: string;
  knowledgeId: string;
  eligibleGoal: number;
  ready: number;
  eligibleOnHand: number;
  exposureBlocked: number;
  quarantined: number;
  expired: number;
  pipelineCommitments: number;
  expiredPipelineCommitments: number;
  deficit: number;
  uncoveredDeficitAfterPipeline: number;
  recommendation: InventoryRecommendation;
  distinctQuestionUpperBoundFamilyProxy: number;
  familyProxyLabel: typeof INVENTORY_FAMILY_PROXY_LABEL;
  assumptions: {
    missingAllowedUse: 'eligible';
    missingExposureState: 'unblocked';
    pipelineCommitmentCountsAsOnHand: false;
  };
}

export interface InventoryShadowComparison {
  version: typeof EVIDENCE_INVENTORY_VERSION;
  subjectId: string;
  knowledgeId: string;
  currentRecommendation: 'stop' | 'produce';
  shadowRecommendation: InventoryRecommendation;
  agrees: boolean;
  projection: EvidenceInventoryProjection;
}

/**
 * EvidenceInventory v1 is an observe-only projection. It never changes the current target scanner,
 * selection order, dispatch path, or draft/active semantics. In particular, a live commitment may
 * suppress duplicate production in the shadow recommendation but is never eligible on-hand.
 */
export function projectEvidenceInventory(
  input: InventoryProjectionInput,
): EvidenceInventoryProjection {
  const quarantinedIds = new Set(
    input.questions.filter((item) => item.quarantined === true).map((item) => item.id),
  );
  const expiredIds = new Set(
    input.questions.filter((item) => item.expired === true).map((item) => item.id),
  );
  const readyQuestions = input.questions.filter(
    (item) => item.ready && !quarantinedIds.has(item.id) && !expiredIds.has(item.id),
  );
  const exposureBlocked = new Set(
    readyQuestions.filter((item) => item.exposureBlocked === true).map((item) => item.id),
  );
  const eligibleIds = new Set(
    readyQuestions
      .filter((item) => !exposureBlocked.has(item.id) && item.allowedUseEligible !== false)
      .map((item) => item.id),
  );
  const liveCommitments = input.commitments.filter(
    (commitment) => commitment.expiresAt.getTime() > input.now.getTime(),
  );
  const liveCommitmentCount = liveCommitments.reduce(
    (sum, commitment) => sum + Math.max(1, Math.floor(commitment.count ?? 1)),
    0,
  );
  const expiredCommitmentCount = input.commitments
    .filter((commitment) => commitment.expiresAt.getTime() <= input.now.getTime())
    .reduce((sum, commitment) => sum + Math.max(1, Math.floor(commitment.count ?? 1)), 0);
  const deficit = Math.max(0, input.eligibleGoal - eligibleIds.size);
  const uncoveredDeficitAfterPipeline = Math.max(0, deficit - liveCommitmentCount);
  const recommendation: InventoryRecommendation =
    deficit === 0 ? 'stop' : uncoveredDeficitAfterPipeline === 0 ? 'wait' : 'produce';

  return {
    version: EVIDENCE_INVENTORY_VERSION,
    subjectId: input.subjectId,
    knowledgeId: input.knowledgeId,
    eligibleGoal: input.eligibleGoal,
    ready: new Set(readyQuestions.map((item) => item.id)).size,
    eligibleOnHand: eligibleIds.size,
    exposureBlocked: exposureBlocked.size,
    quarantined: quarantinedIds.size,
    expired: expiredIds.size,
    pipelineCommitments: liveCommitmentCount,
    expiredPipelineCommitments: expiredCommitmentCount,
    deficit,
    uncoveredDeficitAfterPipeline,
    recommendation,
    // A question may later prove related to another question. Until a real family identity exists,
    // distinct eligible rows are only an upper bound and are labeled as such at the API boundary.
    distinctQuestionUpperBoundFamilyProxy: eligibleIds.size,
    familyProxyLabel: INVENTORY_FAMILY_PROXY_LABEL,
    assumptions: {
      missingAllowedUse: 'eligible',
      missingExposureState: 'unblocked',
      pipelineCommitmentCountsAsOnHand: false,
    },
  };
}

/** Compare settled current scanner output with the shadow projection; neither side is mutated. */
export function compareInventoryShadow(
  currentTargets: QuestionSupplyTarget[],
  projections: EvidenceInventoryProjection[],
): InventoryShadowComparison[] {
  return projections.map((projection) => {
    const currentRecommendation = currentTargets.some(
      (target) =>
        target.subjectId === projection.subjectId &&
        target.knowledgeIds.includes(projection.knowledgeId),
    )
      ? 'produce'
      : 'stop';
    return {
      version: EVIDENCE_INVENTORY_VERSION,
      subjectId: projection.subjectId,
      knowledgeId: projection.knowledgeId,
      currentRecommendation,
      shadowRecommendation: projection.recommendation,
      agrees: currentRecommendation === projection.recommendation,
      projection,
    };
  });
}

interface LoadInventoryProjectionOptions {
  subjectId: string;
  knowledgeId: string;
  eligibleGoal: number;
  now?: Date;
  allowedUse?: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalDate(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function commitmentFingerprint(metadata: Record<string, unknown> | null): string | null {
  const trace = metadata?.supply_trace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
  const fingerprint = (trace as Record<string, unknown>).target_fingerprint;
  return typeof fingerprint === 'string' ? fingerprint : null;
}

/**
 * IO loader kept separate from the pure projection. Phase A reads existing question/event facts;
 * it creates no family, qualification, inventory, or production-attempt table.
 */
export async function loadInventoryProjectionInput(
  db: Db,
  options: LoadInventoryProjectionOptions,
): Promise<InventoryProjectionInput> {
  const now = options.now ?? new Date();
  const rows = await db
    .select({
      id: question.id,
      draft_status: question.draft_status,
      metadata: question.metadata,
    })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([options.knowledgeId])}::jsonb`);

  const questions: InventoryQuestionInput[] = rows.map((row) => {
    const metadata = row.metadata ?? {};
    const archivedAt = optionalDate(metadata.archived_at);
    const expiresAt = optionalDate(metadata.expires_at ?? metadata.expired_at);
    const allowedUses = stringArray(metadata.allowed_uses);
    const quarantined = row.draft_status === 'draft' || archivedAt !== null;
    return {
      id: row.id,
      ready: isPoolVisible(row) && !quarantined,
      exposureBlocked: metadata.exposure_blocked === true,
      quarantined,
      expired: expiresAt !== null && expiresAt.getTime() <= now.getTime(),
      allowedUseEligible:
        allowedUses.length === 0 || allowedUses.includes(options.allowedUse ?? 'practice'),
    };
  });

  const fulfilledFingerprints = new Set(
    rows
      .map((row) => commitmentFingerprint(row.metadata))
      .filter((value): value is string => !!value),
  );
  const horizon = new Date(now.getTime() - PIPELINE_COMMITMENT_LOOKBACK_DAYS * MS_PER_DAY);
  const dispatches = await db
    .select({ id: event.id, payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:question_supply'),
        gte(event.created_at, horizon),
        sql`${event.payload} @> ${JSON.stringify({
          status: 'dispatched',
          subject_id: options.subjectId,
          knowledge_ids: [options.knowledgeId],
        })}::jsonb`,
      ),
    );
  const commitmentsByFingerprint = new Map<string, PipelineCommitmentInput>();
  for (const row of dispatches) {
    const fingerprint = row.payload.fingerprint;
    if (typeof fingerprint !== 'string' || fulfilledFingerprints.has(fingerprint)) continue;
    const expiresAt = new Date(
      row.created_at.getTime() + PIPELINE_COMMITMENT_TTL_DAYS * MS_PER_DAY,
    );
    const desiredCount = row.payload.desired_count;
    const count =
      typeof desiredCount === 'number' && Number.isInteger(desiredCount) && desiredCount > 0
        ? desiredCount
        : 1;
    const existing = commitmentsByFingerprint.get(fingerprint);
    if (!existing || existing.expiresAt < expiresAt) {
      commitmentsByFingerprint.set(fingerprint, { id: fingerprint, expiresAt, count });
    }
  }

  return {
    subjectId: options.subjectId,
    knowledgeId: options.knowledgeId,
    eligibleGoal: options.eligibleGoal,
    now,
    questions,
    commitments: [...commitmentsByFingerprint.values()],
  };
}

/** Durable observe-only dual-read ledger. It has no dispatcher or selection dependency. */
export async function writeInventoryShadowComparisonEvents(
  db: Db,
  comparisons: InventoryShadowComparison[],
  now = new Date(),
): Promise<void> {
  // Independent observe-only inserts (each with its own newId); write them concurrently. The
  // concurrent fan-out is bounded — a nightly observe-only scan over a bounded frontier on a
  // single-user deployment with a local connection pool — so it needs no batching/throttle.
  await Promise.all(
    comparisons.map((comparison) =>
      writeEvent(db, {
        id: newId(),
        actor_kind: 'system',
        actor_ref: 'question_supply_inventory_shadow',
        action: 'experimental:supply_inventory_shadow',
        subject_kind: 'knowledge',
        subject_id: comparison.knowledgeId,
        outcome: comparison.agrees ? 'success' : 'partial',
        payload: comparison,
        ingest_at: now,
        created_at: now,
      }),
    ),
  );
}

/**
 * Adapter for `discoverSupplyTargets(..., { observeInventory })`. Current scanner targets are
 * already settled before this runs; projections are then loaded, compared, and written only to
 * an internal diagnostic ledger. YUK-697 can reuse the loader boundary without becoming inventory
 * truth or requiring a Phase-B family table.
 */
export async function runInventoryShadowDualRead(
  db: Db,
  input: ScanInput,
  currentTargets: QuestionSupplyTarget[],
  now = new Date(),
): Promise<InventoryShadowComparison[]> {
  // Per-item isolation: this is an observe-only diagnostic path, so one frontier item's failed
  // projection load must not reject the whole batch and blank every other item's shadow comparison.
  // Skip the failed item (warn) and keep the rest.
  const projections = (
    await Promise.all(
      input.frontier.map(async (frontier) => {
        try {
          return projectEvidenceInventory(
            await loadInventoryProjectionInput(db, {
              subjectId: frontier.subjectId,
              knowledgeId: frontier.knowledgeId,
              eligibleGoal: COVERAGE_DEPTH_THRESHOLD,
              now,
            }),
          );
        } catch (err) {
          console.warn(
            `[supply-inventory-shadow] projection failed for knowledge ${frontier.knowledgeId} (subject ${frontier.subjectId}); skipping this frontier item:`,
            err,
          );
          return null;
        }
      }),
    )
  ).filter((projection): projection is EvidenceInventoryProjection => projection !== null);
  const comparisons = compareInventoryShadow(currentTargets, projections);
  await writeInventoryShadowComparisonEvents(db, comparisons, now);
  return comparisons;
}
