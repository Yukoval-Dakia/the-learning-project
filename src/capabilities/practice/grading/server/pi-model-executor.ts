import { createHash, randomUUID } from 'node:crypto';
import { AgentRunError } from '@/ai/agent-run-error';
import type { RunTaskResult } from '@/ai/task-result';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import type {
  ModelExecutorRequest,
  ModelUnitExecutorPort,
  ModelUnitOutcomeT,
  PendingStateT,
} from '@/core/schema/assessment';
import { isOriginalEvidenceQuote } from '@/core/schema/assessment/evidence-quote';
import {
  AssessmentRuleDecision,
  type AssessmentRuleDecisionT,
} from '@/core/schema/assessment/model-decision';
import type {
  ModelOutcomeDiagnosticsT,
  ModelOutcomeRejectedCitationT,
} from '@/core/schema/assessment/model-diagnostics';
import type { Db } from '@/db/client';
import {
  isLaminarTracingEnabled,
  traceMetadata,
  traceOperation,
} from '@/server/ai/laminar-tracing';
import {
  planProviderTransientRetry,
  providerTransientRetryPolicy,
  sleepMs,
} from '@/server/ai/provider-transient-retry';
import type { RunTaskCtx } from '@/server/ai/runner';
import {
  type AssessmentAssetLoader,
  createAssessmentAssetLoader,
  prepareAssessmentModelInput,
  withinAssessmentSignal,
} from './assessment-model-assets';
import {
  assessmentExecutionOutcome,
  assessmentParseTraceOutput,
  assessmentTaskTraceOutput,
  assessmentTraceInput,
  assessmentTraceOutput,
} from './assessment-trace-content';

export interface PiModelExecutorOptions {
  judgeRetryPolicy?: RunTaskCtx['judgeRetryPolicy'];
  db: Db;
  deadlineAt: number;
  /** Caller cap, intersected with the published unit cap and task budget. */
  maxCostUsdMicros: number;
  signal?: AbortSignal;
  /** Pre-call durable claim identity supplied by formal entry orchestration. */
  taskRunId?: string;
  /**
   * Admission-run lane: positively-evidenced provider-transient failures
   * (bound 429/not_sent classes) re-issue inside the shared configured bound
   * instead of ending the whole holdout on one rejection.
   */
  providerTransientRetry?: boolean;
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
  diagnostics?: ModelOutcomeDiagnosticsT,
): ModelUnitOutcomeT => ({
  kind: 'pending',
  pending: state,
  run_refs: runRefs,
  ...(cost === undefined ? {} : { cost_usd_micros: cost }),
  ...(diagnostics === undefined ? {} : { diagnostics }),
});

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * 当时可用于引用的来源：文字类记数量+总字符，image 与其他非文字证据
 * 只记类型+数量 —— 让「照片作答没有文字」与「文本槽是空的」可区分。
 */
function citableSources(
  request: ModelExecutorRequest,
  textEvidence: Array<{ evidence_id: string; text: string }>,
): NonNullable<ModelOutcomeDiagnosticsT['citable_sources']> {
  const textEntries = request.slot_responses.filter(
    (entry) => entry.kind === 'text' || entry.kind === 'open',
  );
  const evidenceKinds = [
    ...request.slot_responses.flatMap((entry) =>
      entry.kind === 'open' ? entry.evidence.map((item) => item.kind) : [],
    ),
    ...request.group_evidence.map((item) => item.evidence.kind),
  ];
  return [
    {
      kind: 'slot_text',
      count: textEntries.length,
      total_chars: textEntries.reduce((sum, entry) => sum + entry.text_md.length, 0),
    },
    {
      kind: 'text_evidence',
      count: textEvidence.length,
      total_chars: textEvidence.reduce((sum, item) => sum + item.text.length, 0),
    },
    { kind: 'image_evidence', count: evidenceKinds.filter((k) => k === 'image').length },
  ];
}

