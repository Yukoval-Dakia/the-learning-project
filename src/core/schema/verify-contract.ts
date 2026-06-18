// YUK-350 (B5 increment C) — unified verify contract (Verifier Router shape).
//
// docs/adr/0038-unified-verify-contract-plan-then-generate.md 决定 #1（三套
// promote-gated 信任闸收敛到 QuizGen 多轴多信号模板：多轴 check + verdict + note →
// rollup `overall`）+ 决定 #5（'error' 通道：transport/parse/DB 在产出 verdict 前炸了
// 与「验了判失败」在 result 层分开）.
//
// SCOPE (this increment): the THREE promote-gated handlers only —
//   - quiz_verify   (multi-axis QuizVerificationResult.overall)
//   - source_verify (tier-2 per-check array + promote bool, previously had NO overall)
//   - variant_verify(single pass|fail verdict + cause_targeting)
// note_verify is DEFERRED (ADR-0038 Amendment 2026-06-15; different promote
// semantics —笔记不 enroll 进练习池). It is intentionally NOT a `toUnifiedVerifyResult`
// branch here.
//
// This module is the SHARED HOME (core/ — cross-subject, no IO) for:
//   - UnifiedVerifyResult  : the one verify-event payload SHAPE (a SUPERSET — handlers
//                            keep emitting their existing payload keys ON TOP of this).
//   - VerifyFailureClass   : LIFTED UP from quiz_verify.ts (event-layer WHY-not-promote).
//   - QuizVerifyOverall    : LIFTED UP from quiz_gen.ts (result-layer 4-value union).
//   - toUnifiedVerifyResult: a PURE projection helper mapping each handler input into
//                            the unified shape (provably-equivalent — it changes NO
//                            promote/active-write predicate; promote/verdict is passed
//                            IN, never recomputed here).
//
// RED LINE 1 (ADR-0038 决定 #5): the LLM-parse `QuizVerificationResult.overall` stays
// FROZEN at 3 values (pass|needs_review|fail). 'error' lives ONLY here on the
// result-layer projection (QuizVerifyOverall) + the catch-bottom — the model can never
// self-report a system failure. This module does NOT widen the LLM parse enum.

import { z } from 'zod';

import { QuizVerificationResult } from './quiz_gen';

// ---------- failure_class (LIFTED from quiz_verify.ts) ----------
//
// YUK-350 (L3, RL5) — event-layer projection of WHY a verify did not promote.
// 'system_error' = the task/parse/DB blew up before a verdict (catch-bottom; the
// event-layer twin of the result-layer overall='error'). 'validation_failure' = the
// model/checks produced a verdict but the gate rejected promotion (a REAL fail /
// needs_review). Written ONLY on failure/error paths; promote success carries no
// failure_class. This was a bare `type` in quiz_verify.ts; here it gains a Zod enum so
// the unified payload shape is validatable, but the value space is byte-identical.
export const VerifyFailureClass = z.enum(['system_error', 'validation_failure']);
export type VerifyFailureClass = z.infer<typeof VerifyFailureClass>;

// ---------- result-layer 4-value overall (LIFTED from quiz_gen.ts) ----------
//
// YUK-350 (RL1) — the value space the verify-event payload carries: the 3-value model
// verdict (pass|needs_review|fail) PLUS the system-error class 'error', assigned
// EXCLUSIVELY by a catch-bottom when the task threw before producing a verdict.
// Splitting it from the LLM-parse `QuizVerificationResult.overall` keeps the model
// parse path physically unable to emit 'error'. 'error' must NEVER promote (the catch
// path throws before any promote). Derived from the FROZEN LLM enum + 'error' so the
// 3-value model verdict and this 4-value projection cannot drift.
export const QuizVerifyOverall = z.enum([...QuizVerificationResult.shape.overall.options, 'error']);
export type QuizVerifyOverall = z.infer<typeof QuizVerifyOverall>;

// ---------- the unified verify axis ----------
//
// One signal in the multi-axis verdict. `verdict` is a permissive union covering every
// per-axis verdict vocabulary across the three收敛 handlers — quiz checks
// (pass|fail|unclear) + quiz rollup states (needs_review) + copy_safety
// (original|too_close|unknown) + source per-check (pass|fail|unsupported) + variant
// cause_targeting (on_target|off_target|unclear). It is intentionally wider than any
// single handler so the projection never has to lose information; the gate decision is
// NOT derived from these strings here (promote/overall is passed in).
export const VerifyAxisVerdict = z.enum([
  'pass',
  'fail',
  'needs_review',
  'unclear',
  'unsupported',
  'original',
  'too_close',
  'unknown',
  'on_target',
  'off_target',
]);
export type VerifyAxisVerdict = z.infer<typeof VerifyAxisVerdict>;

export const VerifyAxis = z.object({
  axis_name: z.string().min(1),
  verdict: VerifyAxisVerdict,
  note: z.string().optional(),
});
export type VerifyAxisT = z.infer<typeof VerifyAxis>;

// ---------- the one unified verify-event result shape ----------
export const UnifiedVerifyResult = z.object({
  axes: z.array(VerifyAxis),
  overall: QuizVerifyOverall,
  // present ONLY when overall != 'pass' (validation_failure) or = 'error' (system_error).
  failure_class: VerifyFailureClass.optional(),
  summary_md: z.string(),
  confidence: z.number().min(0).max(1),
});
export type UnifiedVerifyResultT = z.infer<typeof UnifiedVerifyResult>;

