// YUK-406 (Phase 0 关系脑) / YUK-440 (A13) — conjecture induction orchestrator
// with D2 mitigation.
//
// PURE (no DB / no R2): the 取证 sibling (@/capabilities/agency/server/conjecture/evidence) assembles
// the EvidenceCell list deterministically (cause_category × KC recurrence via
// effectiveCauseForFailureAttempt + θ̂ / θ precision + baseline p(L) from
// mastery_state — no LLM), and the nightly 例会 job persists the result. This module
// ONLY runs the LLM induction and applies the D2 mitigations, taking an injected
// runTaskFn so it is unit-testable with a fake.
//
// D2 (CORRECTED per YUK-416 — NO heterogeneous mimo+Opus Jury; that is DEFERRED):
//   1. Opus SELF-CONSISTENCY — run the SAME MindModelInductionTask N times on the
//      Opus (anthropic-sub OAuth) lane; cluster samples by the full hypothesis
//      (claim + frozen DiagnosticSpec); the dominant hypothesis wins and its agreement
//      fraction (agreement / samples) IS the confidence.
//   2. JUDGE-ONLY-EVIDENCE CAP — if EVERY supporting evidence cell is agent-judge
//      with no owner cause, cap confidence at JUDGE_ONLY_CONFIDENCE_CAP (the owner
//      never corroborated it, so the team must not be loud about it).
//   3. PROBE QUALITY GATE (YUK-821) — only after consensus, a separate author task
//      writes a two-probe package and an independent same-model call reviews it.
//      One whole-pair regeneration is allowed; a second quality failure abstains.
//
// confidence is INTERNAL calibration only — returned as a number here for
// sorting/calibration but NEVER rendered to the owner as a number (Phase 0 rule).
//
// A13 (YUK-440): predicted_p is authored only after the hypothesis is frozen. The
// accepted package's bet is P(owner answers the primary probe correctly | claim holds);
// `discriminating=true` now means the package passed structural and independent semantic
// review rather than being a self-asserted induction field.

import {
  CONJECTURE_ABSTAIN_EXPLANATION_MAX_LENGTH,
  type ConjectureAbstainDraftT,
  type ConjectureAbstainReasonT,
  ConjectureHypothesisAuthorDraft,
  type ConjectureHypothesisDraftT,
  type ConjectureHypothesisProposalDraftT,
  type ConjectureModelAbstainDraftT,
  type ConjectureProbeQualityAttemptT,
  type ConjectureProposalDraftT,
} from '@/core/schema/business';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import {
  type TaskTextResult,
  type TaskTextRunFn,
  sumAllKnownCostUsd,
} from '@/server/ai/provenance';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';
import type { EnrichedEvidenceCell, LoadedConjectureEvidenceImage } from './evidence';
import {
  ConjectureProbeQualityOperationalError,
  type ConjectureProbeQualityTaskKind,
  type PrepareConjectureProbePairResult,
  prepareConjectureProbePair,
} from './probe-quality';
import { jsonObjectCandidates, parseTaskStructuredOutput } from './structured-output';

export interface InduceConjectureInput {
  /**
   * 取证 cells for ONE candidate (the job passes one salient cell), each carrying
   * its YUK-786 grounding packet. The ENRICHED type is required, not optional:
   * a bare cell is 7 opaque scalars, and inducing a domain-specific claim from
   * that is the exact failure mode this contract exists to make unrepresentable.
   */
  cells: EnrichedEvidenceCell[];
  /**
   * Real image bytes resolved once per unique asset in first-occurrence order.
   * The task input manifest binds each image block back to every attempt/source
   * occurrence without duplicating the base64 payload.
   */
  evidenceImages?: LoadedConjectureEvidenceImage[];
  /** N self-consistency samples (>= 1). The nightly job passes 3. */
  samples: number;
  /** injected runner — the job wraps the real runTask (with db); faked in tests. */
  runTaskFn: TaskTextRunFn;
  /** prior conjecture claim being updated, if any (owner-correction anchor feed). */
  priorClaimMd?: string;
  /**
   * YUK-786 — subject context for the prompt render, resolved by the job from
   * the cell's KC domain. Omitted ⇒ the neutral `general` profile (an untagged
   * KC must not inherit a concrete subject's voice).
   */
  subjectProfile?: SubjectProfile;
}

