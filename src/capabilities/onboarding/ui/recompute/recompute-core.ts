// UI verdict over src/core/recompute. No IO.
// poly: the server sigma is polySigmoid, so Object.is is a real bit match.
// libm: the server sigma is Math.exp, up to 1 ULP off. An exact compare would
// mark a tested KC drifted on that gap. Untested KCs stay na, so this regime
// compares tested KCs at display precision and says preview.
// A display-precision mismatch is still drift.

import { type DerivedKc, deriveProfileKc } from '@/core/recompute/derive-profile-kc';
import type { ProfileKc } from '../profile-api';
import type { CalibrationMaturityResponse } from './calibration-maturity-api';

/** On. libm preview stays until POLY_SIGMOID_ENABLED flips. */
export const RECOMPUTE_BADGE_ENABLED = true;

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
  p_l: '当前判断',
  mastery_lo: '可能区间起点',
  mastery_hi: '可能区间终点',
  se: '判断波动',
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

// Firm count and median theta SE do not use sigma, so poly and libm both expect Object.is.
// There is no preview state. running belongs to the flash, not to this summary.

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
 * Same ordering and midpoint as the server median. That is why Object.is can hold.
 * Even length averages the two central values. Odd length takes the central value. Empty is null.
 */
function maturityMedian(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Integer compare on firm count. Object.is on the median. Neither quantity uses sigma. */
export function summarizeMaturity(resp: CalibrationMaturityResponse): RcMaturitySummary {
  // Firm count is !cold_start. Never-attempted KCs are cold_start, so they stay out.
  // The predicate stays the server's. An extra evidence_count check is not part of it.
  const dFirm = resp.rows.filter((r) => !r.cold_start).length;
  const seValues = resp.rows
    .map((r) => r.theta_se)
    .filter((se): se is number => se != null)
    .sort((a, b) => a - b);
  const dMedian = maturityMedian(seValues);

  const sFirm = resp.aggregate.firm_count;
  const sMedian = resp.aggregate.median_theta_se;
  const firmMatch = dFirm === sFirm;
  // Object.is so null matches null, and any float bit difference is drift.
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