// ---------- projection inputs (one per promote-gated handler + the catch path) ----------

/** quiz_verify input: the multi-axis QuizVerificationResult.overall + its checks. */
export interface QuizVerifyProjectionInput {
  source: 'quiz';
  /** the LLM-parse 3-value verdict, AS COMPUTED by the handler. */
  overall: 'pass' | 'needs_review' | 'fail';
  /** the handler's already-decided promote predicate — passed IN, not recomputed. */
  promote: boolean;
  summary_md: string;
  confidence: number;
  /** each scored axis (axis_name + verdict + optional note). */
  checks: Array<{ axis_name: string; verdict: VerifyAxisVerdict; note?: string }>;
}

/** source_verify input: the tier-2 per-check array + the handler's promote bool. */
export interface SourceVerifyProjectionInput {
  source: 'source';
  /** the handler's already-decided promote predicate — passed IN, not recomputed. */
  promote: boolean;
  summary_md: string;
  confidence: number;
  /** the tier-2 CheckOutcome[] (check name + pass|fail|unsupported verdict + reason). */
  checks: Array<{ check: string; verdict: 'pass' | 'fail' | 'unsupported'; reason: string }>;
}

/** variant_verify input: the single pass|fail verdict + cause_targeting. */
export interface VariantVerifyProjectionInput {
  source: 'variant';
  verdict: 'pass' | 'fail';
  cause_targeting: 'on_target' | 'off_target' | 'unclear';
  failure_reasons: string[];
  summary_md: string;
  confidence: number;
}

/** catch-bottom input: a system error before any verdict. */
export interface SystemErrorProjectionInput {
  source: 'system_error';
  summary_md: string;
  error: string;
}

export type VerifyProjectionInput =
  | QuizVerifyProjectionInput
  | SourceVerifyProjectionInput
  | VariantVerifyProjectionInput
  | SystemErrorProjectionInput;

// ---------- the pure projection helper ----------
//
// Maps each handler's existing shape into UnifiedVerifyResult. PROVABLY-EQUIVALENT:
// it never re-derives a promote/active-write decision — quiz passes its `overall` +
// `promote`, source passes its `promote`, variant passes its `verdict`. The helper only
// PROJECTS those into a shared shape (and, for source, rolls the per-check array up into
// an `overall` that source-verify previously lacked — WITHOUT touching its promote
// predicate, which lives in the handler).
export function toUnifiedVerifyResult(input: VerifyProjectionInput): UnifiedVerifyResultT {
  switch (input.source) {
    case 'quiz': {
      // overall is the model verdict the handler computed; the 4-value union widens it
      // (the model can only emit the 3 values — 'error' never reaches here).
      const overall: QuizVerifyOverall = input.overall;
      return {
        axes: input.checks.map((c) => ({
          axis_name: c.axis_name,
          verdict: c.verdict,
          ...(c.note !== undefined ? { note: c.note } : {}),
        })),
        overall,
        // additive: a verdict that did NOT promote is a validation failure. promote=true
        // carries no failure_class (symmetry with the existing quiz_verify payload).
        ...(input.promote ? {} : { failure_class: 'validation_failure' as const }),
        summary_md: input.summary_md,
        confidence: input.confidence,
      };
    }
    case 'source': {
      // ROLL UP the per-check array into an overall (fills source-verify's previously
      // -missing overall): any 'fail' check ⇒ fail; otherwise the handler's promote bool
      // decides — promote=true ⇒ pass, promote=false-with-no-failing-check ⇒ needs_review
      // (e.g. the knowledge-survival gate blocked promotion outside the checks[] array).
      // This NEVER changes the promote predicate — promote is passed in unchanged.
      const hasFailingCheck = input.checks.some((c) => c.verdict === 'fail');
      const overall: QuizVerifyOverall = input.promote
        ? 'pass'
        : hasFailingCheck
          ? 'fail'
          : 'needs_review';
      return {
        axes: input.checks.map((c) => ({
          axis_name: c.check,
          verdict: c.verdict,
          ...(c.reason ? { note: c.reason } : {}),
        })),
        overall,
        ...(input.promote ? {} : { failure_class: 'validation_failure' as const }),
        summary_md: input.summary_md,
        confidence: input.confidence,
      };
    }
    case 'variant': {
      // single pass|fail verdict; cause_targeting becomes an axis. fail ⇒ fail +
      // validation_failure, pass ⇒ pass + no failure_class (symmetry with the existing
      // variant_verify payload, which keys failure_class only on verdict='fail').
      const overall: QuizVerifyOverall = input.verdict === 'pass' ? 'pass' : 'fail';
      const axes: VerifyAxisT[] = [
        {
          axis_name: 'cause_targeting',
          verdict: input.cause_targeting,
          ...(input.failure_reasons.length > 0 ? { note: input.failure_reasons.join('; ') } : {}),
        },
      ];
      return {
        axes,
        overall,
        ...(input.verdict === 'fail' ? { failure_class: 'validation_failure' as const } : {}),
        summary_md: input.summary_md,
        confidence: input.confidence,
      };
    }
    case 'system_error': {
      // catch-bottom: the task/parse/DB threw before a verdict. overall='error' (the
      // ONLY producer of the result-layer 'error' value) + failure_class='system_error'.
      // No axes (no verdict was produced); confidence 0.
      return {
        axes: [],
        overall: 'error',
        failure_class: 'system_error',
        summary_md: input.summary_md,
        confidence: 0,
      };
    }
  }
}