export type ConjectureInductionTaskKind =
  | 'MindModelInductionTask'
  | 'ConjectureGroupingTask'
  | ConjectureProbeQualityTaskKind;

/**
 * Preserves the failing orchestration stage across the nightly cell-local
 * failure boundary so operational health is attributed to the component that
 * actually needs retry/repair.
 */
export class ConjectureInductionOperationalError extends Error {
  readonly taskKind: ConjectureInductionTaskKind;

  constructor(taskKind: ConjectureInductionTaskKind, message: string) {
    super(message);
    this.name = 'ConjectureInductionOperationalError';
    this.taskKind = taskKind;
  }
}

interface InduceConjectureResultBase {
  /** internal calibration in [0,1]; NEVER rendered as a number to the owner. */
  confidence: number;
  confidence_capped: boolean;
  samples: number;
  /** task_run_ids of every completed sample plus semantic-grouping run, if used. */
  task_run_ids: string[];
  cost_usd: number | null;
  /** Every requested sample remains visible in the decision denominator. */
  votes: {
    proposal: number;
    abstain: number;
    invalid: number;
    failed: number;
  };
  /** Author/reviewer quality attempts; persisted for both pass and fail-closed abstain. */
  probe_quality_attempts: ConjectureProbeQualityAttemptT[];
}

export type InduceConjectureResult =
  | (InduceConjectureResultBase & {
      outcome: 'proposal';
      draft: ConjectureProposalDraftT;
      /** Probe-author run that produced the verified pair (scalar correlation anchor). */
      primary_task_run_id: string | null;
    })
  | (InduceConjectureResultBase & {
      outcome: 'abstain';
      draft: ConjectureAbstainDraftT;
    });

/** Confidence ceiling when ALL evidence is agent-judge (no owner corroboration). */
export const JUDGE_ONLY_CONFIDENCE_CAP = 0.5;
/** A grounded proposal needs recurrence, not one isolated attempt. */
export const MIN_GROUNDED_PROPOSAL_EVIDENCE = 2;

const ConjectureHypothesisStructuredOutput = z.object({
  draft: ConjectureHypothesisAuthorDraft,
});

interface GroundedHypothesisSample {
  draft: ConjectureHypothesisProposalDraftT;
  task_run_id: string | undefined;
}

function parseSampleDraft(result: TaskTextResult): ConjectureHypothesisDraftT | null {
  const parsed = parseTaskStructuredOutput(result, ConjectureHypothesisAuthorDraft, 'draft');
  if (!parsed) return null;
  return parsed.kind === 'abstain'
    ? { ...parsed, evidence_event_ids: parsed.evidence_event_ids ?? [] }
    : parsed;
}

