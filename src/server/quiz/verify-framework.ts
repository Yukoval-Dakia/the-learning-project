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
// Reuse over invention (plan 实证旁证): solve-check does NOT add a new
// AI task. It reuses the shipped SolutionGenerateTask as an INDEPENDENT solver
// (different task/prompt dimension than the generator, YUK-193) and the shipped
// SemanticJudge for the open-question comparison. OWNER-FORK OF-4 (plan §12):
//   - exact questions (choice / true_false / fill_blank / exact-style)  → normalize
//     first; a mismatch falls through to SemanticJudge instead of becoming a string-only veto.
//   - open questions (essay / reading / translation / derivation)       → SemanticJudge
//     with a CONSERVATIVE threshold — 宁可漏过不误杀真题 (R2): only an outright,
//     confident 'incorrect' fails the check; 'unsupported' / 'partial' / low
//     confidence PASS.
//   - solver model: same as the generator for now (task/prompt already differ);
//     model 异源 is left as a per-tier `override` knob (zero structural change).
//
// TIER3/4 WIRING (YUK-538 / YUK-554, docs/design/2026-07-03-verify-check-spec.md): runSolveCheck
// + CHECK_SETS_BY_TIER are DECLARED here; the tier3/4 CONSUMER is quiz_verify.ts (tier2 is
// source_verify.ts). These declarations predate that wiring — do NOT read "tier3/4 never consumes
// solve_check" as a bug in THIS file; the consumer lives in the handler.
import type { SourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
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
  | 'teaching_quality' // YUK-578: the question is clear, single-solution + (choice) has diagnostic distractors
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
// NOTE: this slice DECLARED the config + shipped solve-check. kind_conformance (YUK-225),
// solve_check (YUK-538 / YUK-554) and teaching_quality (YUK-578 入池前审题闸) are all consumed by
// the live tier3/4 handler (quiz_verify.ts); tier2's set is consumed by source_verify.ts. Every
// check named in a tier's set has a live consumer — CHECK_SETS_BY_TIER is the single source of
// truth the handlers read.
export const CHECK_SETS_BY_TIER: Record<SourceTier, readonly VerifyCheck[]> = {
  1: ['structure_completeness', 'knowledge_hit'],
  2: ['structure_completeness', 'source_consistency', 'solve_check', 'dedup'],
  3: [
    'structure_completeness',
    'material_grounding',
    'solve_check',
    'kind_conformance',
    'teaching_quality',
    'knowledge_hit',
  ],
  4: [
    'structure_completeness',
    'grounding',
    'copy_safety',
    'knowledge_hit',
    'kind_conformance',
    'solve_check',
    'teaching_quality',
  ],
};

export function checksForTier(tier: SourceTier): readonly VerifyCheck[] {
  return CHECK_SETS_BY_TIER[tier];
}

// ---------- solve-check ----------

// Loose run seam (mirrors quiz_verify / variant_verify): the check consumes { text } from
// the runner, plus — EFF-1 (YUK-554 review) — OPTIONAL task_run_id / cost_usd when the
// runner reports them (production TaskTextResult does; { text }-only test mocks still
// satisfy the type), so solve-check cost is answerable from the verify event.
export type SolveCheckRunTaskFn = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ text: string; task_run_id?: string; cost_usd?: number }>;

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
  /** Prompt-figure source_asset ids. When present, solve-check attaches their bytes. */
  image_refs?: string[] | null;
  /** Structured figure placement, forwarded as a textual hint alongside the image bytes. */
  figures?: unknown[] | null;
}

export type SolveCheckVerdict = 'pass' | 'fail' | 'unsupported';

export interface SolveCheckResult {
  verdict: SolveCheckVerdict;
  // the answer an independent solver produced (for the verify event payload / audit).
  solver_final_answer?: string;
  // why we landed on the verdict (audit trail).
  reason: string;
  // Which comparison established the terminal verdict. Exact mismatches fall through to semantic.
  compared_by: 'normalize' | 'semantic' | 'none';
  /** Exact candidates disagreed before the SemanticJudge fallback (YUK-612 audit signal). */
  normalized_exact_mismatch?: boolean;
  // EFF-1 (YUK-554 review) — provenance/cost of the 1 (exact) or 2 (semantic: solver +
  // judge) LLM calls this check spent, in call order, when the runner reported them.
  // cost_usd is the SUM across legs; absent when no leg reported a number.
  task_run_ids?: string[];
  cost_usd?: number;
  /** The question requires prompt images, but not every referenced asset could be loaded. */
  image_input_unavailable?: boolean;
}

export type SolveCheckImageFetchFn = (
  assetIds: string[],
  db: Db,
) => Promise<Array<{ data: string; mediaType: string }>>;

