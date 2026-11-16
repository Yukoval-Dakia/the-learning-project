// Nightly 教研例会 (research-meeting) propose handler.
//
// Bounded parallel producer batch (NOT an MCP tool-agent loop). The job is the SINGLE
// proposer of conjectures: it calls induceConjecture (the Opus self-consistency
// orchestrator) + writeAiProposal directly.
//
// Per run: PRE-LLM reads (recent failures with reasoning traces, per-KC mastery) →
// candidate selection, owned by conjecture `selectConjectureCandidates` (evidence
// gathering, history gate, accountability re-rank, grounding, evidence images) → per
// selected top-K cell induceConjecture → probe package → writeAiProposal.
//
// Failure asymmetry: shared PRE-LLM reads run OUTSIDE the per-cell swallow, so a throw is a
// retryable DB fault that propagates. Candidate-local grounding/image failures refill from
// lower salience; ordinary per-cell induction failures are swallowed and counted. Probe
// author/reviewer operational failures escape to pg-boss after recording health, because a
// completion marker would suppress the promised retry.
//
// Propose-only: this job NEVER writes FSRS state. The proposal snapshots predicted_p and
// baseline_p_at_induction; accept/edit remains with the owner.

import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import { selectConjectureCandidates } from '@/capabilities/agency/server/conjecture/candidate-selection';
import type { EnrichedEvidenceCell } from '@/capabilities/agency/server/conjecture/evidence';
import { RESEARCH_MEETING_SAMPLES } from '@/capabilities/agency/server/conjecture/evidence-images';
import {
  ConjectureInductionOperationalError,
  type ConjectureInductionTaskKind,
  type InduceConjectureResult,
  induceConjecture,
} from '@/capabilities/agency/server/conjecture/induce';
import {
  RESEARCH_MEETING_ACTOR,
  type ResearchMeetingReconciliationDeps,
  reconcileResearchMeetingExecution,
  scheduledEventId,
} from '@/capabilities/agency/server/conjecture/reconciliation-execution';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import { type WriteAiProposalInput, writeAiProposal } from '@/kernel/proposals/writer';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { getFailureAttemptsWithReasoningTraceForDerivation } from '@/kernel/read-models/failure-attempts';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { defaultImageFetch } from '@/kernel/records/assessment-assets';
import { type TaskTextRunFn, costUsdToMicroUsd, sumAllKnownCostUsd } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { resolveSubjectProfile } from '@/subjects/profile';
import { writeRetryableAiFailureLedger } from '../server/ai-runtime';

/** Structural per-run propose cap (top-K salient cells → at most K conjectures). */
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;
/** Recency window for the failure scan. */
export const RESEARCH_MEETING_WINDOW_DAYS = 14;

export interface ResearchMeetingResult {
  /** top-K cells inducted this run (== conjectures attempted). */
  considered: number;
  /** conjectures actually proposed (a cell whose induction failed is dropped). */
  conjectures_created: number;
  /** grounded induction completed but correctly refused to fabricate a proposal. */
  conjectures_abstained: number;
  /**
   * Cells whose induction THREW and was swallowed by the per-cell catch below.
   * Invariant: `cells_failed + conjectures_created + conjectures_abstained === considered`.
   */
  cells_failed: number;
  /** pending conjectures already open at run start (the dedup base). */
  pending_before: number;
  /** prior probe outcomes scored + ledger-updated this run. */
  reconciled: number;
  /** probe outcomes skipped this run (dangling / malformed / unreadable conjecture ref). */
  reconcile_skipped: number;
  /**
   * Cells dropped before induction because a sample lacked its prompt or cause. Counts
   * only the salience batches actually enriched (selection stops once top-K is settled).
   */
  incomplete_evidence_excluded: number;
  /** total Opus cost across the run's inductions, USD. */
  cost_usd: number | null;
  /**
   * the run's anchor event id (provenance + scan subject). `''` sentinel when the
   * run early-returned on an empty night (zero top cells → no anchor event written).
   */
  trigger_event_id: string;
}

