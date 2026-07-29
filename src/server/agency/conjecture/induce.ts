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
//      Opus (anthropic-sub OAuth) lane; cluster samples by claim; the dominant claim
//      wins and its agreement fraction (agreement / samples) IS the confidence.
//   2. JUDGE-ONLY-EVIDENCE CAP — if EVERY supporting evidence cell is agent-judge
//      with no owner cause, cap confidence at JUDGE_ONLY_CONFIDENCE_CAP (the owner
//      never corroborated it, so the team must not be loud about it).
//
// confidence is INTERNAL calibration only — returned as a number here for
// sorting/calibration but NEVER rendered to the owner as a number (Phase 0 rule).
//
// A13 (YUK-440): each sampled ConjectureDraft carries predicted_p (the claim's
// falsifiable bet — P(owner answers the probe correctly | claim holds)) and
// `discriminating` (does the probe isolate THIS misconception). The dominant cluster's
// fields are aggregated deterministically before flowing to the proposal; the loop later
// scores predicted_p against the cell's baseline_p (scoring + flip DEFERRED per ADR-0046).

import type {
  EnrichedEvidenceCell,
  LoadedConjectureEvidenceImage,
} from '@/capabilities/agency/server/conjecture/evidence';
import {
  CONJECTURE_ABSTAIN_EXPLANATION_MAX_LENGTH,
  type ConjectureAbstainDraftT,
  type ConjectureAbstainReasonT,
  ConjectureDraft,
  type ConjectureDraftT,
  type ConjectureModelAbstainDraftT,
  type ConjectureProposalDraftT,
} from '@/core/schema/business';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';

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

export type ConjectureInductionTaskKind = 'MindModelInductionTask' | 'ClaimGroupingTask';

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
  cost_usd: number;
  /** Every requested sample remains visible in the decision denominator. */
  votes: {
    proposal: number;
    abstain: number;
    invalid: number;
    failed: number;
  };
}

export type InduceConjectureResult =
  | (InduceConjectureResultBase & {
      outcome: 'proposal';
      draft: ConjectureProposalDraftT;
      /** One run that produced the winning claim/probe tuple (scalar correlation anchor). */
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

const ConjectureStructuredOutput = z.object({
  draft: ConjectureDraft,
});

interface GroundedProposalSample {
  draft: ConjectureProposalDraftT;
  task_run_id: string | undefined;
}

/** Parse balanced JSON objects, recovering after malformed prose candidates. */
function jsonObjectCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('{', cursor);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }

    if (end < 0) {
      // A stray/unbalanced brace in prose must not hide a later valid object.
      cursor = start + 1;
      continue;
    }
    try {
      candidates.push(JSON.parse(text.slice(start, end + 1)));
      cursor = end + 1;
    } catch {
      // Retry from the next opening brace; the failed span may wrap valid JSON.
      cursor = start + 1;
    }
  }
  return candidates;
}

