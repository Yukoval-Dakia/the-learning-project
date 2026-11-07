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

/** 512 intervals across the view, plus adaptive bisection (depth <= 6). */
const SAMPLE_INTERVALS = 512;
const ADAPTIVE_DEPTH = 6;
const ADAPTIVE_Y_FRACTION = 0.04;
const BREAK_Y_FRACTION = 0.5;
/** Bounds a single pathological expression during a drag. */
const MAX_EVALUATIONS_PER_ITEM = 4_096;
const MAX_TICKS = 200;
const MAX_PARAM_STEPS = 1_000;
const MAX_ISSUES = 12;
const RESERVED_PARAM_NAMES = new Set(['x', 'y', 't', 'e', 'pi']);
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

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const scaled = value * factor;
  if (!Number.isFinite(scaled)) return value;
  const rounded = Math.round(scaled) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundCoordinate(value: number): number {
  return roundTo(value, 2);
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
    resolved[param.name] = roundTo(value, 9);
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
  for (let decimals = 0; decimals <= 6; decimals += 1) {
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) <= 1e-9 * Math.max(1, Math.abs(scaled))) {
      return decimals;
    }
  }
  return 6;
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

function makeTicks(
  min: number,
  max: number,
  stepOverride: number | undefined,
  piTicks: boolean,
): PlotTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [];
  const ticks: PlotTick[] = [];
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
    if (end - start + 1 > MAX_TICKS) return [];
    for (let index = start; index <= end; index += 1) {
      ticks.push({
        value: roundTo(index * step, 12),
        label: formatPiTick(index * multiplier),
      });
    }
    return ticks;
  }
  const step = stepOverride ?? niceStep(max - min);
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const start = Math.ceil(min / step - 1e-9);
  const end = Math.floor(max / step + 1e-9);
  if (end - start + 1 > MAX_TICKS) return [];
  for (let index = start; index <= end; index += 1) {
    const value = index * step;
    ticks.push({ value: roundTo(value, 12), label: formatTickValue(value, step) });
  }
  return ticks;
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

type CurvePoint = { readonly x: number; readonly y: number; readonly index: number };

/**
 * Sample one expression into drawable segments. A segment ends at a non-finite
 * value, a pole, or an oscillatory jump; the next finite sample starts a new
 * segment, so no line is ever drawn across an asymptote.
 */