// Durable completion payload contract: append-only and backward-compatible. Future fields
// must be optional/defaulted so already-committed executions remain readable.
const ResearchMeetingResultSchema = z
  .object({
    considered: z.number().int().nonnegative(),
    conjectures_created: z.number().int().nonnegative(),
    conjectures_abstained: z.number().int().nonnegative(),
    cells_failed: z.number().int().nonnegative(),
    pending_before: z.number().int().nonnegative(),
    reconciled: z.number().int().nonnegative(),
    reconcile_skipped: z.number().int().nonnegative(),
    incomplete_evidence_excluded: z.number().int().nonnegative().default(0),
    cost_usd: z.number().nonnegative().nullable(),
    // Empty runs have no trigger/scan anchor; the `''` sentinel persists so redelivery
    // can return the exact result.
    trigger_event_id: z.string(),
  })
  .refine(
    (result) =>
      result.conjectures_created + result.conjectures_abstained + result.cells_failed ===
      result.considered,
    { message: 'created + abstained + failed must equal considered' },
  )
  .refine((result) => (result.considered === 0) === (result.trigger_event_id === ''), {
    message: 'empty result and empty trigger_event_id must agree',
  });

type DbLike = Db | Tx;
type WriteAiProposalFn = (db: DbLike, input: WriteAiProposalInput) => Promise<string>;
type RunInTransactionFn = (db: Db, fn: (tx: DbLike) => Promise<void>) => Promise<void>;
type RunWithExecutionLockFn = <T>(db: Db, executionId: string, fn: () => Promise<T>) => Promise<T>;
type LoadCompletedRunResultFn = (
  db: Db,
  executionId: string,
) => Promise<ResearchMeetingResult | null>;
type InduceConjectureFn = typeof induceConjecture;
type GetFailureAttemptsWithTraceFn = typeof getFailureAttemptsWithReasoningTraceForDerivation;
type GetMasteryProjectionFn = typeof getMasteryProjection;
type WriteRetryableAiFailureLedgerFn = (
  db: DbLike,
  taskKind: string,
  options?: { throwOnError?: boolean },
) => Promise<void>;
type ResolveSubjectProfileFn = typeof resolveSubjectProfile;

function conjectureCellEventId(
  prefix: 'conjecture_abstained' | 'conjecture_proposal',
  executionId: string,
  cell: EnrichedEvidenceCell,
): string {
  // preparedTopCells contains at most one entry per deterministic cell.key. Hash the
  // stable input, not non-deterministic model output, so a retry cannot create a second
  // event merely by citing a different subset.
  const evidenceKey = [...cell.evidence_event_ids].sort().join('\0');
  const digest = createHash('sha256')
    .update(`${executionId}\0${cell.key}\0${evidenceKey}`)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function conjectureAbstentionEventId(executionId: string, cell: EnrichedEvidenceCell): string {
  return conjectureCellEventId('conjecture_abstained', executionId, cell);
}

function conjectureProposalEventId(executionId: string, cell: EnrichedEvidenceCell): string {
  // A concurrent pg-boss redelivery can pass the completion read while the first worker
  // is still running. The deterministic proposal id makes that race first-write-wins
  // instead of two pending conjectures for one logical cell.
  return conjectureCellEventId('conjecture_proposal', executionId, cell);
}

async function defaultRunWithExecutionLock<T>(
  db: Db,
  executionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Hold one dedicated connection-scoped transaction lock across the whole orchestration.
  // Business reads/writes keep their own short transactions on `db`; this outer
  // transaction owns only the advisory lock. A crash releases it automatically, and a
  // concurrent redelivery blocks here, then observes the first worker's committed
  // completion before model work.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`research_meeting_execution:${executionId}`}, 0))`,
    );
    return fn();
  });
}

async function defaultLoadCompletedRunResult(
  db: Db,
  executionId: string,
): Promise<ResearchMeetingResult | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, scheduledEventId('completion', executionId)))
    .limit(1);
  if (!row) return null;
  const parsed = z.object({ completed_result: ResearchMeetingResultSchema }).safeParse(row.payload);
  if (!parsed.success) {
    // Fail closed: treating this as unfinished would repeat paid model work and
    // business effects, while the first-write-wins completion id cannot replace
    // the corrupt row. Emit schema diagnostics for repair instead.
    console.error('[research_meeting_nightly] committed completion payload is unreadable', {
      execution_id: executionId,
      issues: parsed.error.issues,
    });
    throw new Error(
      `research_meeting_nightly: completion payload is unreadable for execution ${executionId}`,
    );
  }
  return parsed.data.completed_result;
}