// Per-tier override knob (OF-4 (ii)): future model 异源 / threshold tuning. Zero
// structural change — pass `{ solverModelOverride }` and the runner picks it up via
// ctx. Unused this slice except as the documented seam.
export interface SolveCheckOptions {
  runTaskFn: SolveCheckRunTaskFn;
  profile: SolveCheckProfile;
  // db is needed whenever SemanticJudge runs, including an exact-mismatch fallback.
  // biome-ignore lint/suspicious/noExplicitAny: leaf forwards the caller's Db handle to SemanticJudge.
  db?: any;
  /** OF-4(ii) seam: override the solver model per tier. Threaded into ctx. */
  solverModelOverride?: string;
  /** Test seam; production lazily resolves source_asset rows and R2 bytes. */
  imageFetchFn?: SolveCheckImageFetchFn;
}

// CONSERVATIVE threshold for the open-question semantic path (OF-4 / R2): only an
// 'incorrect' verdict AT OR ABOVE this confidence fails solve-check. High by design
// — the cost of a false 'fail' (killing a legitimate hard question) outweighs the
// cost of a false 'pass' (a bad question slipping through to the next gate / human
// review). Tunable per-tier via SolveCheckOptions in a later wave.
export const SOLVE_CHECK_SEMANTIC_THRESHOLD = 0.8;

// YUK-538 / YUK-554 (spec docs/design/2026-07-03-verify-check-spec.md §Q1) — tier3/4
// solve-check veto switches, split BY COMPARISON AXIS (compared_by). solve_check is the
// ONLY tier3/4 signal independent of the closed-book self-review (QuizVerifyTask), but its
// two comparison paths are wildly unequal in reliability:
//   - semantic (open kinds): runSemanticJudge + the conservative confidence>=0.8 gate
//     (SOLVE_CHECK_SEMANTIC_THRESHOLD, :393-394) → a confident independent disagreement
//     is worth blocking promotion → CONFIGURED TO VETO.
//   - normalize (exact kinds): cheap deterministic PASS when candidates match. YUK-612 routes a
//     mismatch through the conservative semantic path instead of emitting a normalize FAIL, because
//     boolean/numeric/format equivalence cannot be proven by string normalization. The normalize
//     switch remains for backward-compatible handling of historical/externally supplied results.
// OWNER (2026-07-03): normalize default = true, hold-for-review (needs_review → /drafts,
// DraftReviewPage YUK-403); NOT `failed`. Both flags are compile-time consts — flipping one
// needs a source edit + esbuild rebundle + worker redeploy (NOT a runtime toggle, unlike
// AI_PROVIDER_OVERRIDE's env switch); the pure-function seam solveCheckBlocks() below lets
// tests exercise flag-off without vi.doMock and adds no runtime config surface.
export const SOLVE_CHECK_TIER34_VETO = {
  semantic: true,
  normalize: true, // owner-decision default; hold-for-review (needs_review), NOT proven-wrong
} as const;

// Pure-function veto decision (test seam): given a SolveCheckResult + the per-axis flags,
// answer "does this block promotion?". Only a 'fail' verdict can block; the axis
// (compared_by) picks which flag applies. 'unsupported'/'pass' NEVER block (R2 conservative
// — a solver that couldn't independently solve, or that agreed, must not kill a question).
// Every live tier3/4 caller supplies `db`, so an exact mismatch can reach SemanticJudge. If a
// future caller omits it, `normalized_exact_mismatch + unsupported` intentionally remains
// non-blocking here; that caller must add its own provenance hold (as tier2 does) rather than
// silently changing this shared conservative policy.
//
// R4 (YUK-554 review) — DELIBERATE tier asymmetry remains at the CONSUMER: tier2
// (source_verify.ts) vetoes every emitted solve fail, while tier3/4 selects the axis flag here.
// YUK-612 supersedes the old producer assumption that a raw normalize mismatch is itself a strong
// fail signal: all callers now route that mismatch through SemanticJudge first. The normalize flag
// remains for historical or externally supplied results; changing how either handler consumes an
// actual normalize fail still requires revisiting the source-provenance difference.
export function solveCheckBlocks(
  result: SolveCheckResult,
  flags: { semantic: boolean; normalize: boolean } = SOLVE_CHECK_TIER34_VETO,
): boolean {
  if (result.verdict !== 'fail') return false;
  if (result.compared_by === 'semantic') return flags.semantic;
  if (result.compared_by === 'normalize') return flags.normalize;
  return false; // compared_by === 'none' never accompanies verdict='fail'; defensive.
}

// Question kinds whose answer is an EXACT token (compare by normalization). Open
// kinds (prose) route to the conservative semantic path. Mirrors the judge layer's
// exact-vs-semantic split without importing it (this is a content-quality check, not
// a student-grading judge).
const EXACT_KINDS = new Set(['choice', 'true_false', 'fill_blank']);

