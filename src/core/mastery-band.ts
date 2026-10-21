// A5 S1 (YUK-354) — mastery band display derivation. Pure, no write-back; the band
// shows only the p(L) axis.
//
// Lives in core because server code needed these helpers and there was no precedent
// for server→capability-ui imports. Source 'hard'/'soft' means calibrated evidence vs
// prior (evidence_count>0), NOT item_calibration.track. Bands use the real
// mastery_lo/hi rather than estimating a spread from evidence count.

// Band lower bounds in probability space.
export const MASTERY_BAND_THRESHOLDS = {
  /** 萌芽 < 0.4 ≤ 成长 */
  growing: 0.4,
  /** 成长 < 0.6 ≤ 稳固 */
  solid: 0.6,
  /** 稳固 < 0.8 ≤ 精熟 */
  mastered: 0.8,
} as const;

export const A5_BANDS = ['萌芽', '成长', '稳固', '精熟'] as const;

// Explicit unknown label: cold start must never render as 0 (萌芽).
export const UNKNOWN_BAND_LABEL = '未知';

export type MasteryBandIdx = 0 | 1 | 2 | 3;
export type MasterySource = 'hard' | 'soft';

/** Map a p(L) point (0-1) to a band index. */
export function masteryBandIdx(p: number): MasteryBandIdx {
  if (p < MASTERY_BAND_THRESHOLDS.growing) return 0;
  if (p < MASTERY_BAND_THRESHOLDS.solid) return 1;
  if (p < MASTERY_BAND_THRESHOLDS.mastered) return 2;
  return 3;
}

// Minimal read shape shared by the node page and tree/graph wires; mastery null means
// cold start (absent from the projection map).
export interface MasteryBandInput {
  mastery: number | null;
  mastery_lo: number | null;
  mastery_hi: number | null;
  low_confidence: boolean;
  evidence_count: number;
}

// Discriminated view: cold-start unknown vs evidenced. BandChip narrows on `unknown`.
export type MasteryBandView =
  | {
      unknown: true;
      source: MasterySource;
      lowConf: boolean;
    }
  | {
      unknown: false;
      band: MasteryBandIdx;
      loBand: MasteryBandIdx;
      hiBand: MasteryBandIdx;
      source: MasterySource;
      lowConf: boolean;
    };

/** Cold start: absent projection/mastery → explicit unknown, soft, low confidence. */
export function masteryBandUnknown(): MasteryBandView {
  return { unknown: true, source: 'soft', lowConf: true };
}

/**
 * MasteryProjection or same-shaped wire row → band view. Pure; never writes back.
 * Real lo/hi bands are used when present; missing or non-finite bounds fall back to
 * the point band. Inverted bounds are ordered so the UI never shows a backwards range.
 */
export function masteryBandView(input: MasteryBandInput): MasteryBandView {
  if (input.mastery == null || !Number.isFinite(input.mastery)) return masteryBandUnknown();
  const band = masteryBandIdx(input.mastery);
  const rawLoBand =
    input.mastery_lo == null || !Number.isFinite(input.mastery_lo)
      ? band
      : masteryBandIdx(input.mastery_lo);
  const rawHiBand =
    input.mastery_hi == null || !Number.isFinite(input.mastery_hi)
      ? band
      : masteryBandIdx(input.mastery_hi);
  // Never render a backwards label such as 精熟–成长; order the qualitative endpoints.
  const loBand = rawLoBand <= rawHiBand ? rawLoBand : rawHiBand;
  const hiBand = rawLoBand <= rawHiBand ? rawHiBand : rawLoBand;
  const source: MasterySource = input.evidence_count > 0 ? 'hard' : 'soft';
  return { unknown: false, band, loBand, hiBand, source, lowConf: input.low_confidence };
}
