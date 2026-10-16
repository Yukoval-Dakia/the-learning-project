// ====================================================================
// YUK-1496 C2 — AI rubric model executor：free 单元的逐 criterion 评分细则
// 判定（统一设计 §3 free 段 / §4 ai-rubric 行 / 附录 A5；ADR-0073 D7
// 解答/简答/语文阅读）。
//
// 纪律（与 pi-model-executor 同律）：
//   - 模型只返回逐 criterion 的 award + 理由 + 证据引用；代码校验 criterion
//     id 恰好覆盖发布细则、award ∈ allowed_awards，然后求和 —— 模型不得
//     新增评分点、修改满分或自报总分（输出契约没有 total 字段）；
//   - 图片纪律：prepareAssessmentModelInput 只在原图真实送达（digest 核验
//     后作为 image block 附上）时才放行；没读到原图不得声称读了 —— 引用未
//     送达/不存在的证据，或对图片证据附“引文”，一律 pending，不猜分；
//   - 费用诚实：truth 层（run 台账）unknown 保持 unknown；charge 层
//     （outcome.cost_usd_micros）对 unknown 成本按整段准入预留 cap 计费 ——
//     绝不记为零（不虚报已知，也不削弱计划级费用上限）。超 cap ⇒ pending。
// ====================================================================

import { randomUUID } from 'node:crypto';
import { resolveTaskBudget } from '@/capabilities/task-registry';
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
import { AgentRunError } from '@/server/ai/agent-run-error';
import {
  isLaminarTracingEnabled,
  traceMetadata,
  traceOperation,
} from '@/server/ai/laminar-tracing';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';
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

/** 档位比对（相对 ε=1e-9）：卷面十进制档位（0.5 等）不因二进制表示误差误判。 */
function sameAward(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * 证据引用核验：引用的 slot / evidence 必须在本次输入里真实存在；quote 必须
 * 是作答原文或已送达文本证据的原句；图片证据只可凭 evidence_id 引用（它真实
 * 随 image block 送达），不得附引文 —— 模型没读到的东西不能声称读过。
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

/**
 * 逐 criterion award 校验 + 求和。任何一项不符（未知/缺失/重复 id、档位越界）
 * ⇒ null（调用方落 pending，绝不猜分）。模型输出契约里没有总分字段。
 */
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

/** Rubric lane：native pi 任务，按发布细则逐 criterion 判定。 */
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
    const taskRunId = options.taskRunId ?? randomUUID();
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
      // Unknown cost consumes the full admitted reservation; the runner's ledger
      // retains unknown vs reported/estimated truth. Never represent it as free.
      cost =
        result.cost_usd !== undefined && Number.isFinite(result.cost_usd) && result.cost_usd >= 0
          ? Math.ceil(result.cost_usd * 1_000_000)
          : cap;
      if (cost > cap) {
        return pending(
          { reason: 'unjudgeable', detail: 'native model exceeded the admitted call cost cap' },
          [result.task_run_id],
          cost,
        );
      }
      const modelResult = result;
      const decision = AssessmentRubricDecision.parse(
        modelResult.structured_output ?? JSON.parse(modelResult.text.trim()),
      );
      if (decision.kind === 'pending') {
        return pending(
          { reason: 'insufficient_evidence', detail: decision.detail },
          [result.task_run_id],
          cost,
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
          [result.task_run_id],
          cost,
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
          [result.task_run_id],
          cost,
        );
      }
      return {
        kind: 'scored',
        points_awarded: total,
        ...(decision.feedback_md !== undefined ? { feedback_md: decision.feedback_md } : {}),
        evidence_citations: citations,
        ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
        run_refs: [result.task_run_id],
        cost_usd_micros: cost,
      };
    } catch (error) {
      if (
        error instanceof AgentRunError &&
        error.costUsd !== undefined &&
        Number.isFinite(error.costUsd) &&
        error.costUsd >= 0
      ) {
        cost = Math.ceil(error.costUsd * 1_000_000);
      }
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
        // Charge-layer parity with the pi lane: an unknown cost after the provider
        // started consumes the full admitted reservation — never billed as free.
        cost ?? (providerStarted ? cap : undefined),
      );
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
