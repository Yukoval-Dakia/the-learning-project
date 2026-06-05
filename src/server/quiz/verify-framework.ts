// YUK-216 S2 (题源扩展 Strategy D) — slice 1 verification-gate framework.
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §4
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §2.4
//
// This is the PLUGGABLE-CHECK config layer, NOT a new handler framework. The
// physical verify handlers (quiz_verify.ts, and slice 2/3's source_verify /
// material verify) keep their existing claim → idempotency → run → parse →
// single-txn-persist → writeEvent skeleton (双先例). This module only answers two
// questions for them:
//   1. "for a question of source-tier N, which checks apply?" (CHECK_SETS_BY_TIER)
//   2. "does this question survive solve-check?" (runSolveCheck)
//
// Reuse over invention (反过度工程, plan 实证旁证): solve-check does NOT add a new
// AI task. It reuses the shipped SolutionGenerateTask as an INDEPENDENT solver
// (different task/prompt dimension than the generator, YUK-193) and the shipped
// SemanticJudge for the open-question comparison. OWNER-FORK OF-4 (plan §12):
//   - exact questions (choice / true_false / fill_blank / exact-style)  → normalize
//     string compare of solver answer vs the question's own reference answer.
//   - open questions (essay / reading / translation / derivation)       → SemanticJudge
//     with a CONSERVATIVE threshold — 宁可漏过不误杀真题 (R2): only an outright,
//     confident 'incorrect' fails the check; 'unsupported' / 'partial' / low
//     confidence PASS.
//   - solver model: same as the generator for now (task/prompt already differ);
//     model 异源 is left as a per-tier `override` knob (zero structural change).
import type { SourceTier } from '@/core/schema/provenance';
import { type JudgeAnswerParams, runSemanticJudge } from '@/server/ai/judges/question-contract';

// ---------- check identifiers ----------
//
// The full pluggable-checker vocabulary (spec §4). Slice 1 lands the framework +
// solve-check; the other check IMPLEMENTATIONS are owned by the verify handlers in
// slice 2/3/4 (e.g. structure_completeness lives where the row is in hand). This
// enum is the shared contract so every handler names the same checks.
export type VerifyCheck =
  | 'structure_completeness' // the row has the fields its kind requires
  | 'solve_check' // an independent solver agrees the question is solvable + correct
  | 'source_consistency' // the question matches its declared source (tier 2)
  | 'material_grounding' // the question actually probes its grounded material (tier 3)
  | 'kind_conformance' // the question looks like a real exam item of its kind (skill, slice 4)
  | 'dedup' // not a near-duplicate of an existing pool question
  | 'grounding' // tier-4 legacy: fact grounding vs self-reported source_refs
  | 'copy_safety' // tier-4 legacy: originality vs source snippets
  | 'knowledge_hit'; // the question actually tests its knowledge_ids

// ---------- tier → check-set config ----------
//
// Which checks a question of each source tier must pass. This is the ONLY place
// the "which checks apply" decision lives — verify handlers read it instead of
// hard-coding per-tier check lists. Higher tiers carry tier-specific checks ON TOP
// of the shared structural + solve checks:
//   tier 1 authentic — ingested real exams; trusted, minimal re-verification.
//   tier 2 sourced   — web-fetched; needs source consistency + dedup + solve-check.
//   tier 3 material  — generated-from-material; needs material grounding + solve-check.
//   tier 4 generated — purely generated; the existing grounding/copy_safety/
//                      knowledge_hit checks (quiz_verify.ts §5) + solve-check.
//
// NOTE: this slice DECLARES the config + ships solve-check. It does NOT rewrite the
// already-green tier-4 quiz_verify flow (plan §2.4 — keep that handler physically
// unchanged); slice 3/4 add kind_conformance + solve-check into the live handlers.
export const CHECK_SETS_BY_TIER: Record<SourceTier, readonly VerifyCheck[]> = {
  1: ['structure_completeness', 'knowledge_hit'],
  2: ['structure_completeness', 'source_consistency', 'solve_check', 'dedup'],
  3: [
    'structure_completeness',
    'material_grounding',
    'solve_check',
    'kind_conformance',
    'knowledge_hit',
  ],
  4: [
    'structure_completeness',
    'grounding',
    'copy_safety',
    'knowledge_hit',
    'kind_conformance',
    'solve_check',
  ],
};

