// Deterministic function-plot scene for `plot` blocks.
//
// Pure: no DOM, no IO, no clock. The server calls compilePlotBlock once to
// validate the model's spec and to resolve `view.y: "auto"`; the browser calls
// computeScene on every slider movement. Both use the same in-house expression
// evaluator, so the same block plus the same parameter values always produce
// the same primitives.

import type { PlotBlockInputT, PlotBlockT, PlotParamT } from '../../schema/blocks/block';
import type { BlockIssueT } from '../../schema/blocks/issues';
import type { BlockSurface } from '../../schema/blocks/surfaces';
import { type ExprNode, evaluateExpression, parseExpression } from '../expr';

/** Base grid across the whole x viewport; continuity verdicts bisect on top. */
const SAMPLE_INTERVALS = 512;
/** Balanced interior scan per visible interval; catches narrow poles between samples. */
const SCAN_LEVELS = 3;
/** Guaranteed per-interval scan budget — 7 dyadic points used, headroom for duplicates. */
const SCAN_EVALUATIONS = 16;
/** A scan accepts continuity when the largest sub-gap shrank to this fraction of the interval gap. */
const SCAN_CONVERGENCE = 0.5;
/** Bisection chain levels per suspicious interval; a jump's cling streak fires well below this. */
const MAX_CHAIN_LEVELS = 26;
/** A midpoint within this fraction of the gap from one endpoint holds that endpoint's level. */
const CLING_FRACTION = 0.02;
/** Consecutive clinging midpoints that declare a jump; atan(1000*x) clings ~9 levels before turning interior. */
const JUMP_CLING_LEVELS = 14;
/** An ordinary lineage still wandering after this many levels is bounded oscillation, not a break. */
const WANDER_LEVELS = 6;
/** Chain gaps shrinking to this fraction twice in a row accept continuity. */
const CHAIN_CONVERGENCE = 0.75;
/** A midpoint magnitude must exceed both current ends by this factor for a divergence tick. */
const DIVERGENCE_FACTOR = 1.8;
/** Bounds one pathological interval (scan + all its suspect-pair chains). */
const MAX_EVALUATIONS_PER_INTERVAL = 128;
/**
 * Shared refinement pool per item: covers a fully-oscillatory curve's chains
 * (~33k measured) with margin; scans have their own guaranteed per-interval
 * budget on top.
 */
const MAX_EVALUATIONS_PER_ITEM = 64_000;
const MAX_TICKS = 200;
const MAX_PARAM_STEPS = 1_000;
const MAX_ISSUES = 12;
const RESERVED_PARAM_NAMES = new Set(['x', 'y', 't', 'e', 'pi']);
const DECIMAL_DIGIT_RE = /\p{Nd}/u;
const NICE_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;
const PI_MULTIPLIERS = [1, 2, 4, 5, 10] as const;

export type PlotParamValues = Readonly<Record<string, number>>;

export type PlotTick = { readonly value: number; readonly label: string };

export type PlotCurveSegment = ReadonlyArray<readonly [number, number]>;

export type PlotCurve = {
  readonly type: 'curve';
  readonly index: number;
  readonly segments: ReadonlyArray<PlotCurveSegment>;
  readonly color: number;
  readonly dashed: boolean;
  readonly label?: string;
};

export type PlotScene = {
  readonly view: {
    readonly x: readonly [number, number];
    readonly y: readonly [number, number];
    readonly equal_aspect: boolean;
  };
  readonly title?: string;
  readonly x_label?: string;
  readonly y_label?: string;
  readonly grid: boolean;
  readonly ticks: { readonly x: ReadonlyArray<PlotTick>; readonly y: ReadonlyArray<PlotTick> };
  /** Data coordinates of the axis lines; they sit on 0 when 0 is visible, else on the near edge. */
  readonly axis_lines: { readonly x_axis_y: number; readonly y_axis_x: number };
  readonly curves: ReadonlyArray<PlotCurve>;
  readonly issues: ReadonlyArray<BlockIssueT>;
};

export type PlotTableRow = {
  readonly x: number;
  readonly x_label: string;
  /** One value per item, in item order; null when the expression is undefined there. */
  readonly y: ReadonlyArray<number | null>;
};

export type PlotCompileResult =
  | { readonly ok: true; readonly block: PlotBlockT }
  | { readonly ok: false; readonly issues: ReadonlyArray<BlockIssueT> };

function issue(
  code: BlockIssueT['code'],
  path: string,
  detail: string,
  extra?: { readonly column?: number; readonly expected?: readonly string[] },
): BlockIssueT {
  return {
    code,
    path,
    detail,
    ...(extra?.column !== undefined ? { column: extra.column } : {}),
    ...(extra?.expected !== undefined ? { expected: extra.expected.slice(0, 12) } : {}),
  };
}

