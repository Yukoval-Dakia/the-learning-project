// YUK-1049 — Jev model executor: ModelUnitExecutorPort implementation for
// evaluateSubmissionCore's admitted model_executor lane.
//
// Placement (grounding §4.3): TypeSafe transport lives in src/server/ai/
// (typed-primitive-runner.ts); THIS module owns the translation between the
// frozen assessment contract (scoring unit criterion, slot responses, shared
// materials, group evidence) and the typed wire contract — plus the
// APPLICATION-LAYER Jev→advanced upgrade (OpenRouter has no models-array
// fallback on the decisions wire, so escalation is a separate invocation
// inside the SAME wall-clock deadline).
//
// Supported criteria (D17/narrow-judgment boundary, grounding §3.1–3.2):
//   - rule_reference  → noul  (satisfaction probability; explicit threshold
//                             decides scored vs. counter-evidence — a policy
//                             input, never a global constant the adapter
//                             invents)
//   - holistic_level  → score (probability-weighted expectation; argmax over
//                             the LEVEL ORDER picks matched.level_id — the
//                             expectation itself is never treated as points)
// deterministic kinds (option_set_key / text_key / numeric_key /
// matching_pairs_key) belong to comparators, not Jev — a plan that routes
// them to a model_executor gets an explicit unjudgeable pending, not a
// guessed judgment. Jev is text-only: units whose answers carry attachment
// evidence escalate to the advanced executor or pending (never pretend).

import type {
  GroupEvidenceT,
  ModelExecutorRequest,
  ModelUnitExecutorPort,
  ModelUnitOutcomeT,
  SlotResponseT,
} from '@/core/schema/assessment';
import type { JevSystemOneResponseT } from '@/core/schema/jev-systemone';
import type { Db } from '@/db/client';
import { AgentRunError } from '@/server/ai/agent-run-error';
import { runTypedPrimitiveTask } from '@/server/ai/typed-primitive-runner';

const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
/** Admission/credentials-adjacent pending when no Jev lane can serve a unit. */
const NO_JEV_DETAIL =
  'no credentialed Jev lane (OPENROUTER_API_KEY absent) and no approved advanced executor supplied';

export interface JevModelExecutorOptions {
  readonly db: Db;
  /**
   * Absolute wall-clock bound (ms epoch) for ONE port invocation: Jev
   * retries AND the advanced fallback invocation share it. Required —
   * "总时限覆盖重试及 fallback" is a release condition, not a default.
   */
  readonly deadlineAt: number;
  /**
   * Approved advanced executor invoked (same ModelExecutorRequest) when Jev
   * cannot serve the unit: missing credentials, permanent failure after
   * retries, unsupported criterion, or evidence-bearing answers. It runs as
   * a separate invocation bounded by the remaining deadline — never an
   * OpenRouter models-array fallback.
   */
  readonly advancedExecutor?: ModelUnitExecutorPort;
  /**
   * rule_reference noul ≥ threshold ⇒ satisfied. REQUIRED whenever a
   * rule_reference unit is dispatched — thresholds are per-slice policy
   * (grounding §3.2: no global default is invented here).
   */
  readonly ruleThreshold?: number;
  /** Caller cancellation forwarded to the typed runner. */
  readonly signal?: AbortSignal;
  /** Test seam: replace ONLY the wire transport (never the lifecycle). */
  readonly fetchImpl?: typeof fetch;
  /** Test seam: clock override. */
  readonly now?: () => number;
}

const pendingOutcome = (
  pending: ModelUnitOutcomeT extends never
    ? never
    : Extract<ModelUnitOutcomeT, { kind: 'pending' }>['pending'],
): ModelUnitOutcomeT => ({
  kind: 'pending',
  pending,
  run_refs: [],
});