/** Normalize a claim for clustering (case + whitespace insensitive). */
function claimKey(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tallyReasons<T extends string>(reasons: T[]): Array<{ reasonCode: T; count: number }> {
  const counts = new Map<T, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count || compareLex(a.reasonCode, b.reasonCode));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hypothesisKey(draft: ConjectureHypothesisProposalDraftT): string {
  return JSON.stringify({
    claim_md: claimKey(draft.claim_md),
    diagnostic_spec: Object.fromEntries(
      Object.entries(draft.diagnostic_spec).map(([key, value]) => [
        key,
        typeof value === 'string' ? claimKey(value) : value,
      ]),
    ),
  });
}

/** Select one complete claim+DiagnosticSpec representative; no probe exists yet. */
function aggregateDominantHypothesis(
  drafts: ConjectureHypothesisProposalDraftT[],
): ConjectureHypothesisProposalDraftT {
  const coupled = new Map<string, { count: number; draft: ConjectureHypothesisProposalDraftT }>();
  for (const draft of drafts) {
    const key = JSON.stringify([draft.claim_md, draft.diagnostic_spec, draft.cause_category]);
    const current = coupled.get(key);
    coupled.set(key, { count: (current?.count ?? 0) + 1, draft: current?.draft ?? draft });
  }
  const representative = [...coupled.entries()].sort(
    ([aKey, a], [bKey, b]) => b.count - a.count || compareLex(aKey, bKey),
  )[0][1].draft;
  return {
    ...representative,
    recurrence_count: Math.round(median(drafts.map((draft) => draft.recurrence_count))),
  };
}

function groundedEvidenceEventIds(cell: EnrichedEvidenceCell): string[] {
  return [...new Set(cell.samples.map((sample) => sample.attempt_event_id))];
}

function normalizeGroundedProposal(
  draft: ConjectureHypothesisProposalDraftT,
  cells: EnrichedEvidenceCell[],
): ConjectureHypothesisProposalDraftT | null {
  const cell = cells.find(
    (candidate) =>
      candidate.knowledge_id === draft.knowledge_id &&
      candidate.cause_category === draft.cause_category,
  );
  if (!cell) return null;

  // Only attempts whose immutable question/answer packet was quoted to the model
  // may support its claim. The cell-level list can be longer than the prompt cap.
  const allowedEvidenceIds = new Set(groundedEvidenceEventIds(cell));
  const evidenceEventIds = [...new Set(draft.evidence_event_ids)];
  if (
    evidenceEventIds.length < MIN_GROUNDED_PROPOSAL_EVIDENCE ||
    evidenceEventIds.some((eventId) => !allowedEvidenceIds.has(eventId))
  ) {
    return null;
  }

  // These facts belong to deterministic 取证, not the model. Normalizing them here
  // prevents a harmless echo mismatch while keeping fabricated KC/cause/evidence refs
  // as an invalid (negative) vote.
  return {
    ...draft,
    recurrence_count: cell.recurrence_count,
    evidence_event_ids: evidenceEventIds,
  };
}

function normalizeGroundedAbstain(
  draft: ConjectureModelAbstainDraftT,
  cells: EnrichedEvidenceCell[],
): ConjectureModelAbstainDraftT | null {
  const allowedEvidenceIds = new Set(cells.flatMap(groundedEvidenceEventIds));
  const evidenceEventIds = [...new Set(draft.evidence_event_ids)];
  if (evidenceEventIds.some((eventId) => !allowedEvidenceIds.has(eventId))) return null;
  return { ...draft, evidence_event_ids: evidenceEventIds };
}

function chooseAbstainDraft(params: {
  abstains: ConjectureModelAbstainDraftT[];
  cells: EnrichedEvidenceCell[];
  /**
   * One reason vote per requested sample. Explicit abstentions contribute their
   * model reason; invalid/provider/proposal-without-consensus outcomes contribute
   * orchestrator reasons. A tied tally is itself no semantic consensus.
   */
  reasonVotes: ConjectureAbstainReasonT[];
}): ConjectureAbstainDraftT {
  const allowedEvidenceIds = new Set(params.cells.flatMap(groundedEvidenceEventIds));
  const citedEvidenceIds = [
    ...new Set(
      params.abstains
        .flatMap((draft) => draft.evidence_event_ids)
        .filter((eventId) => allowedEvidenceIds.has(eventId)),
    ),
  ];
  const reasonTallies = tallyReasons(params.reasonVotes);
  const reason =
    reasonTallies.length === 0 || reasonTallies[0].count === reasonTallies[1]?.count
      ? 'no_semantic_consensus'
      : reasonTallies[0].reasonCode;
  const explanationFor = (targetReason: ConjectureAbstainReasonT): string | undefined =>
    params.abstains
      .filter((draft) => draft.reason_code === targetReason)
      .map((draft) => draft.explanation_md)
      .filter((value): value is string => Boolean(value))
      .sort(compareLex)[0];
  const dominantModelReason = tallyReasons(params.abstains.map((draft) => draft.reason_code))[0]
    ?.reasonCode;
  const orchestratorExplanation: Partial<Record<ConjectureAbstainReasonT, string>> = {
    no_semantic_consensus: 'Requested samples did not reach a strict semantic majority.',
    invalid_output: 'Most samples did not satisfy the structured grounding contract.',
    sample_failure: 'Most samples failed before producing a valid structured decision.',
  };
  const modelContext = dominantModelReason ? explanationFor(dominantModelReason) : undefined;
  const fallbackExplanation = [
    orchestratorExplanation[reason],
    modelContext ? `Model context: ${modelContext}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .slice(0, CONJECTURE_ABSTAIN_EXPLANATION_MAX_LENGTH);
  const explanation = explanationFor(reason) ?? (fallbackExplanation || undefined);

  return {
    kind: 'abstain',
    reason_code: reason,
    ...(explanation ? { explanation_md: explanation } : {}),
    evidence_event_ids: citedEvidenceIds,
  };
}

function baseReasonVotes(
  abstains: ConjectureModelAbstainDraftT[],
  invalidSamples: number,
  failedSamples: number,
): ConjectureAbstainReasonT[] {
  return [
    ...abstains.map((draft) => draft.reason_code),
    ...Array.from<ConjectureAbstainReasonT>({ length: invalidSamples }).fill('invalid_output'),
    ...Array.from<ConjectureAbstainReasonT>({ length: failedSamples }).fill('sample_failure'),
  ];
}

// GroupSchema: structural output contract for ConjectureGroupingTask.
// Local constant — not exported, not persisted.
const GroupSchema = z.object({
  groups: z.array(z.array(z.number().int().min(0)).min(1)).min(1),
});

interface DeduplicateHypothesesResult {
  ok: boolean;
  groups: number[][];
  cost_usd: number | null;
  task_run_id: string | undefined;
}

/**
 * Groups claim+DiagnosticSpec indices by semantic equivalence.
 *
 * Returns index groups, accumulated cost, task_run_id, and explicit health.
 * On failure the caller preserves any exact claimKey quorum already established;
 * when no exact quorum exists, grouping is load-bearing and the cell fails operationally.
 */
async function deduplicateHypotheses(
  hypotheses: Array<{
    claim_md: string;
    diagnostic_spec: ConjectureHypothesisProposalDraftT['diagnostic_spec'];
  }>,
  runTaskFn: TaskTextRunFn,
): Promise<DeduplicateHypothesesResult> {
  const failure = (
    result: Pick<TaskTextResult, 'cost_usd' | 'task_run_id'> = {},
  ): DeduplicateHypothesesResult => ({
    ok: false,
    groups: hypotheses.map((_, i) => [i]),
    cost_usd: result.cost_usd ?? null,
    task_run_id: result.task_run_id,
  });

  if (hypotheses.length <= 1) {
    return {
      ok: true,
      groups: [hypotheses.map((_, i) => i)],
      cost_usd: 0,
      task_run_id: undefined,
    };
  }

  let result: TaskTextResult;
  try {
    result = await runTaskFn(
      'ConjectureGroupingTask',
      { hypotheses },
      { outputFormat: zodToJsonSchemaOutputFormat(GroupSchema) },
    );
  } catch (err) {
    // Warn so nightly pipeline failures are observable (silent degradation masks persistent issues).
    console.warn(
      '[induceConjecture] ConjectureGroupingTask failed, preserving exact clusters:',
      err,
    );
    return failure();
  }

  // Parse structured output; then scan balanced JSON objects in the text fallback.
  const parsed = [result.structured_output, ...jsonObjectCandidates(result.text)]
    .filter((candidate) => candidate !== undefined && candidate !== null)
    .map((candidate) => GroupSchema.safeParse(candidate))
    .find((candidate) => candidate.success) ?? { success: false as const };
  if (!parsed.success) return failure(result);

  // Coverage guard: verify groups form a complete partition of 0..N-1
  // (each index appears exactly once — catches duplicates, gaps, and out-of-range indices).
  // A flat-length-only check passes e.g. [[0,0],[1]] (length=3=N but index 0 duplicated).
  const flatSorted = [...parsed.data.groups.flat()].sort((a, b) => a - b);
  const isPartition =
    flatSorted.length === hypotheses.length && flatSorted.every((v, i) => v === i);
  if (!isPartition) return failure(result);

  // The model may not erase a frozen semantic type. Refine every returned
  // semantic group by the server-owned V2 causal-direction bit before it can
  // contribute to agreement. This is deliberately a deterministic
  // postcondition rather than prompt-only enforcement: a mixed group such as
  // [true, false, true] becomes [[true, true], [false]], never a false quorum.
  const causallyHomogeneousGroups = parsed.data.groups.flatMap((group) => {
    const byCausalRequirement = new Map<string, number[]>();
    for (const index of group) {
      const diagnosticSpec = hypotheses[index]?.diagnostic_spec;
      const causalSemanticType =
        diagnosticSpec?.schema_version === 2
          ? `v2:${diagnosticSpec.causal_direction_required}`
          : 'v1:conservative';
      const bucket = byCausalRequirement.get(causalSemanticType) ?? [];
      bucket.push(index);
      byCausalRequirement.set(causalSemanticType, bucket);
    }
    return [...byCausalRequirement.values()];
  });

  return {
    ok: true,
    groups: causallyHomogeneousGroups,
    cost_usd: result.cost_usd ?? null,
    task_run_id: result.task_run_id,
  };
}

export async function induceConjecture(
  input: InduceConjectureInput,
): Promise<InduceConjectureResult> {
  const { cells, samples, runTaskFn, priorClaimMd, subjectProfile } = input;
  const evidenceImages = input.evidenceImages ?? [];
  if (samples < 1) throw new Error('induceConjecture: samples must be >= 1');
  if (cells.length === 0) throw new Error('induceConjecture: cells must be non-empty');

  const taskPayload = {
    evidence_cells: cells.map((c) => ({
      knowledge_id: c.knowledge_id,
      // YUK-786 grounding: the KC as a NAME + its subject, so the claim is
      // induced about a real knowledge point in a real subject rather than
      // about a UUID whose domain the model has to guess.
      knowledge_name: c.knowledge_name,
      subject_id: c.subject_id,
      subject_display_name: c.subject_display_name,
      cause_category: c.cause_category,
      recurrence_count: c.recurrence_count,
      theta_hat: c.theta_hat,
      theta_precision: c.theta_precision,
      baseline_p: c.baseline_p,
      evidence_event_ids: groundedEvidenceEventIds(c),
      // First-hand evidence: what was asked, what the owner answered, how they
      // say they thought, and what the attribution was. Free text arrives
      // already truncated + `<untrusted_learner_text>`-delimited by the enrich
      // step — it is DATA for analysis, never instruction.
      evidence_samples: c.samples,
    })),
    image_manifest: evidenceImages.map((image, index) => ({
      image_index: index + 1,
      asset_id: image.asset_id,
      occurrences: image.occurrences,
    })),
    ...(priorClaimMd ? { prior_claim_md: priorClaimMd } : {}),
  };
  const taskInput = {
    text: JSON.stringify(taskPayload),
    images: evidenceImages.map(({ data, mediaType }) => ({ data, mediaType })),
  };

  // Run N samples on the Opus anthropic-sub lane (override; providers.ts exempts it
  // from the AI_PROVIDER_MODEL guard via ANTHROPIC_SUB_DEFAULT_MODEL).
  const proposals: GroundedHypothesisSample[] = [];
  const abstains: ConjectureModelAbstainDraftT[] = [];
  const taskRunIds: string[] = [];
  const sampleErrors: string[] = [];
  let invalidSamples = 0;
  let failedSamples = 0;
  const costsUsd: Array<number | null | undefined> = [];
  const sampleResults = await Promise.allSettled(
    Array.from({ length: samples }, () =>
      runTaskFn('MindModelInductionTask', taskInput, {
        override: { provider: 'anthropic-sub' as const },
        // Agent SDK structured output is implemented as a custom tool whose
        // input_schema must be a top-level object and rejects a top-level
        // discriminated-union anyOf. Nest the domain union under `draft`.
        outputFormat: zodToJsonSchemaOutputFormat(ConjectureHypothesisStructuredOutput),
        // YUK-786 — the prompt renders from the SubjectProfile; without this the
        // renderer falls back to `general` even when the cell's KC is tagged.
        ...(subjectProfile ? { subjectProfile } : {}),
      }),
    ),
  );
  for (let i = 0; i < sampleResults.length; i += 1) {
    const settled = sampleResults[i];
    if (settled.status === 'fulfilled') {
      const result = settled.value;
      if (result.task_run_id) taskRunIds.push(result.task_run_id);
      costsUsd.push(result.cost_usd);
      const draft = parseSampleDraft(result);
      if (!draft) {
        invalidSamples += 1;
      } else if (draft.kind === 'abstain') {
        const grounded = normalizeGroundedAbstain(draft, cells);
        if (grounded) abstains.push(grounded);
        else invalidSamples += 1;
      } else {
        const grounded = normalizeGroundedProposal(draft, cells);
        if (grounded) proposals.push({ draft: grounded, task_run_id: result.task_run_id });
        else invalidSamples += 1;
      }
    } else {
      costsUsd.push(null);
      failedSamples += 1;
      const err = settled.reason;
      const errorMessage = err instanceof Error ? err.message : String(err);
      sampleErrors.push(`sample ${i + 1}: ${errorMessage.slice(0, 300)}`);
      // Self-consistency samples are independent. A single provider/stream failure
      // counts as non-agreement (the denominator remains `samples`) without
      // discarding valid siblings; all-failed still hits the anti-fabrication guard.
      console.warn('[induceConjecture] induction sample failed, skipping', {
        sample: i + 1,
        requested_samples: samples,
        error: errorMessage,
      });
    }
  }
  if (failedSamples === samples) {
    const details =
      sampleErrors.length > 0 ? `; failures: ${sampleErrors.slice(0, 3).join(' | ')}` : '';
    throw new ConjectureInductionOperationalError(
      'MindModelInductionTask',
      `induceConjecture: every induction sample failed${details}`,
    );
  }

  const votes = {
    proposal: proposals.length,
    abstain: abstains.length,
    invalid: invalidSamples,
    failed: failedSamples,
  };
  if (proposals.length === 0) {
    return {
      outcome: 'abstain',
      draft: chooseAbstainDraft({
        abstains,
        cells,
        reasonVotes: baseReasonVotes(abstains, invalidSamples, failedSamples),
      }),
      confidence: 0,
      confidence_capped: false,
      samples,
      task_run_ids: taskRunIds,
      cost_usd: sumAllKnownCostUsd(costsUsd),
      votes,
      probe_quality_attempts: [],
    };
  }

  // Fast path: claim + DiagnosticSpec exact clustering after normalization.
  const clusters = new Map<string, GroundedHypothesisSample[]>();
  for (const proposal of proposals) {
    const key = hypothesisKey(proposal.draft);
    const bucket = clusters.get(key) ?? [];
    bucket.push(proposal);
    clusters.set(key, bucket);
  }
  let dominant = [...clusters.entries()].sort(
    ([aKey, aDrafts], [bKey, bDrafts]) => bDrafts.length - aDrafts.length || compareLex(aKey, bKey),
  )[0][1];

  // Semantic grouping covers the complete hypothesis, including trigger/scope/wrong
  // answer signature. Claim-only agreement is insufficient.
  // This is the primary post-fast-path step, not a rare fallback — at temperature > 0
  // with N=3 on Opus, all three samples will almost always produce distinct surface
  // strings, so this call fires on essentially every nightly invocation.
  // Cost: +1 ConjectureGroupingTask (mimo default, not Opus) per conjecture per run.
  // The grouping call is non-deterministic: confidence reflects the expected value
  // of agreement, not a stable per-run signal. Downstream thresholds must treat
  // confidence as a distribution, not a point estimate.
  const requiredAgreement = samples === 1 ? 1 : Math.floor(samples / 2) + 1;
  if (dominant.length < proposals.length && proposals.length > 1) {
    const dedup = await deduplicateHypotheses(
      proposals.map((proposal) => ({
        claim_md: proposal.draft.claim_md,
        diagnostic_spec: proposal.draft.diagnostic_spec,
      })),
      runTaskFn,
    );
    // Accumulate cost + provenance from the dedup call.
    costsUsd.push(dedup.cost_usd);
    if (dedup.task_run_id) taskRunIds.push(dedup.task_run_id);

    if (!dedup.ok) {
      // Keep an already-established exact 2-of-N cluster. If exact matching
      // did not reach quorum, semantic grouping is load-bearing; its outage is
      // operational, not evidence that the model claims genuinely disagree.
      if (dominant.length < requiredAgreement) {
        throw new ConjectureInductionOperationalError(
          'ConjectureGroupingTask',
          'induceConjecture: ConjectureGroupingTask failed before semantic consensus',
        );
      }
    } else {
      // Re-map groups to draft arrays; pick the largest group as dominant.
      // Tie-break on the group's normalized lexical claim key, never sample order.
      const groupDrafts = dedup.groups
        .map((g) => {
          const groupedSamples = g.map((i) => proposals[i]);
          return {
            samples: groupedSamples,
            key: [...groupedSamples.map((sample) => hypothesisKey(sample.draft))].sort(
              compareLex,
            )[0],
          };
        })
        .sort((a, b) => b.samples.length - a.samples.length || compareLex(a.key, b.key));
      dominant = groupDrafts[0].samples;
    }
  }

  const agreement = dominant.length;
  if (agreement < requiredAgreement) {
    return {
      outcome: 'abstain',
      draft: chooseAbstainDraft({
        abstains,
        cells,
        reasonVotes: [
          ...baseReasonVotes(abstains, invalidSamples, failedSamples),
          ...Array.from<ConjectureAbstainReasonT>({ length: proposals.length }).fill(
            'no_semantic_consensus',
          ),
        ],
      }),
      confidence: 0,
      confidence_capped: false,
      samples,
      task_run_ids: taskRunIds,
      cost_usd: sumAllKnownCostUsd(costsUsd),
      votes,
      probe_quality_attempts: [],
    };
  }

  // confidence denominator is `samples` (requested), not `proposals.length`
  // (grounded) — a failed parse, ungrounded proposal, or abstention is a
  // non-agreement, not ignored.
  let confidence = agreement / samples;

  // Judge-only-evidence cap: every supporting cell is agent-judge, no owner cause.
  const allJudgeOnly = cells.every((c) => !c.has_owner_cause);
  const confidence_capped = allJudgeOnly && confidence > JUDGE_ONLY_CONFIDENCE_CAP;
  if (confidence_capped) confidence = JUDGE_ONLY_CONFIDENCE_CAP;

  const hypothesis = aggregateDominantHypothesis(dominant.map((sample) => sample.draft));
  let probeQuality: PrepareConjectureProbePairResult;
  try {
    probeQuality = await prepareConjectureProbePair({
      hypothesis,
      evidencePayload: taskPayload,
      evidenceImages,
      runTaskFn,
      ...(subjectProfile ? { subjectProfile } : {}),
    });
  } catch (error) {
    if (error instanceof ConjectureProbeQualityOperationalError) {
      throw new ConjectureInductionOperationalError(error.taskKind, error.message);
    }
    throw error;
  }
  costsUsd.push(probeQuality.cost_usd);
  taskRunIds.push(...probeQuality.task_run_ids);

  if (probeQuality.outcome === 'rejected') {
    const failureCodes = [
      ...new Set(probeQuality.attempts.flatMap((attempt) => attempt.failure_codes)),
    ];
    return {
      outcome: 'abstain',
      draft: {
        kind: 'abstain',
        reason_code: 'no_discriminating_probe',
        explanation_md:
          `Probe quality gate rejected both complete packages: ${failureCodes.join(', ')}`.slice(
            0,
            CONJECTURE_ABSTAIN_EXPLANATION_MAX_LENGTH,
          ),
        evidence_event_ids: hypothesis.evidence_event_ids,
      },
      confidence: 0,
      confidence_capped,
      samples,
      task_run_ids: taskRunIds,
      cost_usd: sumAllKnownCostUsd(costsUsd),
      votes,
      probe_quality_attempts: probeQuality.attempts,
    };
  }

  const probePackage = probeQuality.package;
  const draft: ConjectureProposalDraftT = {
    ...hypothesis,
    probe_md: probePackage.primary.prompt_md,
    probe_reference_md: probePackage.primary.reference_md,
    followup_probe_md: probePackage.followup.prompt_md,
    followup_probe_reference_md: probePackage.followup.reference_md,
    probe_spec: probePackage.primary,
    followup_probe_spec: probePackage.followup,
    probe_quality: probeQuality.audit,
    predicted_p: probePackage.predicted_p,
    discriminating: true,
    agreement_count: agreement,
  };

  return {
    outcome: 'proposal',
    draft,
    primary_task_run_id: probeQuality.primary_task_run_id,
    confidence,
    confidence_capped,
    samples,
    task_run_ids: taskRunIds,
    cost_usd: sumAllKnownCostUsd(costsUsd),
    votes,
    probe_quality_attempts: probeQuality.attempts,
  };
}