/**
 * 与拒收判定同一逻辑，但逐条产出脱敏诊断：校验顺序不变（无目标 → 未知
 * slot → 未知 evidence → 引文非原文），记录每条被拒引文的 hash/长度与
 * 指向 id（真实提交的记原文，模型声称的记 sha256）。短引文与短声称 id
 * 不记 hash —— 可枚举短语/短 id 的 sha256 能被字典还原。
 */
function citationRejections(
  request: ModelExecutorRequest,
  citations: Array<{ slot_id?: string; evidence_id?: string; quote?: string }>,
  textEvidence: Array<{ evidence_id: string; text: string }>,
): ModelOutcomeRejectedCitationT[] {
  const slots = new Map(request.slot_responses.map((entry) => [entry.slot_id, entry]));
  const evidenceIds = new Set([
    ...request.slot_responses.flatMap((entry) =>
      entry.kind === 'open' ? entry.evidence.map((item) => item.evidence_id) : [],
    ),
    ...request.group_evidence.map((item) => item.evidence.evidence_id),
  ]);
  const rejected: ModelOutcomeRejectedCitationT[] = [];
  for (const citation of citations) {
    const slotId = citation.slot_id || null;
    const evidenceId = citation.evidence_id || null;
    const slotKnown = slotId !== null && slots.has(slotId);
    const evidenceKnown = evidenceId !== null && evidenceIds.has(evidenceId);
    const record = {
      ...(slotKnown ? { slot_id: slotId } : {}),
      ...(slotId !== null && !slotKnown
        ? {
            claimed_slot_id_length: slotId.length,
            ...(slotId.length >= 16 ? { claimed_slot_id_sha256: sha256Hex(slotId) } : {}),
          }
        : {}),
      ...(evidenceKnown ? { evidence_id: evidenceId } : {}),
      ...(evidenceId !== null && !evidenceKnown
        ? {
            claimed_evidence_id_length: evidenceId.length,
            ...(evidenceId.length >= 16
              ? { claimed_evidence_id_sha256: sha256Hex(evidenceId) }
              : {}),
          }
        : {}),
      ...(citation.quote !== undefined
        ? {
            ...(citation.quote.length >= 16 ? { quote_sha256: sha256Hex(citation.quote) } : {}),
            quote_length: citation.quote.length,
          }
        : {}),
    };
    let problem: ModelOutcomeRejectedCitationT['problem'] | null = null;
    if (slotId === null && evidenceId === null) {
      problem = 'no_target';
    } else if (slotId !== null && !slotKnown) {
      problem = 'unknown_slot';
    } else if (evidenceId !== null && !evidenceKnown) {
      problem = 'unknown_evidence';
    } else if (citation.quote !== undefined) {
      const entry = slotId !== null ? slots.get(slotId) : undefined;
      const text =
        entry && (entry.kind === 'text' || entry.kind === 'open') ? entry.text_md : undefined;
      const evidenceText = textEvidence.find(
        (item) => item.evidence_id === citation.evidence_id,
      )?.text;
      const quote = citation.quote;
      if (
        ![text, evidenceText].some(
          (source) => source !== undefined && isOriginalEvidenceQuote({ source, quote }),
        )
      ) {
        problem = 'non_original_quote';
      }
    }
    if (problem !== null) rejected.push({ problem, ...record });
  }
  return rejected;
}

/**
 * 决策被冻结判据拒收时记录决策形状与目标 id：与发布 rule/level 一致的 id
 * 记原文（那是我们发布的数据），不一致的 claimed id 只记 sha256。
 */