/**
 * Snap binary noise (0.1 + 0.2) to 15 significant digits. Fixed-decimal
 * rounding collapses small magnitudes to 0 and overflows at large ones, so
 * significance, not decimals, is the right scale for params and ticks alike.
 */
function snapValue(value: number): number {
  if (!Number.isFinite(value)) return value;
  const snapped = Number(value.toPrecision(15));
  return Object.is(snapped, -0) ? 0 : snapped;
}

/** A view must be resolvable at its own magnitude: mid must differ from both ends. */
function isSpanRepresentable(start: number, end: number): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return false;
  const middle = start + (end - start) / 2;
  return middle > start && middle < end;
}

function sampleX(range: readonly [number, number], index: number): number {
  const [start, end] = range;
  return index === SAMPLE_INTERVALS ? end : start + ((end - start) * index) / SAMPLE_INTERVALS;
}

/**
 * Clamp a slider value to its declared range and snap it to `step`. Missing or
 * non-finite values fall back to the declared default so a partial client state
 * still renders the block the record describes.
 */
export function resolveParamValues(
  params: readonly PlotParamT[],
  values: PlotParamValues = {},
): Record<string, number> {
  const resolved: Record<string, number> = {};
  for (const param of params) {
    const requested = values[param.name];
    let value = Number.isFinite(requested) ? requested : param.value;
    if (!Number.isFinite(value)) value = param.value;
    value = Math.min(param.max, Math.max(param.min, value));
    if (param.step !== undefined && param.step > 0) {
      value = param.min + Math.round((value - param.min) / param.step) * param.step;
      value = Math.min(param.max, Math.max(param.min, value));
    }
    resolved[param.name] = snapValue(value);
  }
  return resolved;
}

function niceStep(span: number): number {
  const raw = span / 6;
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  for (const multiplier of NICE_MULTIPLIERS) {
    const candidate = multiplier * base;
    if (candidate >= raw) return candidate;
  }
  return 10 * base;
}

function decimalsForStep(step: number): number {
  // Decimals needed to write one step at its own magnitude: the exponent of
  // its leading digit plus its mantissa decimals. A fixed cap rounds small
  // steps (5e-9) to zero — the label must stay at the step's scale.
  const [mantissa, exponentText] = step.toExponential().split('e');
  const mantissaDecimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
  // toFixed accepts at most 100 decimals; denormal steps clamp there.
  return Math.min(100, Math.max(0, mantissaDecimals - Number(exponentText)));
}

function formatTickValue(value: number, step: number): string {
  const decimals = decimalsForStep(step);
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0 || Object.is(rounded, -0)) return '0';
  const magnitude = Math.abs(rounded);
  const text =
    magnitude >= 1e6 || magnitude < 1e-4
      ? rounded.toExponential(2).replace('e+', 'e')
      : String(rounded);
  return text.replace('-', '−');
}

/** `halfPiMultiples` counts how many π/2 make the value. */
function formatPiTick(halfPiMultiples: number): string {
  if (halfPiMultiples === 0) return '0';
  const sign = halfPiMultiples < 0 ? '−' : '';
  const magnitude = Math.abs(halfPiMultiples);
  if (magnitude % 2 === 0) {
    const whole = magnitude / 2;
    return whole === 1 ? `${sign}π` : `${sign}${whole}π`;
  }
  return magnitude === 1 ? `${sign}π/2` : `${sign}${magnitude}π/2`;
}

function buildTicks(start: number, end: number, make: (index: number) => PlotTick): PlotTick[] {
  // The offset loop is zero-based and bounded; index + 1 can equal index at
  // large magnitudes, which would make a "for (index = start; index <= end)"
  // loop spin forever. Safe-integer indices are the admission condition.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return [];
  const count = end - start + 1;
  if (!(count > 0) || count > MAX_TICKS) return [];
  const ticks: PlotTick[] = [];
  let previous: number | null = null;
  for (let offset = 0; offset < count; offset += 1) {
    const index = start + offset;
    if (!Number.isSafeInteger(index)) return [];
    const tick = make(index);
    if (!Number.isFinite(tick.value)) return [];
    // Reject a tick that cannot advance; drawing the same coordinate twice is
    // never meaningful and would also hide the overflow above.
    if (previous !== null && !(tick.value > previous)) return [];
    previous = tick.value;
    ticks.push(tick);
  }
  return ticks;
}