function isExactQuestion(q: SolveCheckQuestion): boolean {
  if (q.judge_kind_override === 'exact') return true;
  if (q.judge_kind_override === 'keyword' || q.judge_kind_override === 'semantic') return false;
  // Structure is the source of truth for the exact/semantic split, mirroring the
  // formal judge dispatch (route-resolve.ts: `choices.length > 0 → 'exact'`). A row
  // with persisted choices is a single/multiple-choice item regardless of the kind
  // string a subject profile uses (history/学科 题型 expose 'single_choice' etc.
  // while the canonical QuestionKind enum only knows 'choice'). Without this, those
  // rows fell through to the conservative semantic path and a wrong reference answer
  // went undetected by solve-check.
  if ((q.choices_md ?? []).length > 0) return true;
  return EXACT_KINDS.has(q.kind);
}

// F2: the question's declared answer for solve-check comparison. solution-generate.ts
// writes the STRUCTURED final answer to rubric_json.reference_solution.final_answer
// (+ answer_equivalents) while reference_md holds the full worked solution prose.
// Comparing an exact solver answer against an entire worked solution would falsely
// fail, so prefer the structured final answer and only fall back to reference_md when
// no structured answer is present.
//
// A1 (YUK-554 独立 review) — the reference_md fallback is the COMMON case for quiz_gen rows:
// quiz_gen writes reference_md + rubric_json{keywords,required_points} but NO
// reference_solution, and both backfill paths gate on reference_md IS NULL (quiz_gen rows
// are always non-null → never backfilled). An exact-kind quiz_gen reference_md is typically
// 「答案+解析」 prose, so the whole-text candidate alone made normalize-compare a
// near-guaranteed false FAIL. Mitigation: ALSO derive (a) the first LINE and (b) the first
// SENTENCE of that line (split on full-width enders 。！？ only — ASCII '.' excluded so
// decimals like "3.14" never truncate) as candidates; the quiz_gen prompt contract puts the
// bare answer first (choice/true_false: correct option text). Reverse (false-pass) risk: a
// solver final_answer would have to normalize-equal a NON-answer prose line — implausible
// for exact-shaped rows (the exact path is already gated to EXACT_KINDS / persisted choices
// / judge='exact'), and a rare false pass merely reproduces the pre-solve-check status quo,
// vs. the certain false FAIL today. Whole-text candidate kept (multi-candidate `.includes`
// = any hit passes); candidate[0] stays the whole text so the semantic path's reference is
// unchanged. No kind gate — spec 附录 B (review A1 裁决).
function referenceAnswerCandidates(q: SolveCheckQuestion): string[] {
  const rubric = q.rubric_json;
  if (rubric !== null && typeof rubric === 'object' && !Array.isArray(rubric)) {
    const refSolution = (rubric as Record<string, unknown>).reference_solution;
    if (refSolution !== null && typeof refSolution === 'object' && !Array.isArray(refSolution)) {
      const rs = refSolution as Record<string, unknown>;
      const out: string[] = [];
      if (typeof rs.final_answer === 'string' && rs.final_answer.trim().length > 0) {
        out.push(rs.final_answer.trim());
      }
      if (Array.isArray(rs.answer_equivalents)) {
        for (const eq of rs.answer_equivalents) {
          if (typeof eq === 'string' && eq.trim().length > 0) out.push(eq.trim());
        }
      }
      if (out.length > 0) return out;
    }
  }
  const fallback = (q.reference_md ?? '').trim();
  if (fallback.length === 0) return [];
  const out = [fallback];
  // A1 — first line of the worked answer (quiz_gen contract: bare answer first).
  const firstLine = (fallback.split(/\r?\n/, 1)[0] ?? '').trim();
  if (firstLine.length > 0 && firstLine !== fallback) out.push(firstLine);
  // A1 — first sentence of that line (full-width enders only; '.' excluded for decimals).
  const firstSentence = (firstLine.split(/[。！？]/u, 1)[0] ?? '').trim();
  if (firstSentence.length > 0 && !out.includes(firstSentence)) out.push(firstSentence);
  return out;
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
  // low-pri (YUK-554 review A2, skip 裁决): `.` here is not dotAll — a multi-line labelled
  // answer won't strip. Post-A1 the fallback candidates are first-line/first-sentence
  // (single-line) so this is moot in practice; not worth a behavior-bearing regex change.
  // Try the balanced-bracket shape first. Otherwise `A (content)` is consumed
  // by the generic separator branch at the space and retains `(content)`.
  // A labelled answer is persisted with an uppercase option marker. Keep this
  // case-sensitive: treating lowercase function names such as `f(x)` as an
  // option wrapper would add the false candidate `x` and could normalize-pass
  // an actually wrong fill-blank answer.
  const match = /^([A-F])(?:\s*[(（\[【]\s*(.+?)\s*[)）\]】]\s*$|[\s.、:：)\]）-]+(.+))$/u.exec(
    normalized,
  );
  const stripped = (match?.[2] ?? match?.[3])?.trim();
  return stripped && stripped.length > 0 ? stripped : null;
}

