// YUK-406 (Phase 0 关系脑) / YUK-440 (A13) — conjecture induction orchestrator
// with D2 mitigation.
//
// PURE (no DB / no R2): the 取证 sibling (@/server/conjectures/evidence) assembles
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

import { ConjectureDraft, type ConjectureDraftT } from '@/core/schema/business';
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import type { EvidenceCell } from '@/server/conjectures/evidence';
import { z } from 'zod';

export interface InduceConjectureInput {
  /** Deterministic 取证 cells for ONE candidate (the job passes one salient cell). */
  cells: EvidenceCell[];
  /** N self-consistency samples (>= 1). The nightly job passes 3. */
  samples: number;
  /** injected runner — the job wraps the real runTask (with db); faked in tests. */
  runTaskFn: TaskTextRunFn;
  /** prior conjecture claim being updated, if any (owner-correction anchor feed). */
  priorClaimMd?: string;
}

export interface InduceConjectureResult {
  draft: ConjectureDraftT;
  /** internal calibration in [0,1]; NEVER rendered as a number to the owner. */
  confidence: number;
  confidence_capped: boolean;
  samples: number;
  /** task_run_ids of every sample (provenance / cost trail). */
  task_run_ids: string[];
  cost_usd: number;
}

/** Confidence ceiling when ALL evidence is agent-judge (no owner corroboration). */
export const JUDGE_ONLY_CONFIDENCE_CAP = 0.5;

/** Parse every balanced JSON object in text, ignoring braces inside JSON strings. */
function jsonObjectCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (start >= 0 && inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (start >= 0 && char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    try {
      candidates.push(JSON.parse(text.slice(start, i + 1)));
    } catch {
      // Reasoning may contain mathematical braces before the actual JSON object.
    }
    start = -1;
  }
  return candidates;
}