function entriesForUnit(request: ModelExecutorRequest): SlotResponseT[] {
  const wanted = new Set(request.unit.slot_refs);
  const scoped = request.slot_responses.filter((entry) => wanted.has(entry.slot_id));
  return scoped.length > 0 ? scoped : request.slot_responses;
}

/** Jev sees TEXT evidence only; attachment evidence needs the advanced lane. */
function carriesAttachmentEvidence(request: ModelExecutorRequest): boolean {
  if (request.group_evidence.length > 0) return true;
  return entriesForUnit(request).some(
    (entry) => entry.kind === 'open' && entry.evidence.length > 0,
  );
}

function projectSlotResponse(entry: SlotResponseT): Record<string, unknown> {
  switch (entry.kind) {
    case 'choice':
      return { slot_id: entry.slot_id, kind: entry.kind, option_ids: entry.option_ids };
    case 'text':
      return { slot_id: entry.slot_id, kind: entry.kind, text_md: entry.text_md };
    case 'numeric':
      return {
        slot_id: entry.slot_id,
        kind: entry.kind,
        value: entry.value,
        raw_input: entry.raw_input,
      };
    case 'formula':
      return { slot_id: entry.slot_id, kind: entry.kind, latex: entry.latex };
    case 'matching':
      return { slot_id: entry.slot_id, kind: entry.kind, pairs: entry.pairs };
    case 'ordering':
      return { slot_id: entry.slot_id, kind: entry.kind, item_order: entry.item_order };
    case 'open':
      return { slot_id: entry.slot_id, kind: entry.kind, text_md: entry.text_md };
  }
}

function typedState(
  request: ModelExecutorRequest,
  entries: SlotResponseT[],
  groupEvidence: GroupEvidenceT[],
): Record<string, unknown> {
  return {
    submission: {
      entries: entries.map((entry) => projectSlotResponse(entry)),
      group_evidence: groupEvidence.map((item) => ({
        evidence_id: item.evidence.evidence_id,
        kind: item.evidence.kind,
        note: 'attachment evidence present (not text-visible to this executor)',
      })),
    },
    materials: request.materials.map((material) => ({
      material_id: material.material_id,
      kind: material.kind,
      ...(material.caption !== undefined ? { caption: material.caption } : {}),
      ...(material.alt_text !== undefined ? { alt_text: material.alt_text } : {}),
      ...(material.content_md !== undefined ? { content_md: material.content_md } : {}),
    })),
  };
}

function questionsForUnit(
  request: ModelExecutorRequest,
): Record<string, unknown> | { unsupported: string } {
  const criterion = request.unit.criterion;
  switch (criterion.kind) {
    case 'rule_reference':
      return {
        [request.scoring_unit_id]: {
          type: 'noul',
          instructions: 'Does the submission satisfy the published scoring rule?',
          criteria: {
            true: criterion.statement_md,
            false: `The submission does NOT satisfy: ${criterion.statement_md}`,
          },
        },
      };
    case 'holistic_level': {
      const ordered = [...criterion.levels].sort((a, b) => a.rank - b.rank);
      return {
        [request.scoring_unit_id]: {
          type: 'score',
          instructions: 'Which published performance level best matches the submission?',
          criteria: ordered.map((level) => `${level.level_id}: ${level.descriptor_md}`),
        },
      };
    }
    default:
      return { unsupported: criterion.kind };
  }
}