// A1 (YUK-554 独立 review) — trailing sentence-punctuation variant for exact compare, applied
// symmetrically to BOTH reference and solver candidates via answerCandidates. normalizeAnswer
// deliberately strips whitespace only (mathematical symbols are load-bearing), so 『长安。』 vs
// 『长安』 was a stable false fail. Conservative trailing set: full-width 。．！？ + ASCII .!?
// — trailing-only, so interior punctuation ("3.14", "x=-1") is untouched.
function stripTrailingPunct(value: string): string | null {
  const stripped = value.replace(/[。．.!！?？]+$/u, '').trim();
  return stripped.length > 0 && stripped !== value ? stripped : null;
}

function addChoiceExpansion(out: string[], choice: string | undefined): void {
  if (!choice) return;
  // `choices_md` entries are option bodies, not answer wrappers. Re-running
  // wrapper stripping here would turn a real option such as F(x) into the false
  // candidate x. Explicit labels are stripped only from answer strings above.
  out.push(choice);
}

function answerCandidates(
  text: string,
  choices: readonly string[],
  allowChoiceWrapper: boolean,
): string[] {
  const out = [text];
  // Parenthesized A-F wrappers are only meaningful for an actual choice item.
  // Outside that context, F(x) / A(t) are load-bearing mathematical notation.
  const stripped = allowChoiceWrapper ? stripLeadingChoiceLabel(text) : null;
  if (stripped) out.push(stripped);

  const labelIndex = choiceLabelIndex(text);
  if (labelIndex !== null) {
    addChoiceExpansion(out, choices[labelIndex]);
  }

  // A1 — trailing-punct variant of every candidate gathered so far (both sides of the
  // compare flow through here, so 『长安』↔『长安。』 matches in either direction).
  for (const candidate of [...out]) {
    const trimmed = stripTrailingPunct(candidate);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }

  return out;
}