function parseSampleDraft(result: TaskTextResult): ConjectureDraftT | null {
  // Three-state dispatch (mirrors variant_verify): prefer the SDK's structured_output
  // (Opus honours outputFormat), else char-scan the text for the JSON object.
  if (result.structured_output !== undefined && result.structured_output !== null) {
    const parsed = ConjectureDraft.safeParse(result.structured_output);
    if (parsed.success) return parsed.data;
  }
  for (const candidate of jsonObjectCandidates(result.text)) {
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

function deterministicMode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(
    ([a, aCount], [b, bCount]) => bCount - aCount || compareLex(a, b),
  )[0][0];
}

/** Keep the generated probe and its gold reference as one indivisible sample value. */
function deterministicProbePair(
  drafts: ConjectureDraftT[],
): Pick<ConjectureDraftT, 'probe_md' | 'probe_reference_md'> {
  const pairs = new Map<string, { count: number; draft: ConjectureDraftT }>();
  for (const draft of drafts) {
    const key = JSON.stringify([draft.probe_md, draft.probe_reference_md]);
    const current = pairs.get(key);
    pairs.set(key, { count: (current?.count ?? 0) + 1, draft: current?.draft ?? draft });
  }
  const winner = [...pairs.entries()].sort(
    ([aKey, a], [bKey, b]) => b.count - a.count || compareLex(aKey, bKey),
  )[0][1].draft;
  return {
    probe_md: winner.probe_md,
    probe_reference_md: winner.probe_reference_md,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Aggregate a winning cluster without depending on sample completion/insertion order. */
function aggregateDominantDraft(drafts: ConjectureDraftT[], agreement: number): ConjectureDraftT {
  const representative = [...drafts].sort((a, b) => {
    const claimOrder = compareLex(claimKey(a.claim_md), claimKey(b.claim_md));
    if (claimOrder !== 0) return claimOrder;
    const probeOrder = compareLex(a.probe_md, b.probe_md);
    if (probeOrder !== 0) return probeOrder;
    return a.predicted_p - b.predicted_p;
  })[0];
  const discriminatingVotes = drafts.filter((draft) => draft.discriminating).length;
  const probePair = deterministicProbePair(drafts);
  return {
    ...representative,
    claim_md: deterministicMode(drafts.map((draft) => draft.claim_md)),
    ...probePair,
    cause_category: deterministicMode(
      drafts.map((draft) => draft.cause_category),
    ) as ConjectureDraftT['cause_category'],
    recurrence_count: Math.round(median(drafts.map((draft) => draft.recurrence_count))),
    predicted_p: median(drafts.map((draft) => draft.predicted_p)),
    // A tie is non-discriminating: the conservative, reproducible outcome.
    discriminating: discriminatingVotes > drafts.length / 2,
    agreement_count: agreement,
  };
}

// YUK-538 — GroupSchema: structural output contract for ClaimGroupingTask.
// Local constant — not exported, not persisted.
const GroupSchema = z.object({
  groups: z.array(z.array(z.number().int().min(0)).min(1)).min(1),
});

interface DeduplicateClaimsResult {
  groups: number[][];
  cost_usd: number;
  task_run_id: string | undefined;
}

/**
 * Groups claim indices by semantic equivalence via a single ClaimGroupingTask call.
 * Always called when dominant.length < drafts.length (i.e., not unanimous via claimKey).
 *
 * Returns index groups, accumulated cost, and the task_run_id for provenance.
 * Falls back to all-singletons on any failure (throw, parse error, or coverage mismatch)
 * — graceful degradation restores original claimKey behaviour rather than crashing
 * the nightly cell.
 */
async function deduplicateClaims(
  claims: string[],
  runTaskFn: TaskTextRunFn,
): Promise<DeduplicateClaimsResult> {
  const singleton = (): DeduplicateClaimsResult => ({
    groups: claims.map((_, i) => [i]),
    cost_usd: 0,
    task_run_id: undefined,
  });

  if (claims.length <= 1) {
    return { groups: [claims.map((_, i) => i)], cost_usd: 0, task_run_id: undefined };
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
    console.warn('[induceConjecture] ClaimGroupingTask failed, falling back to singletons:', err);
    return singleton();
  }

  // Parse structured output; then scan balanced JSON objects in the text fallback.
  const parsed = [result.structured_output, ...jsonObjectCandidates(result.text)]
    .filter((candidate) => candidate !== undefined && candidate !== null)
    .map((candidate) => GroupSchema.safeParse(candidate))
    .find((candidate) => candidate.success) ?? { success: false as const };
  if (!parsed.success) return singleton();

  // Coverage guard: verify groups form a complete partition of 0..N-1
  // (each index appears exactly once — catches duplicates, gaps, and out-of-range indices).
  // A flat-length-only check passes e.g. [[0,0],[1]] (length=3=N but index 0 duplicated).
  const flatSorted = [...parsed.data.groups.flat()].sort((a, b) => a - b);
  const isPartition = flatSorted.length === claims.length && flatSorted.every((v, i) => v === i);
  if (!isPartition) return singleton();

  return {
    groups: parsed.data.groups,
    cost_usd: result.cost_usd ?? 0,
    task_run_id: result.task_run_id,
  };
}

export async function induceConjecture(
  input: InduceConjectureInput,
): Promise<InduceConjectureResult> {
  const { cells, samples, runTaskFn, priorClaimMd } = input;
  if (samples < 1) throw new Error('induceConjecture: samples must be >= 1');
  if (cells.length === 0) throw new Error('induceConjecture: cells must be non-empty');

  const taskInput = {
    evidence_cells: cells.map((c) => ({
      knowledge_id: c.knowledge_id,
      cause_category: c.cause_category,
      recurrence_count: c.recurrence_count,
      theta_hat: c.theta_hat,
      theta_precision: c.theta_precision,
      baseline_p: c.baseline_p,
      evidence_event_ids: c.evidence_event_ids,
    })),
    ...(priorClaimMd ? { prior_claim_md: priorClaimMd } : {}),
  };

  // Run N samples on the Opus anthropic-sub lane (override; providers.ts exempts it
  // from the AI_PROVIDER_MODEL guard via ANTHROPIC_SUB_DEFAULT_MODEL).
  const drafts: ConjectureDraftT[] = [];
  const taskRunIds: string[] = [];
  const sampleErrors: string[] = [];
  let costUsd = 0;
  const sampleResults = await Promise.allSettled(
    Array.from({ length: samples }, () =>
      runTaskFn('MindModelInductionTask', taskInput, {
        override: { provider: 'anthropic-sub' as const },
        outputFormat: zodToJsonSchemaOutputFormat(ConjectureDraft),
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
      if (draft) drafts.push(draft);
    } else {
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
  if (drafts.length === 0) {
    const details =
      sampleErrors.length > 0 ? `; failures: ${sampleErrors.slice(0, 3).join(' | ')}` : '';
    throw new Error(`induceConjecture: no sample produced a valid ConjectureDraft${details}`);
  }

  // Fast path: claimKey clustering (byte-identical after normalisation).
  const clusters = new Map<string, ConjectureDraftT[]>();
  for (const d of drafts) {
    const key = claimKey(d.claim_md);
    const bucket = clusters.get(key) ?? [];
    bucket.push(d);
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
  if (dominant.length < drafts.length && drafts.length > 1) {
    const dedup = await deduplicateClaims(
      drafts.map((d) => d.claim_md),
      runTaskFn,
    );
    // Accumulate cost + provenance from the dedup call.
    costUsd += dedup.cost_usd;
    if (dedup.task_run_id) taskRunIds.push(dedup.task_run_id);

    // Re-map groups to draft arrays; pick the largest group as dominant.
    // Tie-break on the group's normalized lexical claim key, never sample order.
    const groupDrafts = dedup.groups
      .map((g) => {
        const groupedDrafts = g.map((i) => drafts[i]);
        return {
          drafts: groupedDrafts,
          key: [...groupedDrafts.map((draft) => claimKey(draft.claim_md))].sort(compareLex)[0],
        };
      })
      .sort((a, b) => b.drafts.length - a.drafts.length || compareLex(a.key, b.key));
    dominant = groupDrafts[0].drafts;
  }

  const agreement = dominant.length;
  // confidence denominator is `samples` (requested), not `drafts.length` (parsed) —
  // a failed parse is a non-agreement, not ignored. Unchanged from original.
  let confidence = agreement / samples;

  // Judge-only-evidence cap: every supporting cell is agent-judge, no owner cause.
  const allJudgeOnly = cells.every((c) => !c.has_owner_cause);
  const confidence_capped = allJudgeOnly && confidence > JUDGE_ONLY_CONFIDENCE_CAP;
  if (confidence_capped) confidence = JUDGE_ONLY_CONFIDENCE_CAP;

  const draft = aggregateDominantDraft(dominant, agreement);

  return {
    draft,
    confidence,
    confidence_capped,
    samples,
    task_run_ids: taskRunIds,
    cost_usd: costUsd,
  };
}
