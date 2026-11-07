// The arithmetic a chart needs: axis ticks, value and date wording, and fitting a label to a width.

import type { BlockV1T } from '@/core/schema/blocks';

export type ChartBlockT = Extract<BlockV1T, { kind: 'chart' }>;

/** A short figure for labels on the chart: small values keep their digits instead of reading 0. */
export function formatValue(value: number): string {
  if (value === 0) return '0';
  return value.toLocaleString(
    'zh-CN',
    Math.abs(value) < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 },
  );
}

/** The figure as given, for the data table, tooltips and round ticks; 15 digits drop only float noise. */
export function formatExact(value: number): string {
  if (value === 0) return '0';
  return value.toLocaleString('zh-CN', { maximumSignificantDigits: 15 });
}

/** Time x values are epoch milliseconds. */
export function formatX(x: string | number, scale: ChartBlockT['x']['scale']): string {
  if (typeof x === 'string') return x;
  if (scale === 'time') {
    const date = new Date(x);
    if (!Number.isNaN(date.getTime())) return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return formatExact(x);
}

export function axisLabel(axis: { label: string; unit?: string }): string {
  return axis.unit ? `${axis.label}（${axis.unit}）` : axis.label;
}

/** Round ticks across the range, about `count` of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / magnitude;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
  if (!Number.isFinite(step) || step <= 0) return [min, max];
  // Count steps instead of adding them: at large magnitudes tick + step can equal tick.
  const first = Math.ceil(min / step) * step;
  const steps = Math.floor((max - first) / step + 1e-6);
  const ticks = new Set<number>();
  for (let index = 0; index <= steps; index += 1) {
    // Floating steps drift (0.30000000000000004); labels and positions read the rounded value.
    ticks.add(Number((first + index * step).toPrecision(15)));
  }
  return ticks.size > 0 ? [...ticks] : [min, max];
}

/** Cut a label to a width in em, counting a CJK character as 1 and anything else as about half. */
export function fitLabel(label: string, widthEm: number): string {
  let used = 0;
  let out = '';
  const glyphs = Array.from(label);
  for (const [index, glyph] of glyphs.entries()) {
    used += glyph.charCodeAt(0) > 0x2e7f ? 1 : 0.56;
    if (used > widthEm - (index < glyphs.length - 1 ? 1 : 0) && index < glyphs.length - 1) {
      return `${out}…`;
    }
    out += glyph;
  }
  return out;
}

export interface ValueRange {
  min: number;
  max: number;
}

/** The value axis: from zero, or the block's own bounds. Bounds can widen it, never cut off data. */
export function valueRange(values: readonly number[], y: ChartBlockT['y']): ValueRange {
  const reversed = y.min !== undefined && y.max !== undefined && y.min > y.max;
  const bounds: { min?: number; max?: number } = reversed ? {} : y;
  const min = Math.min(bounds.min ?? 0, ...values);
  const max = Math.max(bounds.max ?? 0, ...values);
  return max > min ? { min, max } : { min, max: min + 1 };
}

export function position(value: number, range: ValueRange, size: number): number {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return ((clamped - range.min) / (range.max - range.min)) * size;
}

/** A category axis names things, so 1 and '1' are one category; a numeric axis compares numbers. */
export function axisX(x: string | number, scale: ChartBlockT['x']['scale']): string | number {
  return scale === 'category' ? String(x) : x;
}

/** Every x once, in first-seen order; a numeric axis is sorted. */
export function xValues(block: ChartBlockT): Array<string | number> {
  const seen = new Set<string | number>();
  for (const series of block.series) {
    for (const [x] of series.points) seen.add(axisX(x, block.x.scale));
  }
  const all = [...seen];
  if (block.x.scale === 'category') return all;
  return all.sort((a, b) => Number(a) - Number(b));
}

export interface ChartRow {
  x: string | number;
  /** Which appearance of this x the row is; a numeric axis lets a series repeat an x. */
  repeat: number;
  /** One entry per series, undefined where the series has no point here. */
  values: Array<number | undefined>;
}

/** The chart's points by x, so a bar row and a table row can never drop a point the data carries. */
export function chartRows(block: ChartBlockT): ChartRow[] {
  return xValues(block).flatMap((x) => {
    const perSeries = block.series.map((series) =>
      series.points.filter(([px]) => axisX(px, block.x.scale) === x).map(([, y]) => y),
    );
    const depth = Math.max(...perSeries.map((values) => values.length));
    return Array.from({ length: depth }, (_, repeat) => ({
      x,
      repeat,
      values: perSeries.map((values) => values[repeat]),
    }));
  });
}

export function rowKey(row: ChartRow): string {
  return `${row.x}:${row.repeat}`;
}