function parseSampleDraft(result: TaskTextResult): ConjectureDraftT | null {
  // Three-state dispatch (mirrors variant_verify): prefer the SDK's structured_output
  // (Opus honours outputFormat), else char-scan the text for the JSON object.
  if (result.structured_output !== undefined && result.structured_output !== null) {
    const wrapped = ConjectureStructuredOutput.safeParse(result.structured_output);
    if (wrapped.success) return wrapped.data.draft;
    const parsed = ConjectureDraft.safeParse(result.structured_output);
    if (parsed.success) return parsed.data;
  }
  for (const candidate of jsonObjectCandidates(result.text)) {
    const wrapped = ConjectureStructuredOutput.safeParse(candidate);
    if (wrapped.success) return wrapped.data.draft;
    const parsed = ConjectureDraft.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
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

/** Aggregate a winning cluster without depending on sample completion/insertion order. */
function aggregateDominantDraft(
  drafts: ConjectureProposalDraftT[],
  agreement: number,
): ConjectureProposalDraftT {
  // claim/probe/reference/cause form one semantic sample. Select one complete draft
  // by exact tuple vote, then lexical tie-break. Aggregating fields independently
  // can fabricate a mismatched probe; lexical-only selection can elevate a 1-vote outlier.
  const coupled = new Map<string, { count: number; draft: ConjectureProposalDraftT }>();
  for (const draft of drafts) {
    const key = JSON.stringify([
      draft.claim_md,
      draft.probe_md,
      draft.probe_reference_md,
      draft.followup_probe_md,
      draft.followup_probe_reference_md,
      draft.cause_category,
    ]);
    const current = coupled.get(key);
    coupled.set(key, { count: (current?.count ?? 0) + 1, draft: current?.draft ?? draft });
  }
  const representative = [...coupled.entries()].sort(
    ([aKey, a], [bKey, b]) => b.count - a.count || compareLex(aKey, bKey),
  )[0][1].draft;
  const discriminatingVotes = drafts.filter((draft) => draft.discriminating).length;
  return {
    ...representative,
    recurrence_count: Math.round(median(drafts.map((draft) => draft.recurrence_count))),
    predicted_p: median(drafts.map((draft) => draft.predicted_p)),
    // A tie is non-discriminating: the conservative, reproducible outcome.
    discriminating: discriminatingVotes > drafts.length / 2,
    agreement_count: agreement,
  };
}

function groundedEvidenceEventIds(cell: EnrichedEvidenceCell): string[] {
  return [...new Set(cell.samples.map((sample) => sample.attempt_event_id))];
}

function normalizeGroundedProposal(
  draft: ConjectureProposalDraftT,
  cells: EnrichedEvidenceCell[],
): ConjectureProposalDraftT | null {
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

// YUK-538 — GroupSchema: structural output contract for ClaimGroupingTask.
// Local constant — not exported, not persisted.
const GroupSchema = z.object({
  groups: z.array(z.array(z.number().int().min(0)).min(1)).min(1),
});

interface DeduplicateClaimsResult {
  ok: boolean;
  groups: number[][];
  cost_usd: number;
  task_run_id: string | undefined;
}

/**
 * Groups claim indices by semantic equivalence via a single ClaimGroupingTask call.
 * Always called when dominant.length < drafts.length (i.e., not unanimous via claimKey).
 *
 * Returns index groups, accumulated cost, task_run_id, and explicit health.
 * On failure the caller preserves any exact claimKey quorum already established;
 * when no exact quorum exists, grouping is load-bearing and the cell fails operationally.
 */
async function deduplicateClaims(
  claims: string[],
  runTaskFn: TaskTextRunFn,
): Promise<DeduplicateClaimsResult> {
  const failure = (
    result: Pick<TaskTextResult, 'cost_usd' | 'task_run_id'> = {},
  ): DeduplicateClaimsResult => ({
    ok: false,
    groups: claims.map((_, i) => [i]),
    cost_usd: result.cost_usd ?? 0,
    task_run_id: result.task_run_id,
  });

  if (claims.length <= 1) {
    return {
      ok: true,
      groups: [claims.map((_, i) => i)],
      cost_usd: 0,
      task_run_id: undefined,
    };
  }

  let result: TaskTextResult;
  try {
    result = await runTaskFn(
      'ClaimGroupingTask',
      { claims },
      { outputFormat: zodToJsonSchemaOutputFormat(GroupSchema) },
    );
  } catch (err) {
    // Warn so nightly pipeline failures are observable (silent degradation masks persistent issues).
    console.warn('[induceConjecture] ClaimGroupingTask failed, preserving exact clusters:', err);
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
  const isPartition = flatSorted.length === claims.length && flatSorted.every((v, i) => v === i);
  if (!isPartition) return failure(result);

  return {
    ok: true,
    groups: parsed.data.groups,
    cost_usd: result.cost_usd ?? 0,
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
  const proposals: GroundedProposalSample[] = [];
  const abstains: ConjectureModelAbstainDraftT[] = [];
  const taskRunIds: string[] = [];
  const sampleErrors: string[] = [];
  let invalidSamples = 0;
  let failedSamples = 0;
  let costUsd = 0;
  const sampleResults = await Promise.allSettled(
    Array.from({ length: samples }, () =>
      runTaskFn('MindModelInductionTask', taskInput, {
        override: { provider: 'anthropic-sub' as const },
        // Agent SDK structured output is implemented as a custom tool whose
        // input_schema must be a top-level object and rejects a top-level
        // discriminated-union anyOf. Nest the domain union under `draft`.
        outputFormat: zodToJsonSchemaOutputFormat(ConjectureStructuredOutput),
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
      costUsd += result.cost_usd ?? 0;
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
      cost_usd: costUsd,
      votes,
    };
  }

  // Fast path: claimKey clustering (byte-identical after normalisation).
  const clusters = new Map<string, GroundedProposalSample[]>();
  for (const proposal of proposals) {
    const key = claimKey(proposal.draft.claim_md);
    const bucket = clusters.get(key) ?? [];
    bucket.push(proposal);
    clusters.set(key, bucket);
  }
  let dominant = [...clusters.entries()].sort(
    ([aKey, aDrafts], [bKey, bDrafts]) => bDrafts.length - aDrafts.length || compareLex(aKey, bKey),
  )[0][1];

  // Semantic dedup: fires whenever samples are not byte-identical unanimous.
  // This is the primary post-fast-path step, not a rare fallback — at temperature > 0
  // with N=3 on Opus, all three samples will almost always produce distinct surface
  // strings, so this call fires on essentially every nightly invocation.
  // Cost: +1 ClaimGroupingTask (mimo default, not Opus) per conjecture per run.
  // The grouping call is non-deterministic: confidence reflects the expected value
  // of agreement, not a stable per-run signal. Downstream thresholds must treat
  // confidence as a distribution, not a point estimate.
  const requiredAgreement = samples === 1 ? 1 : Math.floor(samples / 2) + 1;
  if (dominant.length < proposals.length && proposals.length > 1) {
    const dedup = await deduplicateClaims(
      proposals.map((proposal) => proposal.draft.claim_md),
      runTaskFn,
    );
    // Accumulate cost + provenance from the dedup call.
    costUsd += dedup.cost_usd;
    if (dedup.task_run_id) taskRunIds.push(dedup.task_run_id);

    if (!dedup.ok) {
      // Keep an already-established exact 2-of-N cluster. If exact matching
      // did not reach quorum, semantic grouping is load-bearing; its outage is
      // operational, not evidence that the model claims genuinely disagree.
      if (dominant.length < requiredAgreement) {
        throw new ConjectureInductionOperationalError(
          'ClaimGroupingTask',
          'induceConjecture: ClaimGroupingTask failed before semantic consensus',
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
            key: [...groupedSamples.map((sample) => claimKey(sample.draft.claim_md))].sort(
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
      cost_usd: costUsd,
      votes,
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

  const draft = aggregateDominantDraft(
    dominant.map((sample) => sample.draft),
    agreement,
  );
  const primaryTaskRunId =
    dominant.find(
      (sample) =>
        sample.task_run_id !== undefined &&
        sample.draft.claim_md === draft.claim_md &&
        sample.draft.probe_md === draft.probe_md &&
        sample.draft.probe_reference_md === draft.probe_reference_md &&
        sample.draft.followup_probe_md === draft.followup_probe_md &&
        sample.draft.followup_probe_reference_md === draft.followup_probe_reference_md &&
        sample.draft.cause_category === draft.cause_category,
    )?.task_run_id ?? null;

  return {
    outcome: 'proposal',
    draft,
    primary_task_run_id: primaryTaskRunId,
    confidence,
    confidence_capped,
    samples,
    task_run_ids: taskRunIds,
    cost_usd: costUsd,
    votes,
  };
}