function makeTicks(
  min: number,
  max: number,
  stepOverride: number | undefined,
  piTicks: boolean,
): PlotTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [];
  if (piTicks && stepOverride === undefined) {
    const halfPi = Math.PI / 2;
    const raw = (max - min) / 6 / halfPi;
    let multiplier = 10;
    for (const candidate of PI_MULTIPLIERS) {
      if (candidate >= raw) {
        multiplier = candidate;
        break;
      }
    }
    const step = halfPi * multiplier;
    const start = Math.ceil(min / step - 1e-9);
    const end = Math.floor(max / step + 1e-9);
    return buildTicks(start, end, (index) => ({
      value: snapValue(index * step),
      label: formatPiTick(index * multiplier),
    }));
  }
  const step = stepOverride ?? niceStep(max - min);
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const start = Math.ceil(min / step - 1e-9);
  const end = Math.floor(max / step + 1e-9);
  return buildTicks(start, end, (index) => ({
    value: snapValue(index * step),
    label: formatTickValue(index * step, step),
  }));
}

function parseItems(block: PlotBlockT): {
  readonly asts: ReadonlyArray<ExprNode | null>;
  readonly issues: BlockIssueT[];
} {
  const allowed = new Set<string>(['x', ...(block.params ?? []).map((param) => param.name)]);
  const issues: BlockIssueT[] = [];
  const asts = block.items.map((item, index) => {
    const parsed = parseExpression(item.expr, allowed);
    if (parsed.ok) return parsed.ast;
    issues.push({
      code: parsed.issue.code,
      path: `/items/${index}/expr`,
      detail: parsed.issue.detail,
      column: parsed.issue.column,
      ...(parsed.issue.expected ? { expected: parsed.issue.expected.slice(0, 12) } : {}),
    });
    return null;
  });
  return { asts, issues };
}

/** Verdict for one base interval: connect or break, plus interior sample points. */
type IntervalVerdict = {
  readonly continuous: boolean;
  readonly points: ReadonlyArray<readonly [number, number]>;
};

/**
 * Sample one expression into drawable segments.
 *
 * The base grid always covers the whole x viewport. Every visible base
 * interval then gets a guaranteed interior scan (its own fixed budget, never
 * starved by earlier intervals), and every sub-gap that did not converge is
 * verified by its own bisection chain out of the shared pool: a continuous
 * curve's |Δy| shrinks as the interval halves, a jump keeps one endpoint
 * level on every midpoint (floor stays Δ=1 at any depth), and a pole drives
 * |y| past both ends and keeps going. Offscreen chords cost no evaluations;
 * an interval whose verification is interrupted by the pool breaks rather
 * than connecting unverified.
 */
