// The model returns one award, a reason, and evidence refs per criterion.
// Code checks that the ids cover the published rubric and each award is allowed, then sums.
// There is no total field. A new criterion, a changed max, or a self-reported total is pending.
// An image counts only after its digest is checked and the bytes ride an image block.
// A quote on an image, or a ref that was not delivered, is pending. Do not guess the score.
// A successful call with unknown price is charged at the whole-unit cap. The ledger stays unknown.
// A timeout with no settled price does not write the reserved cap as cost.
// The estimated retry gate uses the holdout's mean successful price. Over cap is pending.
//

import { randomUUID } from 'node:crypto';
import { AgentRunError, isProviderSessionWallClockBudgetError } from '@/ai/agent-run-error';
import type { RunTaskResult } from '@/ai/task-result';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import {
  ASSESSMENT_RUBRIC_TIMEOUT_RETRIES,
  assessmentRubricTimeoutRetryFits,
} from '@/core/assessment-rubric-timeout';
import type {
  ModelExecutorRequest,
  ModelUnitExecutorPort,
  ModelUnitOutcomeT,
  PendingStateT,
  RubricCriterionT,
} from '@/core/schema/assessment';
import { isOriginalEvidenceQuote } from '@/core/schema/assessment/evidence-quote';
import { AssessmentRubricDecision } from '@/core/schema/assessment/model-decision';
import type { Db } from '@/db/client';
import {
  isLaminarTracingEnabled,
  traceMetadata,
  traceOperation,
} from '@/server/ai/laminar-tracing';
import type { RunTaskCtx } from '@/server/ai/runner';
import {
  type AssessmentAssetLoader,
  createAssessmentAssetLoader,
  prepareAssessmentModelInput,
  withinAssessmentSignal,
} from './assessment-model-assets';
import {
  assessmentExecutionOutcome,
  assessmentTaskTraceOutput,
  assessmentTraceInput,
  assessmentTraceOutput,
} from './assessment-trace-content';
import { gradingSliceMatchesLivePin } from './model-slice-registry';

export const ASSESSMENT_RUBRIC_TASK_KIND = 'AssessmentRubricJudgeTask';

export interface RubricModelExecutorOptions {
  judgeRetryPolicy?: RunTaskCtx['judgeRetryPolicy'];
  db: Db;
  deadlineAt: number;
  /** Caller cap, intersected with the published unit cap and task budget. */
  maxCostUsdMicros: number;
  signal?: AbortSignal;
  /** Pre-call durable claim identity supplied by formal entry orchestration. */
  taskRunId?: string;
  /**
   * Formal grading re-checks the live pin before any provider call. Admission
   * runs leave this off: the slice row does not exist until the holdout passes.
   */
  confirmLiveSlice?: boolean;
  /** Tests replace bytes/runner boundaries, not frozen interpretation. */
  loadAsset?: AssessmentAssetLoader;
  runTask?: (
    kind: typeof ASSESSMENT_RUBRIC_TASK_KIND,
    input: unknown,
    ctx: RunTaskCtx,
  ) => Promise<RunTaskResult>;
}

const pending = (
  state: PendingStateT,
  runRefs: string[] = [],
  cost?: number,
): ModelUnitOutcomeT => ({
  kind: 'pending',
  pending: state,
  run_refs: runRefs,
  ...(cost === undefined ? {} : { cost_usd_micros: cost }),
});