function interpretAnswer(
  request: ModelExecutorRequest,
  answer: JevSystemOneResponseT['answers'][string],
  ruleThreshold: number,
  runRefs: string[],
  costMicros: number | undefined,
): ModelUnitOutcomeT {
  const unit = request.unit;
  const criterion = unit.criterion;
  if (criterion.kind === 'rule_reference' && answer.type === 'noul') {
    if (unit.points == null) {
      return pendingOutcome({
        reason: 'unjudgeable',
        detail: `rule_reference unit '${request.scoring_unit_id}' has no additive points to award`,
      });
    }
    const satisfied = answer.noul >= ruleThreshold;
    return {
      kind: 'scored',
      // 0 points on counter-evidence is a REAL score, not a pending state.
      points_awarded: satisfied ? unit.points : 0,
      matched: satisfied ? { rule_id: criterion.rule_id, option_ids: [] } : undefined,
      // Jev emits no evidence citations — never fabricate them (§3.2).
      evidence_citations: [],
      // Distribution-shape confidence: 1 at the extremes, 0 at 0.5 — the
      // escalation gate reads shape, not accuracy (spec: never fabricate).
      confidence: answer.confidence ?? 1 - Math.abs(2 * answer.noul - 1),
      run_refs: runRefs,
      ...(costMicros !== undefined ? { cost_usd_micros: costMicros } : {}),
    };
  }
  if (criterion.kind === 'holistic_level' && answer.type === 'score') {
    const ordered = [...criterion.levels].sort((a, b) => a.rank - b.rank);
    let levelIndex: number;
    const probabilities = answer.probabilities;
    if (probabilities && Object.keys(probabilities).length > 0) {
      // Argmax over the declared level ORDER (index space, not level_ids).
      let best = 0;
      let bestProb = -1;
      for (let i = 0; i < ordered.length; i++) {
        const p = probabilities[String(i)] ?? 0;
        if (p > bestProb) {
          bestProb = p;
          best = i;
        }
      }
      levelIndex = best;
    } else {
      // Optional-schema absence ⇒ deterministic argmax-by-expectation over
      // the same order; documented fallback, never a fabricated distribution.
      levelIndex = Math.min(ordered.length - 1, Math.max(0, Math.round(answer.score)));
    }
    const level = ordered[levelIndex];
    return {
      kind: 'scored',
      // Holistic units never carry additive points (level_points resolves
      // the score at aggregation); the expectation is NOT student points.
      points_awarded: unit.points ?? null,
      matched: { level_id: level.level_id, option_ids: [] },
      evidence_citations: [],
      ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      run_refs: runRefs,
      ...(costMicros !== undefined ? { cost_usd_micros: costMicros } : {}),
    };
  }
  return pendingOutcome({
    reason: 'infra_failure',
    retryable: false,
    detail: `typed answer type '${answer.type}' does not match criterion '${criterion.kind}'`,
  });
}

/**
 * Build the ModelUnitExecutorPort for the admitted Jev lane.
 *
 * Escalation order per unit:
 *   unsupported criterion / attachment evidence / missing credentials /
 *   unadmitted slice (defensive — the core gates it before the port) →
 *   advancedExecutor when supplied, else an explicit pending state;
 *   permanent Jev failure (401/422/contract/budget) → advanced or
 *   non-retryable infra_failure; transient-exhausted → advanced or retryable.
 */