function sampleCurve(
  ast: ExprNode,
  xRange: readonly [number, number],
  yRange: readonly [number, number],
  params: Readonly<Record<string, number>>,
): PlotCurveSegment[] {
  const variables: Record<string, number> = { ...params, x: 0 };
  let evaluations = 0;
  const evalAt = (x: number): number => {
    evaluations += 1;
    variables.x = x;
    return evaluateExpression(ast, variables);
  };

  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index <= SAMPLE_INTERVALS; index += 1) {
    const x = sampleX(xRange, index);
    xs.push(x);
    ys.push(evalAt(x));
  }

  const connected: IntervalVerdict = { continuous: true, points: [] };
  const verdicts: IntervalVerdict[] = [];
  for (let index = 0; index < SAMPLE_INTERVALS; index += 1) {
    const fa = ys[index];
    const fb = ys[index + 1];
    if (!Number.isFinite(fa) || !Number.isFinite(fb)) {
      verdicts.push(connected);
      continue;
    }
    // Offscreen chords draw nothing inside the viewport either way; they cost
    // no evaluations so they can never starve visible intervals.
    if (Math.min(fa, fb) > yRange[1] || Math.max(fa, fb) < yRange[0]) {
      verdicts.push(connected);
      continue;
    }
    verdicts.push(classifyInterval(xs[index], fa, xs[index + 1], fb));
  }

  function classifyInterval(a: number, fa: number, b: number, fb: number): IntervalVerdict {
    let spent = 0;
    // The scan is the fixed per-interval check: every visible base interval
    // always gets it, no matter what earlier intervals already spent. Only
    // its own small cap bounds it.
    const canScan = (): boolean => spent < SCAN_EVALUATIONS;
    // Refinement chains share the item pool; a pair that cannot be chained
    // stays unverified, and unverified intervals never connect.
    const canEvaluate = (): boolean =>
      evaluations < MAX_EVALUATIONS_PER_ITEM && spent < MAX_EVALUATIONS_PER_INTERVAL;

    // Phase 1 — balanced interior scan: one value at every dyadic point down
    // to SCAN_LEVELS. This catches narrow poles the base grid straddles (equal
    // or moderate endpoints with a spike between them) and undefined points
    // inside the interval.
    const endMax = Math.max(Math.abs(fa), Math.abs(fb));
    const scanned: Array<[number, number]> = [];
    for (let level = 1; level <= SCAN_LEVELS; level += 1) {
      const step = 2 ** level;
      for (let k = 1; k < step; k += 2) {
        const x = a + ((b - a) * k) / step;
        if (x === a || x === b) continue;
        const previous = scanned[scanned.length - 1];
        if (previous !== undefined && x === previous[0]) continue;
        if (!canScan()) return { continuous: false, points: [] };
        const y = evalAt(x);
        spent += 1;
        if (!Number.isFinite(y)) return { continuous: false, points: [] };
        scanned.push([x, y]);
      }
    }

    // Phase 2 — every sub-gap that did not converge is verified by its own
    // bisection chain: a pole always makes ITS OWN pair the outlier, so
    // chaining only the widest pair can miss it entirely (1/(x-0.3)^2 over
    // [-1000,1000] hid behind a steeper neighbour pair). x-sorted — scan
    // pushes dyadic points in evaluation order, which is not x order.
    const grid: ReadonlyArray<readonly [number, number]> = [
      [a, fa],
      ...[...scanned].sort((p, q) => p[0] - q[0]),
      [b, fb],
    ];
    const intervalGap = Math.abs(fb - fa);
    const noise = floatNoise(endMax);
    // Values already seen inside this interval; a lineage whose ends stay
    // bounded at this scale is wandering (oscillation), not diverging.
    let wanderBound = endMax;
    const suspects: number[] = [];
    for (let index = 0; index + 1 < grid.length; index += 1) {
      const gap = Math.abs(grid[index + 1][1] - grid[index][1]);
      if (gap > SCAN_CONVERGENCE * intervalGap && gap > noise) suspects.push(index);
      wanderBound = Math.max(wanderBound, Math.abs(grid[index][1]), Math.abs(grid[index + 1][1]));
    }
    wanderBound *= DIVERGENCE_FACTOR;
    if (suspects.length === 0) return { continuous: true, points: scanned };
    // Widest first: spend the shared pool on the pairs most likely to break.
    suspects.sort(
      (p, q) => Math.abs(grid[q + 1][1] - grid[q][1]) - Math.abs(grid[p + 1][1] - grid[p][1]),
    );
    const points: Array<[number, number]> = [...scanned];
    // One lineage per suspicious pair; a midpoint outside both ends marks the
    // lineage as pole-suspect, and suspect lineages must verify BOTH children
    // — the pole can sit past a dip on either side of an outlier and behind a
    // smaller-gap child (1/(x-0.3)^2 over [-1000,1000] hides exactly there).
    type Lineage = {
      a: number;
      fa: number;
      b: number;
      fb: number;
      depth: number;
      cling: number;
      div: number;
      prevGap: number;
      shrink: number;
      /** 0 = ordinary; >0 = pole-suspect until both ends fall back below it. */
      release: number;
    };
    const stack: Lineage[] = [];
    for (const index of [...suspects].reverse()) {
      stack.push({
        a: grid[index][0],
        fa: grid[index][1],
        b: grid[index + 1][0],
        fb: grid[index + 1][1],
        depth: 0,
        cling: 0,
        div: 0,
        prevGap: intervalGap,
        shrink: 0,
        release: 0,
      });
    }
    while (stack.length > 0) {
      const s = stack.pop() as Lineage;
      // Depth exhausted: a still-suspect lineage never verified, so break;
      // ordinary wandering (oscillation) is not evidence of a break.
      if (s.depth >= MAX_CHAIN_LEVELS) {
        if (s.release > 0 && Math.max(Math.abs(s.fa), Math.abs(s.fb)) > s.release) {
          return { continuous: false, points: [] };
        }
        continue;
      }
      const gap = Math.abs(s.fb - s.fa);
      const endMax = Math.max(Math.abs(s.fa), Math.abs(s.fb));
      const noise = floatNoise(endMax);
      if (gap <= noise) continue;
      const shrink = gap <= CHAIN_CONVERGENCE * s.prevGap ? s.shrink + 1 : 0;
      if (shrink >= 2) continue;
      // Bounded interior wandering — never clings to an endpoint, stays
      // within magnitudes the scan already saw, never left the band — is
      // oscillation, not a break (sin(10000*x) would otherwise burn the
      // whole per-interval cap wandering to MAX_CHAIN_LEVELS).
      if (s.depth >= WANDER_LEVELS && s.cling === 0 && s.release === 0 && endMax <= wanderBound) {
        continue;
      }
      const middle = (s.a + s.b) / 2;
      if (middle === s.a || middle === s.b) {
        // x is at float resolution: a persistent gap can only be a jump.
        return { continuous: false, points: [] };
      }
      if (!canEvaluate()) {
        // The pool ran out mid-verification: unconfirmed, so break.
        return { continuous: false, points: [] };
      }
      const middleY = evalAt(middle);
      spent += 1;
      if (!Number.isFinite(middleY)) return { continuous: false, points: [] };
      // A spike above both ends is only a suspect, never a verdict: a finite
      // narrow bump (exp(-k*(x-c)^2)) also overshoots once, then its children
      // fall back below the release level and the lineage clears. Divergence
      // means overshooting BOTH current ends, not just leaning toward the
      // bigger one: x^9's bisection towards its steep end keeps raising mid
      // |y| toward the endpoint value without ever passing it, while a pole
      // keeps the midpoint past both ends level after level.
      const div = Math.abs(middleY) >= DIVERGENCE_FACTOR * endMax ? s.div + 1 : 0;
      if (div >= 2) return { continuous: false, points: [] };
      points.push([middle, middleY]);
      const low = Math.min(s.fa, s.fb);
      const high = Math.max(s.fa, s.fb);
      const band = CLING_FRACTION * gap;
      const leftGap = Math.abs(middleY - s.fa);
      const rightGap = Math.abs(s.fb - middleY);
      const inside = middleY >= low - band && middleY <= high + band;
      const depth = s.depth + 1;
      if (!inside) {
        // Outside both endpoint levels: a pole candidate (same-side poles
        // like 1/(x-a)^2 grow inward) or a local extremum. The pole can hide
        // past a dip on either side of the outlier, so both children stay
        // suspect until their ends fall below the release level — a bounded
        // bump's children clear it immediately; a pole's neighbours do not.
        const release = Math.max(s.release, DIVERGENCE_FACTOR * endMax);
        stack.push({
          a: s.a,
          fa: s.fa,
          b: middle,
          fb: middleY,
          depth,
          cling: 0,
          div,
          prevGap: gap,
          shrink: 0,
          release,
        });
        stack.push({
          a: middle,
          fa: middleY,
          b: s.b,
          fb: s.fb,
          depth,
          cling: 0,
          div,
          prevGap: gap,
          shrink: 0,
          release,
        });
        continue;
      }
      const nearLeft = leftGap <= band;
      const nearRight = rightGap <= band;
      // The midpoint holds one endpoint's level: a jump keeps doing this
      // at every depth, while a steep continuous curve starts producing
      // interior values once the bisection reaches its transition width.
      const cling = nearLeft !== nearRight ? s.cling + 1 : 0;
      if (cling >= JUMP_CLING_LEVELS) return { continuous: false, points: [] };
      // A suspect lineage clears once its ends are back below the release
      // level — the outlier was a bounded bump, not a pole.
      const suspect = s.release > 0 && endMax > s.release;
      if (suspect) {
        stack.push({
          a: s.a,
          fa: s.fa,
          b: middle,
          fb: middleY,
          depth,
          cling: 0,
          div,
          prevGap: gap,
          shrink,
          release: s.release,
        });
        stack.push({
          a: middle,
          fa: middleY,
          b: s.b,
          fb: s.fb,
          depth,
          cling: 0,
          div,
          prevGap: gap,
          shrink,
          release: s.release,
        });
      } else if (leftGap >= rightGap) {
        // Pursue the child keeping the larger sub-gap — inside the band a
        // single line of suspicion is enough (oscillation stays cheap).
        stack.push({
          a: s.a,
          fa: s.fa,
          b: middle,
          fb: middleY,
          depth,
          cling,
          div: 0,
          prevGap: gap,
          shrink,
          release: 0,
        });
      } else {
        stack.push({
          a: middle,
          fa: middleY,
          b: s.b,
          fb: s.fb,
          depth,
          cling,
          div: 0,
          prevGap: gap,
          shrink,
          release: 0,
        });
      }
    }
    return { continuous: true, points };
  }

  const segments: PlotCurveSegment[] = [];
  let current: Array<readonly [number, number]> | null = null;
  const finish = (): void => {
    if (current !== null && current.length >= 2) segments.push(current);
    current = null;
  };
  const push = (x: number, y: number): void => {
    const point: readonly [number, number] = [x, y];
    if (current === null) {
      current = [point];
      return;
    }
    const last = current[current.length - 1];
    if (last[0] !== point[0] || last[1] !== point[1]) current.push(point);
  };
  const lastX = (): number =>
    current === null ? Number.NEGATIVE_INFINITY : current[current.length - 1][0];

  for (let index = 0; index <= SAMPLE_INTERVALS; index += 1) {
    const y = ys[index];
    if (!Number.isFinite(y)) {
      finish();
      continue;
    }
    if (index === 0) {
      push(xs[index], y);
      continue;
    }
    const verdict = verdicts[index - 1];
    if (verdict.continuous) {
      for (const point of [...verdict.points].sort((p, q) => p[0] - q[0])) {
        if (point[0] <= lastX()) continue;
        push(point[0], point[1]);
      }
      push(xs[index], y);
    } else {
      finish();
      push(xs[index], y);
    }
  }
  finish();
  return segments;
}

