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
// `discriminating` (does the probe isolate THIS misconception). The dominant draft's
// values flow through to the proposal; the loop later scores predicted_p against the
// cell's baseline_p (scoring + flip DEFERRED per ADR-0046).

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

function parseSampleDraft(result: TaskTextResult): ConjectureDraftT | null {
  // Three-state dispatch (mirrors variant_verify): prefer the SDK's structured_output
  // (Opus honours outputFormat), else char-scan the text for the JSON object.
  if (result.structured_output !== undefined && result.structured_output !== null) {
    const parsed = ConjectureDraft.safeParse(result.structured_output);
    return parsed.success ? parsed.data : null;
  }
  const start = result.text.indexOf('{');
  const end = result.text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = ConjectureDraft.safeParse(JSON.parse(result.text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Normalize a claim for clustering (case + whitespace insensitive). */
function claimKey(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
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

  // Parse structured output; fall back to text char-scan on missing structured_output.
  const raw: unknown =
    result.structured_output ??
    (() => {
      const s = result.text.indexOf('{');
      const e = result.text.lastIndexOf('}');
      if (s === -1 || e === -1 || e < s) return null;
      try {
        return JSON.parse(result.text.slice(s, e + 1));
      } catch {
        return null;
      }
    })();

  const parsed = raw ? GroupSchema.safeParse(raw) : { success: false as const };
  if (!parsed.success) return singleton();

  // Coverage guard: verify groups form a complete partition of 0..N-1
  // (each index appears exactly once — catches duplicates, gaps, and out-of-range indices).
  // A flat-length-only check passes e.g. [[0,0],[1]] (length=3=N but index 0 duplicated).
  const flatSorted = [...parsed.data.groups.flat()].sort((a, b) => a - b);
  const isPartition =
    flatSorted.length === claims.length && flatSorted.every((v, i) => v === i);
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
  let costUsd = 0;
  for (let i = 0; i < samples; i++) {
    const result = await runTaskFn('MindModelInductionTask', taskInput, {
      override: { provider: 'anthropic-sub' as const },
      outputFormat: zodToJsonSchemaOutputFormat(ConjectureDraft),
    });
    if (result.task_run_id) taskRunIds.push(result.task_run_id);
    costUsd += result.cost_usd ?? 0;
    const draft = parseSampleDraft(result);
    if (draft) drafts.push(draft);
  }
  if (drafts.length === 0) {
    throw new Error('induceConjecture: no sample produced a valid ConjectureDraft');
  }

  // Fast path: claimKey clustering (byte-identical after normalisation).
  const clusters = new Map<string, ConjectureDraftT[]>();
  for (const d of drafts) {
    const key = claimKey(d.claim_md);
    const bucket = clusters.get(key) ?? [];
    bucket.push(d);
    clusters.set(key, bucket);
  }
  let dominant: ConjectureDraftT[] = [];
  for (const bucket of clusters.values()) {
    if (bucket.length > dominant.length) dominant = bucket;
  }

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
    // Tie-break: smallest minimum index (preserves first-run-first selection
    // convention, making claim_md selection deterministic on size ties).
    const groupDrafts = dedup.groups
      .map((g) => ({ drafts: g.map((i) => drafts[i]), minIdx: Math.min(...g) }))
      .sort((a, b) => b.drafts.length - a.drafts.length || a.minIdx - b.minIdx);
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

  // The dominant cluster's representative carries claim/probe/predicted_p/discriminating;
  // stamp the agreement tally (the model filled 1).
  const draft: ConjectureDraftT = { ...dominant[0], agreement_count: agreement };

  return {
    draft,
    confidence,
    confidence_capped,
    samples,
    task_run_ids: taskRunIds,
    cost_usd: costUsd,
  };
}