/** Decimal awards such as 0.5 must not fail on binary residue. Epsilon is 1e-9. */
function sameAward(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * A cited slot or evidence must be in this input. A quote must be the answer
 * or delivered text. Image evidence is cited by id only. A quote would claim the model read pixels.
 */
function citationProblem(
  request: ModelExecutorRequest,
  citations: Array<{ slot_id?: string; evidence_id?: string; quote?: string }>,
  textEvidence: Array<{ evidence_id: string; text: string }>,
): string | null {
  const slots = new Map(request.slot_responses.map((entry) => [entry.slot_id, entry]));
  const imageEvidenceIds = new Set(
    [
      ...request.slot_responses.flatMap((entry) => (entry.kind === 'open' ? entry.evidence : [])),
      ...request.group_evidence.map((item) => item.evidence),
    ]
      .filter((item) => item.kind === 'image')
      .map((item) => item.evidence_id),
  );
  const evidenceIds = new Set([
    ...request.slot_responses.flatMap((entry) =>
      entry.kind === 'open' ? entry.evidence.map((item) => item.evidence_id) : [],
    ),
    ...request.group_evidence.map((item) => item.evidence.evidence_id),
  ]);
  for (const citation of citations) {
    if (citation.slot_id === undefined && citation.evidence_id === undefined) {
      return 'a citation identifies neither a slot nor an evidence attachment';
    }
    if (citation.slot_id !== undefined && !slots.has(citation.slot_id)) {
      return `citation references unsubmitted slot '${citation.slot_id}'`;
    }
    if (citation.evidence_id !== undefined && !evidenceIds.has(citation.evidence_id)) {
      return `citation references unsubmitted evidence '${citation.evidence_id}'`;
    }
    if (citation.quote === undefined) continue;
    if (citation.evidence_id !== undefined && imageEvidenceIds.has(citation.evidence_id)) {
      return `citation attaches a textual quote to image evidence '${citation.evidence_id}' — an image cannot be quoted`;
    }
    const entry = citation.slot_id !== undefined ? slots.get(citation.slot_id) : undefined;
    const slotText =
      entry !== undefined && (entry.kind === 'text' || entry.kind === 'open')
        ? entry.text_md
        : undefined;
    const evidenceText = textEvidence.find(
      (item) => item.evidence_id === citation.evidence_id,
    )?.text;
    const quoted = [slotText, evidenceText].some(
      (source) =>
        source !== undefined && isOriginalEvidenceQuote({ source, quote: citation.quote ?? '' }),
    );
    if (!quoted) {
      return 'citation quote is not an original span of the submitted text or delivered text evidence';
    }
  }
  return null;
}

/** Unknown, missing, repeated, or out-of-range awards return null. The caller pends. Do not guess. */
function sumValidatedAwards(
  criterion: RubricCriterionT,
  awards: Array<{ criterion_id: string; award: number }>,
): number | null {
  const published = new Map(criterion.criteria.map((item) => [item.criterion_id, item] as const));
  if (awards.length !== published.size) return null;
  const seen = new Set<string>();
  let total = 0;
  for (const award of awards) {
    if (seen.has(award.criterion_id)) return null;
    seen.add(award.criterion_id);
    const spec = published.get(award.criterion_id);
    if (spec === undefined) return null;
    if (!spec.allowed_awards.some((allowed) => sameAward(allowed, award.award))) return null;
    total += award.award;
  }
  return total;
}

function attemptRunRefs(
  prior: readonly string[],
  result: RunTaskResult | undefined,
  error: unknown,
  providerStarted: boolean,
  taskRunId: string,
): string[] {
  const id = result
    ? result.task_run_id
    : error instanceof AgentRunError
      ? error.taskRunId
      : providerStarted
        ? taskRunId
        : undefined;
  return id === undefined || prior.includes(id) ? [...prior] : [...prior, id];
}

function reportedTimeoutMicros(error: unknown): number | undefined {
  if (
    error instanceof AgentRunError &&
    error.costUsd !== undefined &&
    Number.isFinite(error.costUsd) &&
    error.costUsd >= 0
  ) {
    return Math.ceil(error.costUsd * 1_000_000);
  }
  return undefined;
}

function isRubricCallTimeout(
  error: unknown,
  attemptSignal: AbortSignal,
  callerSignals: Array<AbortSignal | undefined>,
): boolean {
  if (callerSignals.some((signal) => signal?.aborted)) return false;
  if (error instanceof AgentRunError && error.subtype === 'budget_timeout') return true;
  if (isProviderSessionWallClockBudgetError(error)) return true;
  return attemptSignal.aborted;
}

/** One timeout without a settled price makes the whole item unknown. Do not publish a cap as the cost. */
function chargedMicros(
  unknownAttempts: number,
  knownSpent: number,
  callCost: number,
): number | undefined {
  if (unknownAttempts > 0) return undefined;
  return knownSpent + callCost;
}

/** Native pi task. One decision per published criterion. */
export function createRubricModelExecutor(
  options: RubricModelExecutorOptions,
): ModelUnitExecutorPort {
  const execute: ModelUnitExecutorPort = async (request, callerSignal) => {
    if (
      request.executor.task_kind !== ASSESSMENT_RUBRIC_TASK_KIND ||
      request.executor.admitted_slice_id === null
    ) {
      return pending({
        reason: 'unjudgeable',
        detail: 'native rubric assessment task or admitted slice missing',
      });
    }
    if (options.confirmLiveSlice) {
      const decision = await gradingSliceMatchesLivePin(
        options.db,
        request.executor.admitted_slice_id,
        request.executor.task_kind,
      );
      if (!decision.ok) return pending({ reason: 'unjudgeable', detail: decision.detail });
    }
    if (request.unit.criterion.kind !== 'rubric') {
      return pending({
        reason: 'unjudgeable',
        detail: `criterion '${request.unit.criterion.kind}' is not rubric — deterministic criteria belong to declared comparators`,
      });
    }
    const criterion = request.unit.criterion;
    const budget = resolveTaskBudget(ASSESSMENT_RUBRIC_TASK_KIND);
    const publishedCap = request.executor.max_cost_usd_micros;
    if (
      publishedCap === undefined ||
      !Number.isSafeInteger(options.maxCostUsdMicros) ||
      options.maxCostUsdMicros <= 0
    ) {
      return pending({
        reason: 'unjudgeable',
        detail:
          'native model execution requires explicit positive caller and published unit cost caps',
      });
    }
    const cap = Math.min(
      publishedCap,
      options.maxCostUsdMicros,
      Math.floor(budget.maxCost * 1_000_000),
    );
    if (cap <= 0) {
      return pending({
        reason: 'unjudgeable',
        detail: 'native model cost or wall-clock budget exhausted',
      });
    }
    const runTask = options.runTask ?? (await import('@/server/ai/runner')).runTask;
    const loadAsset = options.loadAsset ?? createAssessmentAssetLoader(options.db);
    let timeoutRetriesLeft = ASSESSMENT_RUBRIC_TIMEOUT_RETRIES;
    let knownSpent = 0;
    let unknownAttempts = 0;
    const priorRefs: string[] = [];
    for (;;) {
      const remaining = options.deadlineAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        return pending(
          {
            reason: 'unjudgeable',
            detail: 'native model cost or wall-clock budget exhausted',
          },
          priorRefs,
          unknownAttempts === 0 && knownSpent > 0 ? knownSpent : undefined,
        );
      }
      const timeoutMs = Math.min(remaining, budget.timeout);
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...[options.signal, callerSignal].filter(
          (value): value is AbortSignal => value !== undefined,
        ),
      ]);
      const taskRunId = priorRefs.length === 0 ? (options.taskRunId ?? randomUUID()) : randomUUID();
      let providerStarted = false;
      let result: RunTaskResult | undefined;
      try {
        signal.throwIfAborted();
        const prepared = await prepareAssessmentModelInput(request, loadAsset, signal);
        if (!prepared.ok) return pending(prepared.pending, priorRefs);
        signal.throwIfAborted();
        result = await withinAssessmentSignal(
          () =>
            runTask(ASSESSMENT_RUBRIC_TASK_KIND, prepared.input, {
              db: options.db,
              judgeRetryPolicy: options.judgeRetryPolicy,
              taskRunId,
              signal,
              laminarContent: isLaminarTracingEnabled()
                ? { input: assessmentTraceInput(request), output: assessmentTaskTraceOutput }
                : undefined,
              providerSessionDeadlineAt: options.deadlineAt,
              budgetOverride: {
                maxIterations: budget.maxIterations,
                timeoutMs: Math.min(budget.timeout, Math.max(1, options.deadlineAt - Date.now())),
              },
              beforeProviderQuery: async () => {
                signal.throwIfAborted();
                providerStarted = true;
              },
            }),
          signal,
        );
        // Success with an unknown price still charges the whole-unit cap. A timeout does not come through here.
        const callCost =
          result.cost_usd !== undefined && Number.isFinite(result.cost_usd) && result.cost_usd >= 0
            ? Math.ceil(result.cost_usd * 1_000_000)
            : cap;
        const refs = attemptRunRefs(priorRefs, result, undefined, providerStarted, taskRunId);
        const settled = chargedMicros(unknownAttempts, knownSpent, callCost);
        if (callCost > cap || (settled !== undefined && settled > cap)) {
          return pending(
            { reason: 'unjudgeable', detail: 'native model exceeded the admitted call cost cap' },
            refs,
            settled ?? callCost,
          );
        }
        const modelResult = result;
        const decision = AssessmentRubricDecision.parse(
          modelResult.structured_output ?? JSON.parse(modelResult.text.trim()),
        );
        if (decision.kind === 'pending') {
          return pending(
            { reason: 'insufficient_evidence', detail: decision.detail },
            refs,
            settled,
          );
        }
        const total = sumValidatedAwards(criterion, decision.awards);
        if (total === null) {
          return pending(
            {
              reason: 'unjudgeable',
              detail:
                'model awards do not match the published rubric: criterion ids must cover the frozen criteria exactly once and each award must be a declared allowed_awards step',
            },
            refs,
            settled,
          );
        }
        const wire = JSON.parse(prepared.input.text) as {
          text_evidence: Array<{ evidence_id: string; text: string }>;
        };
        const citations = decision.awards.flatMap((award) => award.evidence_citations);
        const problem = citationProblem(request, citations, wire.text_evidence);
        if (problem !== null) {
          return pending(
            { reason: 'unjudgeable', detail: `model evidence rejected: ${problem}` },
            refs,
            settled,
          );
        }
        return {
          kind: 'scored',
          points_awarded: total,
          ...(decision.feedback_md !== undefined ? { feedback_md: decision.feedback_md } : {}),
          evidence_citations: citations,
          ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
          run_refs: refs,
          ...(settled === undefined ? {} : { cost_usd_micros: settled }),
        };
      } catch (error) {
        const refs = attemptRunRefs(priorRefs, result, error, providerStarted, taskRunId);
        const timedOut = isRubricCallTimeout(error, signal, [options.signal, callerSignal]);
        if (timedOut) {
          const reported = reportedTimeoutMicros(error);
          if (reported !== undefined) knownSpent += reported;
          else unknownAttempts += 1;
          const retryRemaining = options.deadlineAt - Date.now();
          if (
            timeoutRetriesLeft > 0 &&
            retryRemaining > 0 &&
            assessmentRubricTimeoutRetryFits(knownSpent, unknownAttempts, cap)
          ) {
            timeoutRetriesLeft -= 1;
            priorRefs.splice(0, priorRefs.length, ...refs);
            continue;
          }
          return pending(
            {
              reason: 'infra_failure',
              retryable: false,
              detail: 'native model deadline/cancellation reached',
            },
            refs,
            unknownAttempts === 0 ? knownSpent : undefined,
          );
        }
        const reported = reportedTimeoutMicros(error);
        const callCost = reported ?? (providerStarted ? cap : undefined);
        return pending(
          {
            reason: 'infra_failure',
            retryable: false,
            detail: signal.aborted
              ? 'native model deadline/cancellation reached'
              : 'native model asset, execution or output validation failed',
          },
          refs,
          callCost === undefined ? undefined : chargedMicros(unknownAttempts, knownSpent, callCost),
        );
      }
    }
  };
  return (request, callerSignal) =>
    traceOperation(
      'assessment.execute',
      { task_kind: ASSESSMENT_RUBRIC_TASK_KIND },
      async () => {
        const outcome = await execute(request, callerSignal);
        traceMetadata({ business_outcome: outcome.kind === 'scored' ? 'accepted' : 'pending' });
        return outcome;
      },
      {
        signal: callerSignal ?? options.signal,
        content: isLaminarTracingEnabled()
          ? { input: assessmentTraceInput(request), output: assessmentTraceOutput }
          : undefined,
        outcome: assessmentExecutionOutcome,
      },
    );
}