function buildCompletionEventInput(
  executionId: string,
  result: ResearchMeetingResult,
  now: Date,
  causedByEventId: string | null,
): WriteEventInput {
  const id = scheduledEventId('completion', executionId);
  return {
    id,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:research_meeting_completed',
    subject_kind: 'query',
    subject_id: id,
    outcome: 'success',
    payload: { completed_result: result },
    caused_by_event_id: causedByEventId,
    // Execution bookkeeping only; not a learner fact.
    ingest_at: now,
    created_at: now,
  };
}

function isOperationalAbstain(result: InduceConjectureResult): boolean {
  // The collapsed reason is intentionally conservative on a three-way tie and
  // can become no_semantic_consensus for {proposal:1, invalid:1, failed:1}.
  // Classify health from the uncollapsed vote ledger instead: a strict majority
  // of operational losses means the cell failed even if its display reason tied.
  return (
    result.outcome === 'abstain' && result.votes.invalid + result.votes.failed > result.samples / 2
  );
}

export interface ResearchMeetingDeps extends ResearchMeetingReconciliationDeps {
  now?: () => Date;
  /**
   * Stable for retries of one scheduled pg-boss execution, distinct for the next
   * schedule. The real handler supplies `job.id`; direct callers get a fresh id.
   */
  executionId?: string;
  /** Trace-bearing failure reader; the reasoning_trace rides in the wrapper. */
  getFailureAttemptsWithTraceFn?: GetFailureAttemptsWithTraceFn;
  getMasteryProjectionFn?: GetMasteryProjectionFn;
  /** First dedup base: cause×KC keys with a PENDING conjecture. */
  loadKnownConjectureKeysFn?: (db: Db) => Promise<Set<string>>;
  /** injected runner — defaults to the real db-bound runTask. */
  runTaskFn?: TaskTextRunFn;
  induceConjectureFn?: InduceConjectureFn;
  writeAiProposalFn?: WriteAiProposalFn;
  /** Atomic durable boundary for trigger + per-cell outcomes/health + scan + completion. */
  runInTransactionFn?: RunInTransactionFn;
  /** Serialize every delivery of one stable pg-boss execution id before any work. */
  runWithExecutionLockFn?: RunWithExecutionLockFn;
  /** Redelivery guard: a committed completion means this logical execution is complete. */
  loadCompletedRunResultFn?: LoadCompletedRunResultFn;
  writeRetryableAiFailureLedgerFn?: WriteRetryableAiFailureLedgerFn;
  resolveSubjectProfileFn?: ResolveSubjectProfileFn;
}

/**
 * induceConjecture stays db-free; this seam binds `db` into the ctx it supplies
 * ({ override, modelBinding }).
 */
function makeDefaultRunTaskFn(db: Db): TaskTextRunFn {
  return makeRunTaskFn(db);
}

/** Assemble the propose-only conjecture payload (deterministic cell facts + LLM draft). */
function buildConjectureProposalInput(
  cell: EnrichedEvidenceCell,
  induced: Extract<InduceConjectureResult, { outcome: 'proposal' }>,
  triggerEventId: string,
  proposalEventId: string,
): WriteAiProposalInput {
  const draft = induced.draft;
  // Conjecture proposals intentionally remain outbox-eligible: unlike probe/scan
  // bookkeeping this is a durable, evidence-backed belief about the learner, so
  // writeAiProposal gets no ingest_at opt-out. Owner accept/edit is the later
  // calibration boundary.
  return {
    id: proposalEventId,
    actor_ref: RESEARCH_MEETING_ACTOR,
    outcome: 'partial',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: cell.knowledge_id },
      // The 2nd-person belief IS the card's reason — shown whole, never truncated.
      reason_md: draft.claim_md,
      // Provenance reuses the attempt event ids (no separate misconception store).
      evidence_refs: draft.evidence_event_ids.map((id) => ({ kind: 'event' as const, id })),
      proposed_change: {
        claim_md: draft.claim_md,
        // Deterministic cell facts win over the LLM echo (cause/recurrence are the
        // ground truth the evidence_refs back).
        knowledge_id: cell.knowledge_id,
        cause_category: cell.cause_category,
        confidence: induced.confidence, // internal sort only — NEVER rendered as a number
        recurrence_count: cell.recurrence_count,
        probe_md: draft.probe_md,
        followup_probe_md: draft.followup_probe_md,
        // Single-writer judge gold reference flows draft → proposal change →
        // acceptConjectureProposal → serveProbeOnce.referenceMd.
        probe_reference_md: draft.probe_reference_md,
        followup_probe_reference_md: draft.followup_probe_reference_md,
        diagnostic_spec: draft.diagnostic_spec,
        probe_spec: draft.probe_spec,
        followup_probe_spec: draft.followup_probe_spec,
        probe_quality: draft.probe_quality,
        discriminating: draft.discriminating,
        corrected_by_owner: false,
        // The falsifiable bet + the number it must later beat.
        predicted_p: draft.predicted_p,
        baseline_p_at_induction: cell.baseline_p ?? 0.5, // 0.5 = cold-start neutral
      },
      cooldown_key: `conjecture:${cell.key}`,
    },
    caused_by_event_id: triggerEventId,
    // Keep the scalar correlation column for the primary sample; the payload retains
    // the complete self-consistency evidence trail.
    event_override: {
      action: 'experimental:proposal',
      subject_kind: 'mind_model',
      subject_id: cell.knowledge_id,
      payload: {
        induction_task_run_ids: induced.task_run_ids,
        probe_quality_attempts: induced.probe_quality_attempts,
      },
    },
    // Scalar correlation points at the author run that produced the verified package;
    // the payload retains induction, grouping, author, and reviewer provenance.
    task_run_id: induced.primary_task_run_id,
    cost_usd: induced.cost_usd,
  };
}