export function createJevModelExecutor(options: JevModelExecutorOptions): ModelUnitExecutorPort {
  const now = options.now ?? Date.now;
  const escalate = async (
    request: ModelExecutorRequest,
  ): Promise<ModelUnitOutcomeT | undefined> => {
    if (options.advancedExecutor === undefined) return undefined;
    const remaining = options.deadlineAt - now();
    if (remaining <= 0) {
      return pendingOutcome({
        reason: 'infra_failure',
        retryable: false,
        detail: 'shared wall-clock deadline elapsed before advanced executor could start',
      });
    }
    try {
      // The advanced invocation is app-layer (OR has no models fallback);
      // it shares the SAME deadline — a timeout loses to the race and the
      // outcome stays an honest pending rather than a silent overspend.
      return await Promise.race([
        options.advancedExecutor(request),
        new Promise<ModelUnitOutcomeT>((_, reject) =>
          setTimeout(() => reject(new Error('advanced executor deadline exceeded')), remaining),
        ),
      ]);
    } catch (error) {
      return pendingOutcome({
        reason: 'infra_failure',
        retryable: true,
        detail: `advanced executor failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return async (request) => {
    // Defensive admission checks — the core normally gates all of these
    // before the port is ever invoked; the port still refuses closed.
    if (request.executor.admitted_slice_id === null) {
      return pendingOutcome({
        reason: 'unjudgeable',
        detail:
          'model_executor slice unadmitted (D17) — the Jev port never serves unadmitted units',
      });
    }
    if (request.executor.task_kind !== 'JevScoringDecisionTask') {
      return pendingOutcome({
        reason: 'unjudgeable',
        detail: `executor task_kind '${request.executor.task_kind}' is not a registered Jev typed task`,
      });
    }

    const questions = questionsForUnit(request);
    if ('unsupported' in questions) {
      const escalated = await escalate(request);
      return (
        escalated ??
        pendingOutcome({
          reason: 'unjudgeable',
          detail: `criterion '${questions.unsupported}' is deterministic-comparator territory — not Jev-expressible; no advanced executor supplied`,
        })
      );
    }
    const entries = entriesForUnit(request);
    if (carriesAttachmentEvidence(request)) {
      const escalated = await escalate(request);
      return (
        escalated ??
        pendingOutcome({
          reason: 'insufficient_evidence',
          detail:
            'submission carries non-text evidence; Jev is text-only — route to an advanced/vision executor or review',
        })
      );
    }
    if (request.unit.criterion.kind === 'rule_reference' && options.ruleThreshold === undefined) {
      return pendingOutcome({
        reason: 'unjudgeable',
        detail:
          'rule_reference unit requires an explicit per-slice ruleThreshold — the adapter invents no global default',
      });
    }
    if (!process.env[OPENROUTER_KEY_ENV]) {
      const escalated = await escalate(request);
      return (
        escalated ??
        pendingOutcome({ reason: 'infra_failure', retryable: false, detail: NO_JEV_DETAIL })
      );
    }

    let outcome: Awaited<ReturnType<typeof runTypedPrimitiveTask<JevSystemOneResponseT>>>;
    try {
      outcome = await runTypedPrimitiveTask<JevSystemOneResponseT>(
        request.executor.task_kind,
        {
          state: typedState(request, entries, request.group_evidence),
          questions,
        },
        {
          db: options.db,
          deadlineAt: options.deadlineAt,
          signal: options.signal,
          fetchImpl: options.fetchImpl,
          logScope: 'jevModelExecutor',
        },
      );
    } catch (error) {
      const escalated = await escalate(request);
      if (escalated !== undefined) return escalated;
      return pendingOutcome({
        reason: 'infra_failure',
        retryable: isTypedRetryable(error),
        detail: `Jev lane failed${error instanceof Error ? `: ${error.message}` : ''}`,
      });
    }

    const answer = outcome.output.answers[request.scoring_unit_id];
    if (answer === undefined) {
      return pendingOutcome({
        reason: 'infra_failure',
        retryable: false,
        detail: `typed response omitted answer for unit '${request.scoring_unit_id}'`,
      });
    }
    const costMicros =
      outcome.cost_usd === undefined
        ? undefined
        : Math.max(0, Math.round(outcome.cost_usd * 1_000_000));
    return interpretAnswer(
      request,
      answer,
      options.ruleThreshold ?? Number.NaN,
      [outcome.task_run_id],
      costMicros,
    );
  };
}

function isTypedRetryable(error: unknown): boolean {
  // AgentRunError api_error_result: transient statuses (null/429/5xx) mean the
  // runner already spent its retry budget inside the deadline → still
  // retryable at the attempt level; permanent statuses (401/422) → not.
  if (error instanceof AgentRunError) {
    if (error.subtype === 'api_error_result') {
      const status = error.apiErrorStatus;
      return status === null || status === undefined || status === 429 || status >= 500;
    }
    return false; // budget_timeout / contract / runner_error: per-invocation terminal
  }
  return true;
}
