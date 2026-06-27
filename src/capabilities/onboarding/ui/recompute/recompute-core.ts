// YUK-495 S5 #41 — UI verdict layer over the bit-exact re-derivation core (src/core/recompute).
//
// Bridges a placement-profile ProfileKc + the server's sigma_mode → a per-KC verdict the
// verify components render. The MATH lives in src/core/recompute/derive-profile-kc.ts
// (deriveProfileKc / compareKc); this is the thin UI-facing adapter (formatting, the
// per-field diff list, the sigma_mode-aware honesty regime). No IO, no network.
//
// sigma_mode regime (the interim honesty, driven by the server payload — see Slice B):
//   • 'poly'  (POLY_SIGMOID_ENABLED=true)  — server σ IS polySigmoid → the device re-derivation
//     is bit-exact; compare with Object.is and surface a truthful ✓ 逐位 / ✗ 不符.
//   • 'libm'  (POLY_SIGMOID_ENABLED=false) — server σ is Math.exp (≤1 ULP off the device's
//     polySigmoid). An exact compare would scream "drift" on every KC (false alarm), so we
//     compare at DISPLAY precision (round-2) and label it an honest "预览 · 待 σ 对齐后逐位校验".
//     A round-2 mismatch in this regime is a real DISPLAY bug → still surfaced as drift.

import { type DerivedKc, deriveProfileKc } from '@/core/recompute/derive-profile-kc';
import type { ProfileKc } from '../profile-api';
import type { CalibrationMaturityResponse } from './calibration-maturity-api';

/** UI-only gate for the whole #41 verify layer — dark-ship until visually verified. */
export const RECOMPUTE_BADGE_ENABLED = false;

export type SigmaMode = 'poly' | 'libm';

export type RcKind =
  | 'na' // untested — no numbers to re-derive
  | 'match' // poly regime, bit-for-bit equal
  | 'drift' // a real disagreement (exact in poly, display-level in libm)
  | 'preview'; // libm regime, display-consistent (exact verify pending the σ flip)

export interface RcFieldDiff {
  field: 'p_l' | 'mastery_lo' | 'mastery_hi' | 'se';
  label: string;
  server: number;
  device: number;
}

export interface RcKcVerdict {
  id: string;
  name: string;
  kind: RcKind;
  /** present when tested — the display ledger row (server-displayed values + raw evidence). */
  ledger?: {
    s: number;
    f: number;
    b: number;
    p_l: number;
    mastery_lo: number;
    mastery_hi: number;
    se: number;
  };
  /** the re-derivation (device side), present when tested. */
  derived?: DerivedKc;
  /** non-matching fields (empty ⇒ match/preview), for the drift detail. */
  diffs: RcFieldDiff[];
}

const FIELD_LABELS: Record<RcFieldDiff['field'], string> = {
  p_l: 'p̂ 掌握点',
  mastery_lo: '区间下界',
  mastery_hi: '区间上界',
  se: 'SE',
};

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Re-derive + compare ONE KC and classify it under the sigma_mode honesty regime. */
export function deriveKcVerdict(kc: ProfileKc, sigmaMode: SigmaMode): RcKcVerdict {
  const untested = !kc.tested || kc.evidence_count === 0;
  if (untested) {
    return { id: kc.id, name: kc.name, kind: 'na', diffs: [] };
  }

  const evidence = {
    success_count: kc.success_count ?? 0,
    fail_count: kc.fail_count ?? 0,
    beta: kc.beta ?? 0,
    theta_precision: kc.theta_precision ?? 0,
  };
  const server = {
    p_l: kc.p_l ?? 0,
    mastery_lo: kc.mastery_lo ?? 0,
    mastery_hi: kc.mastery_hi ?? 0,
    theta_se: kc.theta_se ?? 0,
  };
  const derived = deriveProfileKc(evidence);

  // The compare criterion is the honesty regime: exact (poly) vs display-precision (libm).
  const eq =
    sigmaMode === 'poly'
      ? (a: number, b: number) => Object.is(a, b)
      : (a: number, b: number) => round2(a) === round2(b);

  const pairs: Array<[RcFieldDiff['field'], number, number]> = [
    ['p_l', server.p_l, derived.point],
    ['mastery_lo', server.mastery_lo, derived.lo],
    ['mastery_hi', server.mastery_hi, derived.hi],
    ['se', server.theta_se, derived.se],
  ];
  const diffs: RcFieldDiff[] = pairs
    .filter(([, s, d]) => !eq(s, d))
    .map(([field, s, d]) => ({ field, label: FIELD_LABELS[field], server: s, device: d }));

  const kind: RcKind = diffs.length > 0 ? 'drift' : sigmaMode === 'poly' ? 'match' : 'preview';

  return {
    id: kc.id,
    name: kc.name,
    kind,
    ledger: {
      s: evidence.success_count,
      f: evidence.fail_count,
      b: evidence.beta,
      p_l: server.p_l,
      mastery_lo: server.mastery_lo,
      mastery_hi: server.mastery_hi,
      se: server.theta_se,
    },
    derived,
    diffs,
  };
}