async function runResearchMeetingNightlyClaimed(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const now = deps.now?.() ?? new Date();
  const executionId = deps.executionId;
  if (!executionId) {
    throw new Error('research_meeting_nightly: claimed execution is missing its stable id');
  }
  const getFailureAttemptsWithTraceFn =
    deps.getFailureAttemptsWithTraceFn ?? getFailureAttemptsWithReasoningTraceForDerivation;
  const getMasteryProjectionFn = deps.getMasteryProjectionFn ?? getMasteryProjection;
  const induceConjectureFn = deps.induceConjectureFn ?? induceConjecture;
  const writeAiProposalFn = deps.writeAiProposalFn ?? writeAiProposal;
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const runInTransactionFn =
    deps.runInTransactionFn ??
    ((database: Db, fn: (tx: DbLike) => Promise<void>) => database.transaction(fn));
  const loadCompletedRunResultFn = deps.loadCompletedRunResultFn ?? defaultLoadCompletedRunResult;
  const writeRetryableAiFailureLedgerFn =
    deps.writeRetryableAiFailureLedgerFn ?? writeRetryableAiFailureLedger;
  const resolveSubjectProfileFn = deps.resolveSubjectProfileFn ?? resolveSubjectProfile;
  const runTaskFn = deps.runTaskFn ?? makeDefaultRunTaskFn(db);
  const persistCompletionOnly = async (result: ResearchMeetingResult): Promise<void> => {
    await runInTransactionFn(db, async (tx) => {
      await writeEventFn(tx, buildCompletionEventInput(executionId, result, now, null));
    });
  };

  // pg-boss may redeliver after the transaction committed but before completion
  // was acknowledged. Return the committed summary before any reads or model calls;
  // otherwise pending-proposal dedup could refill this execution from lower cells.
  const completedResult = await loadCompletedRunResultFn(db, executionId);
  if (completedResult) return completedResult;

  // ── Reconcile: project PRIOR probe outcomes into the typed ledger.
  // Catch-up sweep: the probe-result subscription already reconciles each answer at
  // delivery time (YUK-1664); this pass picks up whatever it left behind. Both
  // callers serialize on the shared conjecture-reconcile lock, so nothing scores twice.
  // Sequence 1 appends a prediction_score consumed by the accountability ranker; recurrence
  // results append a score-free projection anchor. Runs BEFORE the propose half:
  // deterministic, idempotent (already-scored probes are excluded by the reader), and a
  // throw here is retryable so pg-boss retries the whole job.
  const reconcileResult = await reconcileResearchMeetingExecution(db, executionId, now, deps);
  // Surface the aggregate skip count — a non-zero value flags data-quality drift (dangling /
  // unreadable conjecture refs) that the per-probe console.warn alone makes easy to miss.
  if (reconcileResult.skipped > 0) {
    console.warn('[research_meeting_nightly] reconcile skipped probes', reconcileResult.skipped);
  }

  // ── PRE-LLM reads (OUTSIDE the per-cell swallow — a throw here is retryable) ──
  const since = new Date(now.getTime() - RESEARCH_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Each failure row is paired with its reasoning trace — the owner's own account of how
  // they thought, and the most load-bearing first-hand evidence for a mind-model claim.
  // Derived from the rows the reader already selects (no extra round-trip).
  const failureRows = await getFailureAttemptsWithTraceFn(db, {
    includeReviewFailures: true,
    since,
  });
  const failures: FailureAttempt[] = failureRows.map((row) => row.failure);
  const reasoningTraceByAttemptId = new Map(
    failureRows.map((row) => [row.failure.attempt_event_id, row.reasoning_trace]),
  );
  const kcIds = [...new Set(failures.flatMap((f) => f.referenced_knowledge_ids))];
  const masteryByKnowledgeId =
    kcIds.length > 0 ? await getMasteryProjectionFn(db, kcIds) : new Map();

  // ── Candidate selection (still OUTSIDE the per-cell swallow — a throw is retryable) ──
  const selection = await selectConjectureCandidates(db, {
    failures,
    reasoningTraceByAttemptId,
    masteryByKnowledgeId,
    now,
    limit: RESEARCH_MEETING_MAX_CONJECTURES,
    imageFetchFn: defaultImageFetch,
    loadKnownConjectureKeysFn: deps.loadKnownConjectureKeysFn,
    since,
  });
  for (const exclusion of selection.exclusions) {
    if (exclusion.reason === 'evidence_image_unavailable') {
      console.error(
        '[research_meeting_nightly] excluding candidate with unloadable evidence images',
        exclusion.key,
        exclusion.error,
      );
    }
  }
  const pendingBefore = selection.pendingConjectureCount;
  const incompleteEvidenceExcluded = selection.exclusions.filter(
    (exclusion) => exclusion.reason === 'invalid_evidence_packet',
  ).length;
  const preparedTopCells = selection.candidates;

  // Empty or ungrounded night: zero candidates means the propose half has nothing to
  // anchor. Skip trigger + scan; persist only the execution completion guard so a
  // redelivery cannot reconcile or discover new work twice.
  // MUST stay AFTER the reconcile call above: settlement is never skipped.
  if (preparedTopCells.length === 0) {
    const idleResult: ResearchMeetingResult = {
      considered: 0,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 0,
      pending_before: pendingBefore,
      reconciled: reconcileResult.reconciled,
      reconcile_skipped: reconcileResult.skipped,
      incomplete_evidence_excluded: incompleteEvidenceExcluded,
      cost_usd: 0,
      trigger_event_id: '',
    };
    await persistCompletionOnly(idleResult);
    return idleResult;
  }

  // Anchor the run (provenance for each proposal + the scan subject). The trigger write
  // joins the result writes and scan in one transaction below; the stable pg-boss
  // execution id keeps every durable fact anchored to the same logical run.
  const triggerEventId = scheduledEventId('trigger', executionId);

  // ── LLM half: independent top cells run in parallel ─────────────────────────
  // Only provider/induction failures are cell-local and swallow-safe. Durable writes
  // happen after all inductions and commit atomically below.
  const cellResults = await Promise.all(
    preparedTopCells.map(
      async ({
        cell,
        evidenceImages,
        priorClaimMd,
        priorAbstention,
        contrastCorrectSamples,
        agentNotes,
      }): Promise<{
        cell: EnrichedEvidenceCell;
        induced: InduceConjectureResult | null;
        created: number;
        abstained: number;
        failed: number;
        failed_task_kind: ConjectureInductionTaskKind | null;
        retry_job_error: ConjectureInductionOperationalError | null;
        cost_usd: number | null;
      }> => {
        let induced: InduceConjectureResult;
        try {
          induced = await induceConjectureFn({
            cells: [cell],
            evidenceImages,
            samples: RESEARCH_MEETING_SAMPLES,
            runTaskFn,
            ...(priorClaimMd ? { priorClaimMd } : {}),
            ...(priorAbstention ? { priorAbstention } : {}),
            contrastCorrectSamples,
            agentNotes,
            // Render the prompt in the cell's OWN subject voice. An untagged KC
            // (subject_id null) stays on the neutral `general` profile; inheriting a
            // concrete subject would steer the claim toward the wrong subject.
            subjectProfile: resolveSubjectProfileFn(cell.subject_id),
          });
        } catch (err) {
          console.error('[research_meeting_nightly] conjecture cell failed', cell.key, err);
          if (
            err instanceof ConjectureInductionOperationalError &&
            (err.taskKind === 'ConjectureProbeAuthorTask' ||
              err.taskKind === 'ConjectureProbeReviewTask')
          ) {
            // Do not persist this execution's completion marker. pg-boss redelivery
            // must revisit the cell after an author/reviewer outage or invalid output.
            await writeRetryableAiFailureLedgerFn(db, err.taskKind);
            return {
              cell,
              induced: null,
              created: 0,
              abstained: 0,
              failed: 1,
              failed_task_kind: err.taskKind,
              retry_job_error: err,
              cost_usd: null,
            };
          }
          // Keep swallowing (one bad cell must not fail the batch) but COUNT it, so the
          // handler can tell "no evidence tonight" from "every cell blew up". Partial
          // sample spend stays in per-call cost_ledger rows; the thrown orchestrator
          // exposes no reliable partial total for this aggregate.
          return {
            cell,
            induced: null,
            created: 0,
            abstained: 0,
            failed: 1,
            failed_task_kind:
              err instanceof ConjectureInductionOperationalError
                ? err.taskKind
                : 'MindModelInductionTask',
            retry_job_error: null,
            cost_usd: null,
          };
        }

        const operationalFailure = isOperationalAbstain(induced);
        return {
          cell,
          induced,
          created: induced.outcome === 'proposal' ? 1 : 0,
          // Evidence-related abstentions and genuine semantic disagreement are
          // successful fail-closed decisions. Invalid output/provider-majority
          // reasons are operational failures and must make an all-bad night stall.
          abstained: induced.outcome === 'abstain' && !operationalFailure ? 1 : 0,
          failed: operationalFailure ? 1 : 0,
          failed_task_kind: operationalFailure ? 'MindModelInductionTask' : null,
          retry_job_error: null,
          cost_usd: induced.cost_usd,
        };
      },
    ),
  );
  const retryJobError = cellResults.find((result) => result.retry_job_error)?.retry_job_error;
  if (retryJobError) {
    // Promise.all has now waited for every sibling cell to settle, but no proposal,
    // scan, or completion fact has been committed for this execution.
    throw retryJobError;
  }
  const created = cellResults.reduce((sum, result) => sum + result.created, 0);
  const abstained = cellResults.reduce((sum, result) => sum + result.abstained, 0);
  const cellsFailed = cellResults.reduce((sum, result) => sum + result.failed, 0);
  const costUsd = sumAllKnownCostUsd(cellResults.map((result) => result.cost_usd));
  if (created + abstained + cellsFailed !== preparedTopCells.length) {
    throw new Error(
      `research_meeting_nightly: result invariant violated: created(${created}) + abstained(${abstained}) + failed(${cellsFailed}) !== considered(${preparedTopCells.length})`,
    );
  }
  const completedResultForWrite: ResearchMeetingResult = {
    considered: preparedTopCells.length,
    conjectures_created: created,
    conjectures_abstained: abstained,
    cells_failed: cellsFailed,
    pending_before: pendingBefore,
    reconciled: reconcileResult.reconciled,
    reconcile_skipped: reconcileResult.skipped,
    incomplete_evidence_excluded: incompleteEvidenceExcluded,
    cost_usd: costUsd,
    trigger_event_id: triggerEventId,
  };

  // Trigger + every successful cell result + scan commit together. A single durable-write
  // failure rolls the whole batch back, so retry-time pending-proposal dedup can never
  // shrink the logical run into a partial scan. Each runTask call already committed its
  // own ai_task_runs + cost_ledger rows; this transaction governs business outcomes only.
  await runInTransactionFn(db, async (tx) => {
    await writeEventFn(tx, {
      id: triggerEventId,
      actor_kind: 'agent',
      actor_ref: RESEARCH_MEETING_ACTOR,
      action: 'experimental:trigger_research_meeting',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        window_days: RESEARCH_MEETING_WINDOW_DAYS,
        candidate_cells: preparedTopCells.length,
        pending_conjectures: pendingBefore,
      },
      // Run anchor/provenance only; keep the event but skip Mem0 + brief regeneration.
      ingest_at: now,
      created_at: now,
    });

    for (const result of cellResults) {
      if (result.failed > 0) {
        // Operational health rows belong to the same commit boundary as the
        // run facts. A final-write rollback must not orphan/duplicate them.
        if (!result.failed_task_kind) {
          throw new Error('research_meeting_nightly: failed cell is missing task attribution');
        }
        await writeRetryableAiFailureLedgerFn(tx, result.failed_task_kind, { throwOnError: true });
      }
      if (!result.induced) continue;
      const { cell, induced } = result;
      if (induced.outcome === 'abstain') {
        await writeEventFn(tx, {
          // A pg-boss retry reuses job.id and therefore this first-write-wins event; the
          // next scheduled execution has a distinct job.id and keeps its own provenance.
          id: conjectureAbstentionEventId(executionId, cell),
          actor_kind: 'agent',
          actor_ref: RESEARCH_MEETING_ACTOR,
          action: 'experimental:conjecture_abstained',
          subject_kind: 'mind_model',
          subject_id: cell.knowledge_id,
          outcome: isOperationalAbstain(induced) ? 'failure' : 'partial',
          payload: {
            reason_code: induced.draft.reason_code,
            explanation_md: induced.draft.explanation_md ?? null,
            cell_key: cell.key,
            cause_category: cell.cause_category,
            evidence_event_ids: induced.draft.evidence_event_ids,
            input_evidence_event_ids: cell.evidence_event_ids,
            induction_task_run_ids: induced.task_run_ids,
            probe_quality_attempts: induced.probe_quality_attempts,
            votes: induced.votes,
            requested_samples: induced.samples,
          },
          caused_by_event_id: triggerEventId,
          cost_micro_usd: costUsdToMicroUsd(induced.cost_usd),
          // Audit/observability only: an abstention is not a learner fact.
          ingest_at: now,
          created_at: now,
        });
      } else {
        await writeAiProposalFn(
          tx,
          buildConjectureProposalInput(
            cell,
            induced,
            triggerEventId,
            conjectureProposalEventId(executionId, cell),
          ),
        );
      }
    }

    // Observability scan event — NOT cost-bearing: each outcome event already carries its
    // own cost, so a run total here would double-count it.
    await writeEventFn(tx, {
      id: scheduledEventId('scan', executionId),
      actor_kind: 'agent',
      actor_ref: RESEARCH_MEETING_ACTOR,
      action: 'experimental:research_meeting_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        considered: preparedTopCells.length,
        conjectures_created: created,
        conjectures_abstained: abstained,
        cells_failed: cellsFailed,
        pending_before: pendingBefore,
        incomplete_evidence_excluded: incompleteEvidenceExcluded,
      },
      caused_by_event_id: triggerEventId,
      cost_micro_usd: null,
      // Aggregate observability only; not evidence about the learner.
      ingest_at: now,
      created_at: now,
    });
    await writeEventFn(
      tx,
      buildCompletionEventInput(executionId, completedResultForWrite, now, triggerEventId),
    );
  });

  return completedResultForWrite;
}