/** 8 ulps of the given magnitude: gaps below this are float noise. */
function floatNoise(magnitude: number): number {
  if (!(magnitude > 0)) return 8 * Number.MIN_VALUE;
  const exponent = Math.ceil(Math.log2(magnitude));
  return 8 * 2 ** exponent * Number.EPSILON;
}
type AutoYResult =
  | { readonly ok: true; readonly range: [number, number] }
  | { readonly ok: false; readonly reason: 'empty' | 'unbounded' };

/** `auto` is resolved once, from the declared default parameter values only. */
function autoYRange(
  xRange: readonly [number, number],
  asts: ReadonlyArray<ExprNode | null>,
  params: Readonly<Record<string, number>>,
): AutoYResult {
  const values: number[] = [];
  const variables: Record<string, number> = { ...params, x: 0 };
  for (const ast of asts) {
    if (ast === null) continue;
    for (let index = 0; index <= SAMPLE_INTERVALS; index += 1) {
      variables.x = sampleX(xRange, index);
      const value = evaluateExpression(ast, variables);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (values.length === 0) return { ok: false, reason: 'empty' };
  values.sort((a, b) => a - b);
  const quantile = (q: number): number =>
    values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
  let min = quantile(0.02);
  let max = quantile(0.98);
  if (!(max > min)) {
    min -= 0.5;
    max += 0.5;
  }
  const padding = (max - min) * 0.05;
  const low = min - padding;
  const high = max + padding;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) {
    return { ok: false, reason: 'unbounded' };
  }
  return { ok: true, range: [low, high] };
}

function hasVisiblePoint(
  asts: ReadonlyArray<ExprNode | null>,
  params: Readonly<Record<string, number>>,
  xRange: readonly [number, number],
  yRange: readonly [number, number],
): boolean {
  // Check adjacent samples for a viewport crossing, not only samples that land
  // inside the y range: 1000*x over x[-512,512], y[100,200] crosses between
  // grid points. A jump may be a false positive here; withholding a valid
  // figure is worse than showing one whose clamped view is empty.
  const variables: Record<string, number> = { ...params, x: 0 };
  for (const ast of asts) {
    if (ast === null) continue;
    let previous: number | null = null;
    for (let index = 0; index <= SAMPLE_INTERVALS; index += 1) {
      variables.x = sampleX(xRange, index);
      const value = evaluateExpression(ast, variables);
      if (!Number.isFinite(value)) {
        previous = null;
        continue;
      }
      if (value >= yRange[0] && value <= yRange[1]) return true;
      if (previous !== null) {
        if (Math.min(previous, value) <= yRange[1] && Math.max(previous, value) >= yRange[0]) {
          return true;
        }
      }
      previous = value;
    }
  }
  return false;
}

function parameterIssues(params: readonly PlotParamT[]): BlockIssueT[] {
  const issues: BlockIssueT[] = [];
  const seen = new Set<string>();
  for (const [index, param] of params.entries()) {
    const path = `/params/${index}`;
    if (RESERVED_PARAM_NAMES.has(param.name)) {
      issues.push(
        issue(
          'plot_param_invalid',
          `${path}/name`,
          `'${param.name}' is reserved; use a name that is not x, y, t, e or pi`,
        ),
      );
    }
    if (seen.has(param.name)) {
      issues.push(
        issue('plot_param_invalid', `${path}/name`, `duplicate parameter name '${param.name}'`),
      );
    }
    seen.add(param.name);
    if (!Number.isFinite(param.min) || !Number.isFinite(param.max) || !(param.max > param.min)) {
      issues.push(
        issue('plot_param_invalid', path, 'min and max must be finite and min must be below max'),
      );
      continue;
    }
    if (!Number.isFinite(param.value) || param.value < param.min || param.value > param.max) {
      issues.push(issue('plot_param_invalid', `${path}/value`, 'value must lie within [min, max]'));
    }
    if (param.step !== undefined) {
      if (!Number.isFinite(param.step) || !(param.step > 0)) {
        issues.push(issue('plot_param_invalid', `${path}/step`, 'step must be a positive number'));
      } else if ((param.max - param.min) / param.step > MAX_PARAM_STEPS) {
        issues.push(
          issue(
            'plot_param_invalid',
            `${path}/step`,
            `step is too small: at most ${MAX_PARAM_STEPS} steps are allowed between min and max`,
          ),
        );
      }
    }
  }
  return issues;
}

function viewIssues(input: PlotBlockInputT): BlockIssueT[] {
  const issues: BlockIssueT[] = [];
  const [x0, x1] = input.view.x;
  if (!isSpanRepresentable(x0, x1)) {
    issues.push(
      issue(
        'plot_view_invalid',
        '/view/x',
        'x range must be finite, increasing, and resolvable at its magnitude',
      ),
    );
  }
  const y = input.view.y;
  if (y !== undefined && y !== 'auto' && !isSpanRepresentable(y[0], y[1])) {
    issues.push(
      issue(
        'plot_view_invalid',
        '/view/y',
        'y range must be finite, increasing, and resolvable at its magnitude',
      ),
    );
  }
  const tickSteps = input.axes?.ticks;
  if (tickSteps !== undefined) {
    const spans: Array<readonly [string, number | null]> = [
      ['x', Number.isFinite(x0) && Number.isFinite(x1) ? x1 - x0 : null],
      ['y', y !== undefined && y !== 'auto' ? y[1] - y[0] : null],
    ];
    for (const [axis, span] of spans) {
      const step = axis === 'x' ? tickSteps.x : tickSteps.y;
      if (span !== null && span > 0 && span / step > MAX_TICKS) {
        issues.push(
          issue(
            'plot_view_invalid',
            `/axes/ticks/${axis}`,
            `tick step is too small for the view; at most ${MAX_TICKS} ticks are allowed`,
          ),
        );
      }
    }
  }
  return issues;
}

function labelIssues(input: PlotBlockInputT): BlockIssueT[] {
  const params = input.params ?? [];
  if (params.length === 0) return [];
  const issues: BlockIssueT[] = [];
  const entries: Array<readonly [string, string | undefined]> = [
    ['/alt', input.alt],
    ['/title', input.title],
    ['/caption', input.caption],
    ['/axes/x_label', input.axes?.x_label],
    ['/axes/y_label', input.axes?.y_label],
    ...input.items.map((item, index) => [`/items/${index}/label`, item.label] as const),
    ...params.map((param, index) => [`/params/${index}/label`, param.label] as const),
  ];
  for (const [path, text] of entries) {
    if (text !== undefined && DECIMAL_DIGIT_RE.test(text)) {
      issues.push(
        issue(
          'plot_label_hardcodes_value',
          path,
          'labels must not hardcode a number while params can move it; describe the shape instead',
        ),
      );
    }
  }
  return issues;
}

/**
 * Validate a model-facing plot and resolve `view.y: "auto"` into concrete
 * numbers. The stored block therefore has no remaining decisions: the UI draws
 * the same view for every slider position.
 */
export function compilePlotBlock(input: PlotBlockInputT, surface: BlockSurface): PlotCompileResult {
  const issues: BlockIssueT[] = [];
  const params = input.params ?? [];
  if (surface === 'question_material' && params.length > 0) {
    issues.push(
      issue(
        'kind_not_allowed_on_surface',
        '/params',
        'params are forbidden on question_material: a frozen question cannot have learner-adjusted values',
        { expected: ['remove params'] },
      ),
    );
  }
  issues.push(...parameterIssues(params));
  issues.push(...viewIssues(input));
  issues.push(...labelIssues(input));

  const allowed = new Set<string>(['x', ...params.map((param) => param.name)]);
  const asts: Array<ExprNode | null> = [];
  for (const [index, item] of input.items.entries()) {
    const parsed = parseExpression(item.expr, allowed);
    if (parsed.ok) {
      asts.push(parsed.ast);
    } else {
      asts.push(null);
      issues.push({
        code: parsed.issue.code,
        path: `/items/${index}/expr`,
        detail: parsed.issue.detail,
        column: parsed.issue.column,
        ...(parsed.issue.expected ? { expected: parsed.issue.expected.slice(0, 12) } : {}),
      });
    }
  }

  const explicitY = input.view.y !== undefined && input.view.y !== 'auto' ? input.view.y : null;
  let resolvedY: [number, number] | null = explicitY;
  if (issues.length === 0 && resolvedY === null) {
    const defaults = resolveParamValues(params);
    const auto = autoYRange(input.view.x, asts, defaults);
    if (auto.ok && isSpanRepresentable(auto.range[0], auto.range[1])) {
      resolvedY = auto.range;
    } else if (auto.ok) {
      issues.push(
        issue(
          'plot_view_invalid',
          '/view/y',
          'auto y range cannot be resolved at this magnitude; give view.y explicitly',
        ),
      );
    } else if (auto.reason === 'empty') {
      issues.push(
        issue(
          'plot_nothing_visible',
          '/items',
          'no expression has a finite value inside the x range; fix the expression or the x range',
        ),
      );
    } else {
      issues.push(
        issue('plot_view_invalid', '/view/y', 'auto y range is not finite; give view.y explicitly'),
      );
    }
  }
  if (issues.length === 0 && resolvedY !== null && explicitY !== null) {
    if (!hasVisiblePoint(asts, resolveParamValues(params), input.view.x, resolvedY)) {
      issues.push(
        issue(
          'plot_nothing_visible',
          '/view/y',
          'no segment crosses or enters the explicit y range; widen view.y or fix the expression',
        ),
      );
    }
  }
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };
  if (resolvedY === null) {
    return {
      ok: false,
      issues: [issue('plot_nothing_visible', '/items', 'the plot has no finite values to draw')],
    };
  }
  return {
    ok: true,
    block: {
      ...input,
      engine: 'tlp-scene@1',
      view: { ...input.view, y: resolvedY },
    },
  };
}