export function checksForTier(tier: SourceTier): readonly VerifyCheck[] {
  return CHECK_SETS_BY_TIER[tier];
}

// ---------- solve-check ----------

// Loose run seam (mirrors quiz_verify / variant_verify): the check only consumes
// { text } from the runner. DB tests inject a vi.fn() returning a JSON string.
export type SolveCheckRunTaskFn = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ text: string }>;

// The minimal subject-profile shape solve-check threads to the solver / judge. We
// keep this loose (not the full SubjectProfile import) so the check stays a leaf —
// callers already hold a resolved profile and pass it through.
export interface SolveCheckProfile {
  id: string;
  // passed straight into SemanticJudge's JudgeAnswerParams.subjectProfile.
  // biome-ignore lint/suspicious/noExplicitAny: caller passes a resolved SubjectProfile; this leaf only forwards it.
  full: any;
}

export interface SolveCheckQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  // the question's OWN declared answer (reference_md) — solve-check tests whether an
  // independent solve agrees with it.
  reference_md: string | null;
  choices_md: string[] | null;
  judge_kind_override: string | null;
  rubric_json: unknown;
  knowledge_ids?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export type SolveCheckVerdict = 'pass' | 'fail' | 'unsupported';

export interface SolveCheckResult {
  verdict: SolveCheckVerdict;
  // the answer an independent solver produced (for the verify event payload / audit).
  solver_final_answer?: string;
  // why we landed on the verdict (audit trail).
  reason: string;
  // 'normalize' (exact) vs 'semantic' (open) — which comparison axis ran.
  compared_by: 'normalize' | 'semantic' | 'none';
}

// Per-tier override knob (OF-4 (ii)): future model 异源 / threshold tuning. Zero
// structural change — pass `{ solverModelOverride }` and the runner picks it up via
// ctx. Unused this slice except as the documented seam.
export interface SolveCheckOptions {
  runTaskFn: SolveCheckRunTaskFn;
  profile: SolveCheckProfile;
  // db is only needed for the semantic (open-question) path's SemanticJudge.
  // biome-ignore lint/suspicious/noExplicitAny: leaf forwards the caller's Db handle to SemanticJudge.
  db?: any;
  /** OF-4(ii) seam: override the solver model per tier. Threaded into ctx. */
  solverModelOverride?: string;
}

// CONSERVATIVE threshold for the open-question semantic path (OF-4 / R2): only an
// 'incorrect' verdict AT OR ABOVE this confidence fails solve-check. High by design
// — the cost of a false 'fail' (killing a legitimate hard question) outweighs the
// cost of a false 'pass' (a bad question slipping through to the next gate / human
// review). Tunable per-tier via SolveCheckOptions in a later wave.
export const SOLVE_CHECK_SEMANTIC_THRESHOLD = 0.8;

// Question kinds whose answer is an EXACT token (compare by normalization). Open
// kinds (prose) route to the conservative semantic path. Mirrors the judge layer's
// exact-vs-semantic split without importing it (this is a content-quality check, not
// a student-grading judge).
const EXACT_KINDS = new Set(['choice', 'true_false', 'fill_blank']);

function isExactQuestion(q: SolveCheckQuestion): boolean {
  if (q.judge_kind_override === 'exact') return true;
  if (q.judge_kind_override === 'keyword' || q.judge_kind_override === 'semantic') return false;
  return EXACT_KINDS.has(q.kind);
}

export function normalizeAnswer(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/gu, '') // strip ASCII + full-width whitespace only
    .trim();
}

