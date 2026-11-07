// The arithmetic a chart needs: axis ticks, value and date wording, and fitting a label to a width.

import type { BlockV1T } from '@/core/schema/blocks';

export type ChartBlockT = Extract<BlockV1T, { kind: 'chart' }>;

export function formatValue(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** Time x values are epoch milliseconds. */
export function formatX(x: string | number, scale: ChartBlockT['x']['scale']): string {
  if (typeof x === 'string') return x;
  if (scale === 'time') {
    const date = new Date(x);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return formatValue(x);
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
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-6; tick += step) {
    // Floating steps drift (0.30000000000000004); labels and positions read the rounded value.
    ticks.push(Number(tick.toPrecision(12)));
  }
  return ticks;
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

/** The value axis: the block's own bounds where given, else zero to the data. */
export function valueRange(values: readonly number[], y: ChartBlockT['y']): ValueRange {
  const dataMax = Math.max(0, ...values);
  const dataMin = Math.min(0, ...values);
  const min = y.min ?? dataMin;
  const max = y.max ?? dataMax;
  return max > min ? { min, max } : { min, max: min + 1 };
}

export function position(value: number, range: ValueRange, size: number): number {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  return ((clamped - range.min) / (range.max - range.min)) * size;
}

/** Every x once, in first-seen order; a numeric axis is sorted. */
export function xValues(block: ChartBlockT): Array<string | number> {
  const seen = new Set<string | number>();
  for (const series of block.series) {
    for (const [x] of series.points) seen.add(x);
  }
  const all = [...seen];
  if (block.x.scale === 'category') return all;
  return all.sort((a, b) => Number(a) - Number(b));
}
