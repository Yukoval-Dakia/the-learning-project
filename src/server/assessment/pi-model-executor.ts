import { randomUUID } from 'node:crypto';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import type {
  ModelExecutorRequest,
  ModelUnitExecutorPort,
  ModelUnitOutcomeT,
  PendingStateT,
} from '@/core/schema/assessment';
import { AssessmentRuleDecision } from '@/core/schema/assessment/model-decision';
import type { Db } from '@/db/client';
import { AgentRunError } from '@/server/ai/agent-run-error';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';
import {
  type AssessmentAssetLoader,
  createAssessmentAssetLoader,
  prepareAssessmentModelInput,
  withinAssessmentSignal,
} from './assessment-model-assets';

export interface PiModelExecutorOptions {
  db: Db;
  deadlineAt: number;
  /** Caller cap, intersected with the published unit cap and task budget. */
  maxCostUsdMicros: number;
  signal?: AbortSignal;
  /** Tests replace bytes/runner boundaries, not frozen interpretation. */
  loadAsset?: AssessmentAssetLoader;
  runTask?: (
    kind: 'AssessmentRuleJudgeTask',
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

function citationProblem(
  request: ModelExecutorRequest,
  citations: Array<{ slot_id?: string; evidence_id?: string; quote?: string }>,
  textEvidence: Array<{ evidence_id: string; text: string }>,
): boolean {
  const slots = new Map(request.slot_responses.map((entry) => [entry.slot_id, entry]));
  const evidenceIds = new Set([
    ...request.slot_responses.flatMap((entry) =>
      entry.kind === 'open' ? entry.evidence.map((item) => item.evidence_id) : [],
    ),
    ...request.group_evidence.map((item) => item.evidence.evidence_id),
  ]);
  return citations.some((citation) => {
    if (
      (!citation.slot_id && !citation.evidence_id) ||
      (citation.slot_id && !slots.has(citation.slot_id)) ||
      (citation.evidence_id && !evidenceIds.has(citation.evidence_id))
    )
      return true;
    if (citation.quote === undefined) return false;
    const entry = citation.slot_id ? slots.get(citation.slot_id) : undefined;
    const text =
      entry && (entry.kind === 'text' || entry.kind === 'open') ? entry.text_md : undefined;
    const evidenceText = textEvidence.find(
      (item) => item.evidence_id === citation.evidence_id,
    )?.text;
    return ![text, evidenceText].some((source) => source?.includes(citation.quote ?? ''));
  });
}

/** Standalone native pi lane, selected only by an explicit published task and descriptor. */
export function createPiModelExecutor(options: PiModelExecutorOptions): ModelUnitExecutorPort {
  return async (request, callerSignal) => {
    if (
      request.executor.task_kind !== 'AssessmentRuleJudgeTask' ||
      request.executor.admitted_slice_id === null
    ) {
      return pending({
        reason: 'unjudgeable',
        detail: 'native pi assessment task or admitted slice missing',
      });
    }
    if (
      request.unit.criterion.kind !== 'rule_reference' &&
      request.unit.criterion.kind !== 'holistic_level'
    ) {
      return pending({
        reason: 'unjudgeable',
        detail: 'deterministic criteria belong to declared comparators',
      });
    }
    const budget = resolveTaskBudget('AssessmentRuleJudgeTask');
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
    const remaining = options.deadlineAt - Date.now();
    if (cap <= 0 || !Number.isFinite(remaining) || remaining <= 0) {
      return pending({
        reason: 'unjudgeable',
        detail: 'native model cost or wall-clock budget exhausted',
      });
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.min(remaining, budget.timeout)),
      ...[options.signal, callerSignal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    ]);
    const taskRunId = randomUUID();
    let providerStarted = false;
    let result: RunTaskResult | undefined;
    let cost: number | undefined;
    try {
      signal.throwIfAborted();
      const prepared = await prepareAssessmentModelInput(
        request,
        options.loadAsset ?? createAssessmentAssetLoader(options.db),
        signal,
      );
      if (!prepared.ok) return pending(prepared.pending);
      signal.throwIfAborted();
      const runTask = options.runTask ?? (await import('@/server/ai/runner')).runTask;
      result = await withinAssessmentSignal(
        () =>
          runTask('AssessmentRuleJudgeTask', prepared.input, {
            db: options.db,
            taskRunId,
            signal,
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
      // Unknown cost consumes the full admitted reservation; the runner's ledger
      // retains unknown vs reported/estimated truth. Never represent it as free.
      cost =
        result.cost_usd !== undefined && Number.isFinite(result.cost_usd) && result.cost_usd >= 0
          ? Math.ceil(result.cost_usd * 1_000_000)
          : cap;
      if (cost > cap)
        return pending(
          { reason: 'unjudgeable', detail: 'native model exceeded the admitted call cost cap' },
          [result.task_run_id],
          cost,
        );
      const decision = AssessmentRuleDecision.parse(
        result.structured_output ?? JSON.parse(result.text.trim()),
      );
      if (decision.kind === 'pending')
        return pending(
          { reason: 'insufficient_evidence', detail: decision.detail },
          [result.task_run_id],
          cost,
        );
      const wire = JSON.parse(prepared.input.text) as {
        text_evidence: Array<{ evidence_id: string; text: string }>;
      };
      if (citationProblem(request, decision.evidence_citations, wire.text_evidence)) {
        return pending(
          {
            reason: 'unjudgeable',
            detail: 'model cited unsubmitted evidence or a non-original textual quote',
          },
          [result.task_run_id],
          cost,
        );
      }
      const common = {
        feedback_md: decision.feedback_md,
        evidence_citations: decision.evidence_citations,
        confidence: decision.confidence,
        run_refs: [result.task_run_id],
        cost_usd_micros: cost,
      };
      if (
        decision.kind === 'rule' &&
        request.unit.criterion.kind === 'rule_reference' &&
        decision.rule_id === request.unit.criterion.rule_id &&
        request.unit.points !== null &&
        decision.points_awarded <= request.unit.points
      ) {
        return {
          kind: 'scored',
          points_awarded: decision.points_awarded,
          matched: { rule_id: decision.rule_id, option_ids: [] },
          ...common,
        };
      }
      if (
        decision.kind === 'level' &&
        request.unit.criterion.kind === 'holistic_level' &&
        request.unit.criterion.levels.some((level) => level.level_id === decision.level_id)
      ) {
        return {
          kind: 'scored',
          points_awarded: null,
          matched: { level_id: decision.level_id, option_ids: [] },
          ...common,
        };
      }
      return pending(
        {
          reason: 'unjudgeable',
          detail: 'model decision does not match the frozen rule, level or points cap',
        },
        [result.task_run_id],
        cost,
      );
    } catch (error) {
      const runRefs = result
        ? [result.task_run_id]
        : error instanceof AgentRunError
          ? [error.taskRunId]
          : providerStarted
            ? [taskRunId]
            : [];
      return pending(
        {
          reason: 'infra_failure',
          retryable: false,
          detail: signal.aborted
            ? 'native model deadline/cancellation reached'
            : 'native model asset, execution or output validation failed',
        },
        runRefs,
        cost ?? (providerStarted ? cap : undefined),
      );
    }
  };
}