function choiceLabelIndex(value: string): number | null {
  const label = value.normalize('NFKC').trim().toUpperCase();
  if (!/^[A-F]$/u.test(label)) return null;
  return label.charCodeAt(0) - 'A'.charCodeAt(0);
}

function stripLeadingChoiceLabel(value: string): string | null {
  const normalized = value.normalize('NFKC').trim();
  const match = /^([A-F])[\s.、:：)\]）-]+(.+)$/iu.exec(normalized);
  const stripped = match?.[2]?.trim();
  return stripped && stripped.length > 0 ? stripped : null;
}

function addChoiceExpansion(out: string[], choice: string | undefined): void {
  if (!choice) return;
  out.push(choice);
  const stripped = stripLeadingChoiceLabel(choice);
  if (stripped) out.push(stripped);
}

function answerCandidates(text: string, choices: readonly string[]): string[] {
  const out = [text];
  const stripped = stripLeadingChoiceLabel(text);
  if (stripped) out.push(stripped);

  const labelIndex = choiceLabelIndex(text);
  if (labelIndex !== null) {
    addChoiceExpansion(out, choices[labelIndex]);
  }

  return out;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('solve-check: SolutionGenerateTask output had no JSON object');
  }
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Independent solve-check: have a separate solver (SolutionGenerateTask) solve the
 * question from scratch, then test whether its answer AGREES with the question's own
 * declared answer. A disagreement is a quality signal that the persisted answer is
 * wrong / ambiguous / unsolvable.
 *
 * CONSERVATIVE by design (R2): the goal is to catch broken questions WITHOUT killing
 * legitimate hard ones the solver merely failed. So:
 *   - solver throws / unparseable / empty answer  → 'unsupported' (NOT fail — no signal)
 *   - exact kinds: normalize mismatch             → 'fail'; match → 'pass'
 *   - open kinds: SemanticJudge confidently says the answers disagree → 'fail';
 *                 anything softer (unsupported / partial / low confidence) → 'pass'
 */