export interface RcSummary {
  /** overall state across tested KCs: drift if any drifts, else match (poly) / preview (libm). */
  overall: 'match' | 'drift' | 'preview';
  verdicts: RcKcVerdict[];
  testedCount: number;
  driftCount: number;
  /** the first drifted verdict, for the single-KC drift detail. */
  firstDrift?: RcKcVerdict;
}

/** Re-derive every KC and roll up the profile-level verify summary. */
export function summarizeRecompute(kcs: ProfileKc[], sigmaMode: SigmaMode): RcSummary {
  const verdicts = kcs.map((kc) => deriveKcVerdict(kc, sigmaMode));
  const tested = verdicts.filter((v) => v.kind !== 'na');
  const drifts = tested.filter((v) => v.kind === 'drift');
  const overall: RcSummary['overall'] =
    drifts.length > 0 ? 'drift' : sigmaMode === 'poly' ? 'match' : 'preview';
  return {
    overall,
    verdicts,
    testedCount: tested.length,
    driftCount: drifts.length,
    firstDrift: drifts[0],
  };
}

/** Two-decimal display formatter (mirrors the design's rcFmt). */
export const rcFmt = (v: number | undefined) => (v == null ? '—' : v.toFixed(2));

// ── D2: calibration-maturity reconciliation (YUK-495 S5 #41 #45) ──────────────
//
// Unlike the per-KC verify above, the two maturity quantities are BOTH σ-independent:
//   • firm_count      = a pure integer count (cold_start rule: !cold_start), no σ.
//   • median_theta_se = median of thetaSe(precision), and thetaSe is pure IEEE
//     (1/√precision), no σ.
// So the device re-derivation and the server aggregate are expected to be Object.is
// EQUAL under both the poly and libm σ regimes — there is no "preview" honesty split
// here. The maturity badge is therefore a two-state reconciliation: 'match' (bit-for-bit)
// or 'drift' (a real disagreement). The brief 'running' flash is the useRecompute state
// machine's, not a third summary outcome.

export interface RcMaturitySummary {
  /** 'match' when device re-derivation === server aggregate bit-for-bit, else 'drift'. */
  overall: 'match' | 'drift';
  /** device-side firm count = rows where !cold_start. */
  dFirm: number;
  /** server aggregate.firm_count. */
  sFirm: number;
  /** device-side median theta_se (mirrors the server median exactly); null when no rows have one. */
  dMedian: number | null;
  /** server aggregate.median_theta_se. */
  sMedian: number | null;
  /** total KC count (rows.length). */
  total: number;
}

/**
 * Bit-exact mirror of the server's median_theta_se (server/calibration-maturity.ts):
 * sort ascending, then floor-mid midpoint (even ⇒ average of the two central values,
 * odd ⇒ the central value). Empty ⇒ null. Identical ordering + arithmetic ⇒ Object.is
 * with the server aggregate holds.
 */
function maturityMedian(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Re-derive the maturity overview (firm count + median θ̂ SE) from the raw rows and
 * reconcile it against the server aggregate — integer compare on firm, Object.is on the
 * (σ-independent) median. No sigma_mode parameter: neither quantity depends on σ.
 */
export function summarizeMaturity(resp: CalibrationMaturityResponse): RcMaturitySummary {
  // !cold_start mirrors the server's firm_count (= total − coldStartCount, where
  // coldStart also covers never-attempted KCs). Do NOT add `&& evidence_count > 0`:
  // it would diverge from the server definition (the design prototype's redundant guard).
  const dFirm = resp.rows.filter((r) => !r.cold_start).length;
  const seValues = resp.rows
    .map((r) => r.theta_se)
    .filter((se): se is number => se != null)
    .sort((a, b) => a - b);
  const dMedian = maturityMedian(seValues);

  const sFirm = resp.aggregate.firm_count;
  const sMedian = resp.aggregate.median_theta_se;
  const firmMatch = dFirm === sFirm;
  // Object.is so null↔null reconciles and any float bit-difference (or NaN) surfaces as drift.
  const medianMatch = Object.is(dMedian, sMedian);

  return {
    overall: firmMatch && medianMatch ? 'match' : 'drift',
    dFirm,
    sFirm,
    dMedian,
    sMedian,
    total: resp.rows.length,
  };
}