// OCR (PR #716) — `label` identifies the CALLER (check name + task kind) so a parse-failure
// error message names the check/task that actually blew up. This is a SHARED helper (solve_check
// + teaching_quality both parse a bare-JSON structured-output blob); without a caller-provided
// label, a teaching_quality parse failure was surfacing as "solve-check: SolutionGenerateTask
// output had no JSON object" — wrong check name AND wrong task name, misleading production
// triage. Each call site passes its own label; the solve_check call site's label reproduces the
// PRE-EXISTING string byte-identically (no behavior change there).
function extractJsonObject(text: string, label: string): unknown {
  // YUK-607 — 宽松提取（jsonrepair 修复带）。无 JSON 时的错误串与旧实现逐字节一致；解析失败
  // 重抛原始 SyntaxError，故 solve-check 的错误串 byte-identical 契约（OCR PR #716）不变。
  const extracted = parseJsonObjectLoose(text, label);
  if (extracted === null) {
    throw new Error(`${label} output had no JSON object`);
  }
  return extracted.json;
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
 *   - exact kinds: normalize match → 'pass'; mismatch → conservative SemanticJudge fallback
 *   - open kinds: SemanticJudge confidently says the answers disagree → 'fail';
 *                 anything softer (unsupported / partial / low confidence) → 'pass'
 */
export async function runSolveCheck(
  question: SolveCheckQuestion,
  opts: SolveCheckOptions,
): Promise<SolveCheckResult> {
  const requiresVision = (question.image_refs?.length ?? 0) > 0;
  // F2: prefer the structured final answer (rubric_json.reference_solution) over the
  // worked-solution prose in reference_md. referenceAnswer is the primary candidate
  // used for human-readable reason strings + the semantic-path reference; the full
  // list feeds the exact normalize-compare.
  const referenceCandidates = referenceAnswerCandidates(question);
  const referenceAnswer = referenceCandidates[0] ?? '';

  if (referenceAnswer.length === 0) {
    // No declared answer to compare against → nothing solve-check can assert.
    // EFF-3 (YUK-554 review) — hoisted BEFORE the solver call: with no reference the verdict
    // is 'unsupported' regardless of what the solver says, so don't spend the LLM call.
    // (Verdict/reason unchanged; this return no longer carries solver_final_answer since no
    // solve ran.)
    return {
      verdict: 'unsupported',
      reason: 'question has no reference answer to compare against',
      compared_by: 'none',
    };
  }

  // EFF-1 (YUK-554 review) — provenance/cost capture across the 1-2 LLM calls below.
  const taskRunIds: string[] = [];
  let costUsd: number | undefined;
  const recordRun = (r: { task_run_id?: string; cost_usd?: number }): void => {
    if (typeof r.task_run_id === 'string' && r.task_run_id.length > 0) {
      taskRunIds.push(r.task_run_id);
    }
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) {
      costUsd = (costUsd ?? 0) + r.cost_usd;
    }
  };
  const runProvenance = (): Pick<SolveCheckResult, 'task_run_ids' | 'cost_usd'> => ({
    ...(taskRunIds.length > 0 ? { task_run_ids: [...taskRunIds] } : {}),
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
  });

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
      figures_hint: question.figures ?? null,
      prompt_image_refs: question.image_refs ?? [],
    };
    const ctx: Record<string, unknown> = { db: opts.db, subjectProfile: opts.profile.full };
    // OF-4(ii) 异源旋钮真接线（PR #312 验证轮 V4）：生产 runner 的模型覆盖读
    // `ctx.override.model`（resolveTaskProvider(kind, ctx.override)），裸 `ctx.model`
    // 不会被读取——那是个死旋钮。
    if (opts.solverModelOverride) ctx.override = { model: opts.solverModelOverride };
    const promptImageRefs = question.image_refs ?? [];
    let taskInput: unknown = input;
    if (promptImageRefs.length > 0) {
      if (!opts.db) {
        return {
          verdict: 'unsupported',
          reason: 'prompt images require a Db handle for source_asset resolution',
          compared_by: 'none',
          image_input_unavailable: true,
        };
      }
      let images: Array<{ data: string; mediaType: string }>;
      try {
        const imageFetchFn =
          opts.imageFetchFn ?? (await import('@/server/ai/judges/steps-judge')).defaultImageFetch;
        images = await imageFetchFn(promptImageRefs, opts.db);
      } catch (err) {
        return {
          verdict: 'unsupported',
          reason: `prompt image fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          compared_by: 'none',
          image_input_unavailable: true,
        };
      }
      // defaultImageFetch deliberately skips missing rows/objects. For verification,
      // partial vision is semantic corruption: hold the draft instead of asking the
      // solver to guess from an incomplete figure set.
      if (images.length !== promptImageRefs.length) {
        return {
          verdict: 'unsupported',
          reason: `prompt image fetch resolved ${images.length}/${promptImageRefs.length} assets`,
          compared_by: 'none',
          image_input_unavailable: true,
        };
      }
      taskInput = { text: JSON.stringify(input), images };
    }
    const solverTaskKind = requiresVision ? 'SolutionGenerateVisionTask' : 'SolutionGenerateTask';
    const solverRun = await opts.runTaskFn(solverTaskKind, taskInput, ctx);
    recordRun(solverRun); // EFF-1 — captured before parse so a parse throw still keeps the spend.
    const { text } = solverRun;
    // Parse the structured output; only final_answer + answer_equivalents matter here.
    // Label reproduces the pre-existing error string byte-identically (OCR PR #716).
    const parsed = extractJsonObject(text, 'solve-check: SolutionGenerateTask') as {
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
      ...(requiresVision ? { image_input_unavailable: true } : {}),
      ...runProvenance(),
    };
  }

  if (solverFinalAnswer.length === 0) {
    return {
      verdict: 'unsupported',
      reason: 'solver returned an empty final_answer',
      compared_by: 'none',
      ...runProvenance(),
    };
  }

  // ----- exact path: normalize compare, then semantic fallback on mismatch -----
  let normalizedExactMismatch = false;
  if (isExactQuestion(question)) {
    const choices = question.choices_md ?? [];
    const allowChoiceWrapper = question.kind === 'choice' || choices.length > 0;
    const refCandidates = referenceCandidates
      .flatMap((candidate) => answerCandidates(candidate, choices, allowChoiceWrapper))
      .map(normalizeAnswer)
      .filter((c) => c.length > 0);
    const solverCandidates = [solverFinalAnswer, ...solverEquivalents]
      .flatMap((candidate) => answerCandidates(candidate, choices, allowChoiceWrapper))
      .map(normalizeAnswer)
      .filter((c) => c.length > 0);
    const agree = solverCandidates.some((candidate) => refCandidates.includes(candidate));
    if (agree) {
      return {
        verdict: 'pass',
        solver_final_answer: solverFinalAnswer,
        reason: 'solver answer matches the question reference (normalized)',
        compared_by: 'normalize',
        ...runProvenance(),
      };
    }
    normalizedExactMismatch = true;
  }

  // ----- open path / exact-mismatch fallback: SemanticJudge, conservative -----
  if (!opts.db) {
    // Without a Db handle the semantic path cannot run; be conservative.
    return {
      verdict: 'unsupported',
      solver_final_answer: solverFinalAnswer,
      reason: normalizedExactMismatch
        ? 'normalized exact answers disagreed, but SemanticJudge fallback needs a Db handle; skipped'
        : 'open-question solve-check needs a Db handle for SemanticJudge; skipped',
      compared_by: 'none',
      ...(normalizedExactMismatch ? { normalized_exact_mismatch: true } : {}),
      ...runProvenance(),
    };
  }
  // EFF-1 — the SemanticJudge leg's spend is only visible at the runTaskFn seam
  // (runSemanticJudge returns a JudgeResultV2T with no cost/run-id), so record it there.
  const recordingRunTaskFn: SolveCheckRunTaskFn = async (kind, input, ctx) => {
    const r = await opts.runTaskFn(kind, input, ctx);
    recordRun(r);
    return r;
  };
  // Treat the question's reference answer as the rubric/reference and the solver's
  // independent answer as the "submission". If the semantic judge CONFIDENTLY says
  // the solver answer is incorrect vs the reference, the persisted answer is suspect
  // → fail. Open questions keep the R2 conservative pass for softer outcomes. Exact
  // mismatches are stricter: only `correct` establishes equivalence; partial/unsupported/
  // low-confidence disagreement remains unresolved for provenance-aware consumers.
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
    runTaskFn: recordingRunTaskFn,
  };
  const judged = await runSemanticJudge(semParams);
  const confidentlyDisagrees =
    judged.coarse_outcome === 'incorrect' && judged.confidence >= SOLVE_CHECK_SEMANTIC_THRESHOLD;
  const confidentlyEquivalent =
    judged.coarse_outcome === 'correct' && judged.confidence >= SOLVE_CHECK_SEMANTIC_THRESHOLD;
  // For an exact mismatch, anything other than an explicit `correct` or a confident
  // `incorrect` does not establish equivalence. Preserve it as `unsupported`
  // so provenance-anchored tier 2 can hold for review instead of silently
  // promoting; tier 3/4 continues treating unsupported as non-blocking.
  const exactFallbackUnresolved =
    normalizedExactMismatch && !confidentlyEquivalent && !confidentlyDisagrees;
  const fallbackPrefix = normalizedExactMismatch ? 'Normalized exact candidates disagreed; ' : '';
  let verdict: SolveCheckResult['verdict'];
  let reason: string;
  if (confidentlyDisagrees) {
    verdict = 'fail';
    reason = `${fallbackPrefix}SemanticJudge confidently scored the independent solver answer as incorrect (confidence ${judged.confidence.toFixed(2)} >= ${SOLVE_CHECK_SEMANTIC_THRESHOLD})`;
  } else if (exactFallbackUnresolved) {
    verdict = 'unsupported';
    reason = `${fallbackPrefix}SemanticJudge could not establish equivalence (outcome=${judged.coarse_outcome}, confidence=${judged.confidence.toFixed(2)}) — hold provenance-anchored sources for review`;
  } else if (confidentlyEquivalent) {
    verdict = 'pass';
    reason = `${fallbackPrefix}SemanticJudge established equivalence (outcome=correct, confidence=${judged.confidence.toFixed(2)})`;
  } else {
    verdict = 'pass';
    reason = `${fallbackPrefix}SemanticJudge did not confidently disagree (outcome=${judged.coarse_outcome}, confidence=${judged.confidence.toFixed(2)}) — conservative pass`;
  }
  return {
    verdict,
    solver_final_answer: solverFinalAnswer,
    reason,
    compared_by: 'semantic',
    ...(normalizedExactMismatch ? { normalized_exact_mismatch: true } : {}),
    ...runProvenance(),
  };
}

// ---------- teaching-quality check (YUK-578 入池前审题闸) ----------
//
// 现有 verify 轴（grounding / copy_safety / knowledge_hit / kind_conformance + solve_check）
// 只保「题对不对、有没有抄、能不能解」，不保「问得清不清」。歧义题比事实错更隐蔽地污染 θ̂ 信号，
// 冷启期尤其值——第一批题就干净，θ̂ 从 day-one 就不被坏题带偏。这是照 solve_check（YUK-538/554）的
// 落地路径后加的又一个 tier3/4 独立检查：一次独立 LLM 调用（TeachingQualityTask，与自复核
// QuizVerifyTask 不同 task/prompt 维度），judge 纯只读题面数据（prompt_md / reference_md /
// rubric_json / choices），零运行数据前置。
//
// 三个检查轴（issue scope）：
//   1. 题干清晰度（clarity）：题干是否无歧义、可被唯一理解。
//   2. 唯一正解性（unique_answer）：是否只有一个正确答案；rubric 有容错声明（等价答案 / 容差）
//      的算满足——判据交给 judge，rubric_json 随 input 喂进去让它 CAN honor it。
//   3. 干扰项诊断力（distractor_power）：仅选择题；干扰项是否指向真实误区、有区分度。非选择题
//      SKIP 该轴（code-side determinism：由 choices 是否非空决定，不信 LLM 的自报）。
//
// 边界（issue 攻击轮加固）：本单只对干扰项做「泛化评估」——「误区人格判别力轴」（misconception
// typed_state 做 grounded persona）是独立 follow-up，NOT 本单。confident-fail 处置：只翻
// draft_status 留 draft + 记 needs_review 理由，绝不 promote（quiz_verify.ts 既有 verify-then-
// promote 骨架的 else 分支，不碰 draft_status）。
//
// PROMPT-CHANGE DISCIPLINE（校准纪律，对齐 YUK-573）：TeachingQualityTask 的 prompt（registry.ts）
// 与本 parser + 决策映射由 verify-framework.test.ts 的 mini golden set 钉死（清晰好题 pass / 歧义题干
// fail / 第二说得通答案 fail / 干扰项无诊断力 flag / 非选择题跳过干扰项轴 / rubric 容错声明满足唯一解 /
// parse 失败 → unsupported 不阻促进）。**改 prompt 或本输出契约（tests/helpers/teaching-quality-
// fixtures.ts）必须先过这组 fixture。**

// Loose run seam (mirrors SolveCheckRunTaskFn): the check consumes { text } from the runner,
// plus OPTIONAL task_run_id / cost_usd when the runner reports them (production TaskTextResult
// does; { text }-only test mocks still satisfy the type).
export type TeachingQualityRunTaskFn = (
  kind: string,
  input: unknown,
  ctx: unknown,
) => Promise<{ text: string; task_run_id?: string; cost_usd?: number }>;

// The minimal read-only question shape the check needs — pure 题面数据, zero runtime data.
export interface TeachingQualityQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
}

export interface TeachingQualityOptions {
  runTaskFn: TeachingQualityRunTaskFn;
  // YUK-606 — runner 的观测写（ai_task_runs / cost_ledger）读 ctx.db；此前 ctx 漏传 db，
  // 该轴每次 run 的三笔观测写全炸并被 best-effort 吞掉（run 不落库、成本漏记）。
  // 必填 + 强类型（review MINOR：any 只防漏传不防误传）。
  db: Db;
  // the resolved subject profile, forwarded in ctx for provenance/logging; the prompt
  // itself is subject-neutral (pass-through, registry.ts) and does not consume it.
  profile: {
    id: string;
    // biome-ignore lint/suspicious/noExplicitAny: caller passes a resolved SubjectProfile; this leaf only forwards it.
    full: any;
  };
}

// Per-axis verdict. clarity / unique_answer are always evaluated; distractor_power is
// 'skipped' for non-choice questions (or when the choice-question judge omits it).
export type TeachingQualityAxisVerdict = 'pass' | 'fail' | 'skipped';

export interface TeachingQualityAxis {
  verdict: TeachingQualityAxisVerdict;
  reason: string;
}

// Overall verdict: 'fail' if ANY in-scope axis failed; 'pass' if all in-scope axes passed;
// 'unsupported' when the judge produced no trustworthy signal (parse error / missing mandatory
// axis) — conservative, never blocks (R2, mirrors solve-check).
export type TeachingQualityVerdict = 'pass' | 'fail' | 'unsupported';

export interface TeachingQualityResult {
  verdict: TeachingQualityVerdict;
  clarity: TeachingQualityAxis;
  unique_answer: TeachingQualityAxis;
  distractor_power: TeachingQualityAxis;
  reason: string;
  // provenance/cost of the single LLM call, when the runner reported them.
  task_run_ids?: string[];
  cost_usd?: number;
}

// YUK-578 — per-axis veto switches (mirrors SOLVE_CHECK_TIER34_VETO). All three axes veto a
// fail by default. Split BY AXIS so the owner can later downgrade the generalized
// distractor_power axis to report-only (distractor_power:false) WITHOUT losing the
// clarity/unique-answer gate — the same switchability hedge solve_check carries for its
// semantic/normalize split. Compile-time consts (flipping one needs a source edit + esbuild
// rebundle + worker redeploy, NOT a runtime toggle); the pure-function seam
// teachingQualityBlocks() below lets tests exercise flag-off without vi.doMock.
export const TEACHING_QUALITY_TIER34_VETO = {
  clarity: true,
  unique_answer: true,
  distractor_power: true,
} as const;

// Pure-function veto decision (test seam): given a TeachingQualityResult + the per-axis flags,
// answer "does this block promotion?". Only an overall 'fail' can block; then the specific
// failing axis's flag decides. 'unsupported'/'pass' NEVER block (R2 conservative — a judge that
// produced no signal, or that approved, must not hold a good question for review).
export function teachingQualityBlocks(
  result: TeachingQualityResult,
  flags: {
    clarity: boolean;
    unique_answer: boolean;
    distractor_power: boolean;
  } = TEACHING_QUALITY_TIER34_VETO,
): boolean {
  if (result.verdict !== 'fail') return false;
  if (result.clarity.verdict === 'fail' && flags.clarity) return true;
  if (result.unique_answer.verdict === 'fail' && flags.unique_answer) return true;
  if (result.distractor_power.verdict === 'fail' && flags.distractor_power) return true;
  return false;
}

// Parse one axis object { verdict, reason } from the raw judge output. Returns null when the
// verdict is absent/invalid (so a missing mandatory axis surfaces as 'unsupported' overall
// rather than a fabricated verdict).
function readTeachingAxis(raw: unknown): TeachingQualityAxis | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== 'pass' && verdict !== 'fail') return null;
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { verdict, reason };
}

/**
 * Teaching-quality审题闸: a separate judge (TeachingQualityTask) reads ONLY the question面
 * data and scores three pedagogical axes — 题干清晰度 / 唯一正解性 / 干扰项诊断力(仅选择题).
 *
 * CONSERVATIVE by design (R2, mirrors solve-check): the goal is to catch ambiguous / multi-answer
 * / no-diagnostic questions BEFORE they enter the θ̂ signal source, WITHOUT killing good ones the
 * judge merely failed to parse. So:
 *   - task throws / unparseable / missing a mandatory axis  → 'unsupported' (NOT fail — no signal)
 *   - any in-scope axis 'fail'                              → overall 'fail' (blocks via veto)
 *   - all in-scope axes 'pass'                              → overall 'pass'
 * distractor_power is code-side gated to choice questions (choices非空); non-choice → 'skipped'.
 */
export async function runTeachingQualityCheck(
  question: TeachingQualityQuestion,
  opts: TeachingQualityOptions,
): Promise<TeachingQualityResult> {
  const isChoice = (question.choices_md ?? []).length > 0;

  const taskRunIds: string[] = [];
  let costUsd: number | undefined;
  const recordRun = (r: { task_run_id?: string; cost_usd?: number }): void => {
    if (typeof r.task_run_id === 'string' && r.task_run_id.length > 0)
      taskRunIds.push(r.task_run_id);
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) {
      costUsd = (costUsd ?? 0) + r.cost_usd;
    }
  };
  const runProvenance = (): Pick<TeachingQualityResult, 'task_run_ids' | 'cost_usd'> => ({
    ...(taskRunIds.length > 0 ? { task_run_ids: [...taskRunIds] } : {}),
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
  });

  const skipped = (verdict: TeachingQualityVerdict, reason: string): TeachingQualityResult => ({
    verdict,
    clarity: { verdict: 'skipped', reason },
    unique_answer: { verdict: 'skipped', reason },
    distractor_power: { verdict: 'skipped', reason },
    reason,
    ...runProvenance(),
  });

  let parsed: unknown;
  try {
    const input = {
      prompt_md: question.prompt_md,
      kind: question.kind,
      reference_md: question.reference_md,
      // Choice options live in a separate column — pass them explicitly so the distractor
      // axis has the actual options to reason about.
      choices_md: question.choices_md ?? [],
      // rubric_json carries any容错声明 (answer_equivalents / tolerance); the judge reads it to
      // decide whether the unique-answer axis is satisfied ("rubric 有容错声明的算满足").
      rubric_json: question.rubric_json ?? null,
      // code-side ground truth for the distractor axis (do NOT trust the LLM to self-classify).
      is_choice: isChoice,
    };
    // YUK-606 — db 进 ctx：与 solve_check 支路（:436）同款，runner 观测写依赖它。
    const ctx = { db: opts.db, subjectProfile: opts.profile.full };
    const run = await opts.runTaskFn('TeachingQualityTask', input, ctx);
    recordRun(run);
    parsed = extractJsonObject(run.text, 'teaching-quality: TeachingQualityTask');
  } catch (err) {
    return skipped(
      'unsupported',
      `teaching-quality judge did not produce usable output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return skipped('unsupported', 'teaching-quality output was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const clarity = readTeachingAxis(obj.clarity);
  const uniqueAnswer = readTeachingAxis(obj.unique_answer);
  if (!clarity || !uniqueAnswer) {
    // A missing mandatory axis means the output is untrustworthy — no signal, do not block.
    return skipped(
      'unsupported',
      'teaching-quality output missing a mandatory axis (clarity / unique_answer)',
    );
  }

  // distractor_power: choice questions only. Non-choice → skipped (never contributes to fail);
  // a choice question whose judge omitted the verdict is also skipped (do not fabricate a fail).
  let distractor: TeachingQualityAxis;
  if (isChoice) {
    distractor = readTeachingAxis(obj.distractor_power) ?? {
      verdict: 'skipped',
      reason: 'distractor_power verdict absent from choice-question judge output',
    };
  } else {
    distractor = {
      verdict: 'skipped',
      reason: 'non-choice question — distractor diagnostic-power axis skipped',
    };
  }

  const failingAxes: string[] = [];
  if (clarity.verdict === 'fail') failingAxes.push('clarity');
  if (uniqueAnswer.verdict === 'fail') failingAxes.push('unique_answer');
  if (distractor.verdict === 'fail') failingAxes.push('distractor_power');
  const verdict: TeachingQualityVerdict = failingAxes.length > 0 ? 'fail' : 'pass';
  const reason =
    failingAxes.length > 0
      ? `teaching-quality fail on: ${failingAxes.join(', ')}`
      : 'teaching-quality pass on all in-scope axes';

  return {
    verdict,
    clarity,
    unique_answer: uniqueAnswer,
    distractor_power: distractor,
    reason,
    ...runProvenance(),
  };
}