export async function runSolveCheck(
  question: SolveCheckQuestion,
  opts: SolveCheckOptions,
): Promise<SolveCheckResult> {
  const referenceAnswer = (question.reference_md ?? '').trim();

  // Solve the question independently. Input shape mirrors solution-generate.ts:103.
  let solverFinalAnswer: string;
  let solverEquivalents: string[];
  try {
    const meta = (question.metadata ?? {}) as Record<string, unknown>;
    const input = {
      prompt_md: question.prompt_md,
      kind: question.kind,
      subject_id: opts.profile.id,
      // Choice options are part of the question, but live in a separate column.
      // Pass them explicitly so stems like "which statement is correct?" are
      // solvable by SolutionGenerateTask.
      choices_md: question.choices_md ?? [],
      // existing answer is only a HINT to the solver (it may copy a wrong answer);
      // for solve-check we WANT an independent solve, so we do NOT feed the
      // question's own reference_md as a hint — only OCR-side hints if any.
      existing_answers_hint: meta.tencent_right_answer ?? null,
      existing_analysis_hint: meta.tencent_answer_analysis ?? null,
      figures_hint: null,
    };
    const ctx: Record<string, unknown> = { db: opts.db, subjectProfile: opts.profile.full };
    if (opts.solverModelOverride) ctx.model = opts.solverModelOverride;
    const { text } = await opts.runTaskFn('SolutionGenerateTask', input, ctx);
    // Parse the structured output; only final_answer + answer_equivalents matter here.
    const parsed = extractJsonObject(text) as {
      reference_solution?: { final_answer?: unknown; answer_equivalents?: unknown };
    };
    const fa = parsed.reference_solution?.final_answer;
    solverFinalAnswer = typeof fa === 'string' ? fa.trim() : '';
    const eq = parsed.reference_solution?.answer_equivalents;
    solverEquivalents = Array.isArray(eq)
      ? eq.filter((e): e is string => typeof e === 'string')
      : [];
  } catch (err) {
    // No usable solver answer → no signal. Conservative: do not fail the question.
    return {
      verdict: 'unsupported',
      reason: `solver did not produce a usable answer: ${err instanceof Error ? err.message : String(err)}`,
      compared_by: 'none',
    };
  }

  if (solverFinalAnswer.length === 0) {
    return {
      verdict: 'unsupported',
      reason: 'solver returned an empty final_answer',
      compared_by: 'none',
    };
  }

  if (referenceAnswer.length === 0) {
    // No declared answer to compare against → nothing solve-check can assert.
    return {
      verdict: 'unsupported',
      solver_final_answer: solverFinalAnswer,
      reason: 'question has no reference answer to compare against',
      compared_by: 'none',
    };
  }

  // ----- exact path: normalize compare -----
  if (isExactQuestion(question)) {
    const choices = question.choices_md ?? [];
    const refCandidates = answerCandidates(referenceAnswer, choices)
      .map(normalizeAnswer)
      .filter((c) => c.length > 0);
    const solverCandidates = [solverFinalAnswer, ...solverEquivalents]
      .flatMap((candidate) => answerCandidates(candidate, choices))
      .map(normalizeAnswer)
      .filter((c) => c.length > 0);
    const agree = solverCandidates.some((candidate) => refCandidates.includes(candidate));
    return {
      verdict: agree ? 'pass' : 'fail',
      solver_final_answer: solverFinalAnswer,
      reason: agree
        ? 'solver answer matches the question reference (normalized)'
        : `solver answer "${solverFinalAnswer}" disagrees with reference "${referenceAnswer}" (normalized)`,
      compared_by: 'normalize',
    };
  }

  // ----- open path: SemanticJudge, conservative -----
  if (!opts.db) {
    // Without a Db handle the semantic path cannot run; be conservative.
    return {
      verdict: 'unsupported',
      solver_final_answer: solverFinalAnswer,
      reason: 'open-question solve-check needs a Db handle for SemanticJudge; skipped',
      compared_by: 'none',
    };
  }
  // Treat the question's reference answer as the rubric/reference and the solver's
  // independent answer as the "submission". If the semantic judge CONFIDENTLY says
  // the solver answer is incorrect vs the reference, the persisted answer is suspect
  // → fail. Anything softer (partial / correct / unsupported / low confidence) PASSES
  // — 宁可漏过不误杀真题 (OF-4 / R2).
  const semParams: JudgeAnswerParams = {
    db: opts.db,
    question: {
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: referenceAnswer,
      rubric_json: question.rubric_json ?? null,
      choices_md: question.choices_md ?? null,
      // force the semantic route — solve-check is always a semantic comparison for
      // open kinds, regardless of the question's own judge route.
      judge_kind_override: 'semantic',
      knowledge_ids: question.knowledge_ids ?? null,
      metadata: question.metadata ?? null,
    },
    answer_md: solverFinalAnswer,
    subjectProfile: opts.profile.full,
    runTaskFn: opts.runTaskFn,
  };
  const judged = await runSemanticJudge(semParams);
  const confidentlyDisagrees =
    judged.coarse_outcome === 'incorrect' && judged.confidence >= SOLVE_CHECK_SEMANTIC_THRESHOLD;
  return {
    verdict: confidentlyDisagrees ? 'fail' : 'pass',
    solver_final_answer: solverFinalAnswer,
    reason: confidentlyDisagrees
      ? `SemanticJudge confidently scored the independent solver answer as incorrect (confidence ${judged.confidence.toFixed(2)} >= ${SOLVE_CHECK_SEMANTIC_THRESHOLD})`
      : `SemanticJudge did not confidently disagree (outcome=${judged.coarse_outcome}, confidence=${judged.confidence.toFixed(2)}) — conservative pass`,
    compared_by: 'semantic',
  };
}