function decisionDiagnostics(
  request: ModelExecutorRequest,
  decision: AssessmentRuleDecisionT,
): ModelOutcomeDiagnosticsT {
  const criterion = request.unit.criterion;
  // pending 决策在早退分支已返回；此出口只可能收到 rule/level 决策。
  if (decision.kind === 'pending') return { check: 'decision_criterion_mismatch' };
  const summary =
    decision.kind === 'rule'
      ? {
          kind: 'rule' as const,
          criterion_kind: criterion.kind,
          ...(criterion.kind === 'rule_reference' && decision.rule_id === criterion.rule_id
            ? { rule_id: decision.rule_id }
            : {
                rule_id_length: decision.rule_id.length,
                ...(decision.rule_id.length >= 16
                  ? { rule_id_sha256: sha256Hex(decision.rule_id) }
                  : {}),
              }),
          points_awarded: decision.points_awarded,
          unit_points: request.unit.points,
        }
      : {
          kind: 'level' as const,
          criterion_kind: criterion.kind,
          ...(criterion.kind === 'holistic_level' &&
          criterion.levels.some((level) => level.level_id === decision.level_id)
            ? { level_id: decision.level_id }
            : {
                level_id_length: decision.level_id.length,
                ...(decision.level_id.length >= 16
                  ? { level_id_sha256: sha256Hex(decision.level_id) }
                  : {}),
              }),
          unit_points: request.unit.points,
        };
  return { check: 'decision_criterion_mismatch', decision: summary };
}