/**
 * Pure scene for a stored plot. `paramValues` is the client slider state; it is
 * never persisted, and a missing value falls back to the declared default.
 */
export function computeScene(block: PlotBlockT, paramValues: PlotParamValues = {}): PlotScene {
  const params = resolveParamValues(block.params ?? [], paramValues);
  const { asts, issues } = parseItems(block);
  const [x0, x1] = block.view.x;
  const [y0, y1] = block.view.y;
  const validView = isSpanRepresentable(x0, x1) && isSpanRepresentable(y0, y1);
  if (!validView) {
    issues.push(
      issue(
        'plot_view_invalid',
        '/view',
        'view ranges must be finite, increasing, and resolvable at their magnitude',
      ),
    );
  }

  const ticks = validView
    ? {
        x: makeTicks(x0, x1, block.axes?.ticks?.x, block.axes?.pi_ticks === true),
        y: makeTicks(y0, y1, block.axes?.ticks?.y, false),
      }
    : { x: [] as PlotTick[], y: [] as PlotTick[] };

  const curves: PlotCurve[] = [];
  if (validView) {
    for (const [index, item] of block.items.entries()) {
      const ast = asts[index];
      if (ast === null) continue;
      const segments = sampleCurve(ast, [x0, x1], [y0, y1], params);
      curves.push({
        type: 'curve',
        index,
        segments,
        color: item.color ?? index % 6,
        dashed: item.dashed ?? false,
        ...(item.label !== undefined ? { label: item.label } : {}),
      });
    }
  }

  const axisLines = validView
    ? {
        x_axis_y: y0 <= 0 && y1 >= 0 ? 0 : y0 > 0 ? y0 : y1,
        y_axis_x: x0 <= 0 && x1 >= 0 ? 0 : x0 > 0 ? x0 : x1,
      }
    : { x_axis_y: 0, y_axis_x: 0 };

  return {
    view: {
      x: [x0, x1],
      y: [y0, y1],
      equal_aspect: block.view.equal_aspect ?? false,
    },
    ...(block.title !== undefined ? { title: block.title } : {}),
    ...(block.axes?.x_label !== undefined ? { x_label: block.axes.x_label } : {}),
    ...(block.axes?.y_label !== undefined ? { y_label: block.axes.y_label } : {}),
    grid: block.axes?.grid ?? true,
    ticks,
    axis_lines: validView ? axisLines : { x_axis_y: 0, y_axis_x: 0 },
    curves,
    issues,
  };
}

/**
 * Deterministic table fallback: one row per x tick, one value per curve. An
 * undefined point is null (for example 1/x at x = 0). Useful for the readable
 * alternative when the drawing is unavailable.
 */
export function samplesForTable(
  block: PlotBlockT,
  paramValues: PlotParamValues = {},
  maxRows = 40,
): PlotTableRow[] {
  const params = resolveParamValues(block.params ?? [], paramValues);
  const allowed = new Set<string>(['x', ...(block.params ?? []).map((param) => param.name)]);
  const asts = block.items.map((item) => parseExpression(item.expr, allowed));
  const [x0, x1] = block.view.x;
  const ticks = makeTicks(x0, x1, block.axes?.ticks?.x, block.axes?.pi_ticks === true);
  const variables: Record<string, number> = { ...params, x: 0 };
  const rows: PlotTableRow[] = [];
  for (const tick of ticks) {
    if (rows.length >= maxRows) break;
    const y = asts.map((parsed) => {
      if (!parsed.ok) return null;
      variables.x = tick.value;
      const value = evaluateExpression(parsed.ast, variables);
      return Number.isFinite(value) ? snapValue(value) : null;
    });
    rows.push({ x: tick.value, x_label: tick.label, y });
  }
  return rows;
}