function sampleCurve(
  ast: ExprNode,
  xRange: readonly [number, number],
  yRange: readonly [number, number],
  params: Readonly<Record<string, number>>,
): PlotCurveSegment[] {
  const spanY = yRange[1] - yRange[0];
  const adaptiveThreshold = spanY * ADAPTIVE_Y_FRACTION;
  const breakThreshold = spanY * BREAK_Y_FRACTION;
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

  const segments: PlotCurveSegment[] = [];
  let current: Array<readonly [number, number]> | null = null;
  const finish = (): void => {
    if (current !== null && current.length >= 2) segments.push(current);
    current = null;
  };
  const push = (x: number, y: number): void => {
    const point: readonly [number, number] = [roundCoordinate(x), roundCoordinate(y)];
    if (current === null) {
      current = [point];
      return;
    }
    const last = current[current.length - 1];
    if (last[0] !== point[0] || last[1] !== point[1]) current.push(point);
  };

  const refine = (left: CurvePoint, right: CurvePoint, depth: number): boolean => {
    if (evaluations >= MAX_EVALUATIONS_PER_ITEM) return true;
    const middleX = (left.x + right.x) / 2;
    const middleY = evalAt(middleX);
    if (!Number.isFinite(middleY)) return false;
    const leftGap = Math.abs(middleY - left.y);
    const rightGap = Math.abs(right.y - middleY);
    const middle: CurvePoint = { x: middleX, y: middleY, index: left.index };
    // A value far outside both endpoints is a pole the fixed grid skipped.
    const outside =
      middleY > Math.max(left.y, right.y) + spanY || middleY < Math.min(left.y, right.y) - spanY;
    if (outside && Math.abs(middleY) > Math.abs(left.y) && Math.abs(middleY) > Math.abs(right.y)) {
      return false;
    }
    if (
      depth >= ADAPTIVE_DEPTH ||
      (leftGap <= adaptiveThreshold && rightGap <= adaptiveThreshold)
    ) {
      push(middleX, middleY);
      return true;
    }
    if (!refine(left, middle, depth + 1)) return false;
    push(middleX, middleY);
    return refine(middle, right, depth + 1);
  };

  const connect = (left: CurvePoint, right: CurvePoint): boolean => {
    const gap = Math.abs(right.y - left.y);
    if (gap > breakThreshold) {
      const opposite = Math.sign(left.y) !== Math.sign(right.y);
      if (opposite && Math.abs(left.y) > spanY && Math.abs(right.y) > spanY) return false;
      // A high-frequency turn just past the sampling grid: break rather than
      // draw a vertical connector through it.
      const previous = left.index >= 1 ? ys[left.index - 1] : Number.NaN;
      const next = right.index + 1 <= SAMPLE_INTERVALS ? ys[right.index + 1] : Number.NaN;
      if (Number.isFinite(previous) && Number.isFinite(next)) {
        const before = left.y - previous;
        const after = next - right.y;
        if (before * after < 0) return false;
      }
    }
    if (gap > adaptiveThreshold && !refine(left, right, 0)) return false;
    push(right.x, right.y);
    return true;
  };

  let previous: CurvePoint | null = null;
  for (let index = 0; index <= SAMPLE_INTERVALS; index += 1) {
    const y = ys[index];
    if (!Number.isFinite(y)) {
      finish();
      previous = null;
      continue;
    }
    const point: CurvePoint = { x: xs[index], y, index };
    if (previous === null) {
      finish();
      push(point.x, point.y);
    } else if (connect(previous, point)) {
      // connect pushed the point (and any refined interior points).
    } else {
      finish();
      push(point.x, point.y);
    }
    previous = point;
  }
  finish();
  return segments;
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
  const low = roundCoordinate(min - padding);
  const high = roundCoordinate(max + padding);
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
  const epsilon = Math.max(1e-9, (yRange[1] - yRange[0]) * 1e-9);
  const variables: Record<string, number> = { ...params, x: 0 };
  for (const ast of asts) {
    if (ast === null) continue;
    for (let index = 0; index <= SAMPLE_INTERVALS; index += 1) {
      variables.x = sampleX(xRange, index);
      const value = evaluateExpression(ast, variables);
      if (Number.isFinite(value) && value >= yRange[0] - epsilon && value <= yRange[1] + epsilon) {
        return true;
      }
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
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || !(x1 > x0)) {
    issues.push(issue('plot_view_invalid', '/view/x', 'x range must be finite and increasing'));
  }
  const y = input.view.y;
  if (y !== undefined && y !== 'auto') {
    if (!Number.isFinite(y[0]) || !Number.isFinite(y[1]) || !(y[1] > y[0])) {
      issues.push(issue('plot_view_invalid', '/view/y', 'y range must be finite and increasing'));
    }
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
    ['/title', input.title],
    ['/caption', input.caption],
    ['/axes/x_label', input.axes?.x_label],
    ['/axes/y_label', input.axes?.y_label],
    ...input.items.map((item, index) => [`/items/${index}/label`, item.label] as const),
  ];
  for (const [path, text] of entries) {
    if (text !== undefined && /[0-9]/.test(text)) {
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
    if (auto.ok) {
      resolvedY = auto.range;
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
          'every sampled point lies outside the explicit y range; widen view.y or fix the expression',
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
  const validView =
    Number.isFinite(x0) &&
    Number.isFinite(x1) &&
    x1 > x0 &&
    Number.isFinite(y0) &&
    Number.isFinite(y1) &&
    y1 > y0;
  if (!validView) {
    issues.push(issue('plot_view_invalid', '/view', 'view ranges must be finite and increasing'));
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
      return Number.isFinite(value) ? roundTo(value, 4) : null;
    });
    rows.push({ x: tick.value, x_label: tick.label, y });
  }
  return rows;
}