/** Standalone native pi lane, selected only by an explicit published task and descriptor. */
export function createPiModelExecutor(options: PiModelExecutorOptions): ModelUnitExecutorPort {
  const execute: ModelUnitExecutorPort = async (request, callerSignal) => {
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
    if (cap <= 0) {
      return pending({
        reason: 'unjudgeable',
        detail: 'native model cost or wall-clock budget exhausted',
      });
    }
    const transientPolicy =
      options.providerTransientRetry === true ? providerTransientRetryPolicy() : undefined;
    const retryBudget = { retries: 0, waitedMs: 0 };
    const priorRefs: string[] = [];
    let knownSpent = 0;
    let unknownAttempts = 0;
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
      const signal = AbortSignal.any([
        AbortSignal.timeout(Math.min(remaining, budget.timeout)),
        ...[options.signal, callerSignal].filter(
          (value): value is AbortSignal => value !== undefined,
        ),
      ]);
      const taskRunId = priorRefs.length === 0 ? (options.taskRunId ?? randomUUID()) : randomUUID();
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
        if (!prepared.ok) return pending(prepared.pending, priorRefs);
        signal.throwIfAborted();
        const runTask = options.runTask ?? (await import('@/server/ai/runner')).runTask;
        result = await withinAssessmentSignal(
          () =>
            runTask('AssessmentRuleJudgeTask', prepared.input, {
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
        // Unknown cost consumes the full admitted reservation; the runner's ledger
        // retains unknown vs reported/estimated truth. Never represent it as free.
        cost =
          result.cost_usd !== undefined && Number.isFinite(result.cost_usd) && result.cost_usd >= 0
            ? Math.ceil(result.cost_usd * 1_000_000)
            : cap;
        const refs = [...priorRefs, result.task_run_id];
        const settledCost = unknownAttempts === 0 ? knownSpent + cost : undefined;
        if (cost > cap || (settledCost !== undefined && settledCost > cap))
          return pending(
            { reason: 'unjudgeable', detail: 'native model exceeded the admitted call cost cap' },
            refs,
            settledCost ?? cost,
            {
              check: 'cost_cap_exceeded',
              cost: { cost_usd_micros: settledCost ?? cost, cap_usd_micros: cap },
            },
          );
        const modelResult = result;
        const decision = await traceOperation(
          'assessment.parse',
          { task_run_id: result.task_run_id },
          async () =>
            AssessmentRuleDecision.parse(
              modelResult.structured_output ?? JSON.parse(modelResult.text.trim()),
            ),
          {
            content: isLaminarTracingEnabled()
              ? { input: assessmentTraceInput(request), output: assessmentParseTraceOutput }
              : undefined,
          },
        );
        // Pending citations are validated by the model schema but cannot supply a score.
        // The domain pending outcome retains only its reason and paid run provenance.
        if (decision.kind === 'pending') {
          // wire 只在本分支需要（诊断要 citable 来源计数）—— 非 pending 路径在
          // 下方同一位置解析，判分路径的顺序逐位不变。
          const wire = JSON.parse(prepared.input.text) as {
            text_evidence: Array<{ evidence_id: string; text: string }>;
          };
          const declinedCitations = citationRejections(
            request,
            decision.evidence_citations ?? [],
            wire.text_evidence,
          );
          return pending(
            { reason: 'insufficient_evidence', detail: decision.detail },
            refs,
            settledCost,
            {
              check: 'model_declined',
              citable_sources: citableSources(request, wire.text_evidence),
              ...(declinedCitations.length > 0
                ? {
                    rejected_citations: declinedCitations.slice(0, 16),
                    rejected_citation_count: declinedCitations.length,
                  }
                : {}),
            },
          );
        }
        const wire = JSON.parse(prepared.input.text) as {
          text_evidence: Array<{ evidence_id: string; text: string }>;
        };
        const rejectedCitations = citationRejections(
          request,
          decision.evidence_citations,
          wire.text_evidence,
        );
        if (rejectedCitations.length > 0) {
          return pending(
            {
              reason: 'unjudgeable',
              detail: 'model cited unsubmitted evidence or a non-original textual quote',
            },
            refs,
            settledCost,
            {
              check: 'citation_validation',
              rejected_citations: rejectedCitations.slice(0, 16),
              rejected_citation_count: rejectedCitations.length,
              citable_sources: citableSources(request, wire.text_evidence),
            },
          );
        }
        const common = {
          feedback_md: decision.feedback_md,
          evidence_citations: decision.evidence_citations,
          confidence: decision.confidence,
          ...(decision.kc_mastery_evidence
            ? { kc_mastery_evidence: decision.kc_mastery_evidence }
            : {}),
          run_refs: refs,
          ...(settledCost === undefined ? {} : { cost_usd_micros: settledCost }),
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
            ...(decision.probe_signature_match
              ? { probe_signature_match: decision.probe_signature_match }
              : {}),
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
          refs,
          settledCost,
          decisionDiagnostics(request, decision),
        );
      } catch (error) {
        const refs = result
          ? [...priorRefs, result.task_run_id]
          : error instanceof AgentRunError
            ? [...priorRefs, error.taskRunId]
            : providerStarted
              ? [...priorRefs, taskRunId]
              : [...priorRefs];
        if (transientPolicy !== undefined) {
          const plan = await planProviderTransientRetry({
            db: options.db,
            error,
            policy: transientPolicy,
            budget: retryBudget,
            deadlineAt: options.deadlineAt,
          });
          if (plan !== undefined) {
            retryBudget.retries += 1;
            retryBudget.waitedMs += plan.delayMs;
            const reported =
              error instanceof AgentRunError &&
              error.costUsd !== undefined &&
              Number.isFinite(error.costUsd) &&
              error.costUsd >= 0
                ? Math.ceil(error.costUsd * 1_000_000)
                : undefined;
            if (reported !== undefined) knownSpent += reported;
            else unknownAttempts += 1;
            priorRefs.splice(0, priorRefs.length, ...refs);
            if (plan.delayMs > 0) {
              // The per-attempt timeout already fired for this attempt; the
              // backoff belongs to the invocation, so it must not be killed
              // by a stale attempt signal.
              try {
                await sleepMs(
                  plan.delayMs,
                  AbortSignal.any([
                    AbortSignal.timeout(Math.max(0, options.deadlineAt - Date.now())),
                    ...[options.signal, callerSignal].filter(
                      (value): value is AbortSignal => value !== undefined,
                    ),
                  ]),
                );
              } catch {
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
            }
            continue;
          }
        }
        if (
          error instanceof AgentRunError &&
          error.costUsd !== undefined &&
          Number.isFinite(error.costUsd) &&
          error.costUsd >= 0
        ) {
          cost = Math.ceil(error.costUsd * 1_000_000);
        }
        const callCost = cost ?? (providerStarted ? cap : undefined);
        return pending(
          {
            reason: 'infra_failure',
            retryable: false,
            detail: signal.aborted
              ? 'native model deadline/cancellation reached'
              : 'native model asset, execution or output validation failed',
          },
          refs,
          unknownAttempts === 0 && callCost !== undefined ? knownSpent + callCost : undefined,
        );
      }
    }
  };
  return (request, callerSignal) =>
    traceOperation(
      'assessment.execute',
      { task_kind: 'AssessmentRuleJudgeTask' },
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