export async function runResearchMeetingNightly(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const executionId = deps.executionId ?? newId();
  const runWithExecutionLockFn = deps.runWithExecutionLockFn ?? defaultRunWithExecutionLock;
  return runWithExecutionLockFn(db, executionId, () =>
    runResearchMeetingNightlyClaimed(db, { ...deps, executionId }),
  );
}

export function buildResearchMeetingNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  // Capability jobs are mounted centrally with batchSize:1
  // (register-capability-jobs.ts); one handler invocation owns exactly one job id.
  return async (jobs) => {
    try {
      const executionId = jobs[0]?.id;
      if (!executionId) {
        throw new Error('research_meeting_nightly: handler invoked without a pg-boss job id');
      }
      const result = await runResearchMeetingNightly(db, {
        executionId,
      });
      console.log('[research_meeting_nightly] result', result);
      // The fallible units are the top-K cells. An empty night returns considered:0 →
      // `idle` (no alarm); every cell failing → `stalled` (loud), and the report rides the
      // job output into the DAG node detail.
      return reportJobYield('research_meeting_nightly', {
        attempted: result.considered,
        // abstain is a successful, fail-closed model decision, not an AI failure.
        succeeded: result.conjectures_created + result.conjectures_abstained,
        failed: result.cells_failed,
      });
    } catch (err) {
      console.error('[research_meeting_nightly] failed', err);
      throw err;
    }
  };
}
