// Chart validation shared by compose_block (typed issues before the block is
// accepted) and reply finalization (the authoritative series copy after the
// tool_result binding resolves). Keeping one checker means the model's repair
// loop and the committed fence agree on what a valid chart is.

import { ChartBlock, type ChartBlockT } from '@/core/schema/blocks/block';
import type { BlockIssueT } from '@/core/schema/blocks/issues';

/** Design limit: 500 points across all series, not per series. */
const CHART_POINTS_MAX = 500;
const MAX_ISSUES = 12;

export function isJsonPointer(path: string): boolean {
  if (path === '') return true;
  if (!path.startsWith('/')) return false;
  // RFC 6901: `~` only introduces `~0` or `~1`.
  return !/~(?![01])/.test(path);
}

/** RFC 6901 resolution over plain JSON. `''` names the whole document. */
export function resolveJsonPointer(
  root: unknown,
  pointer: string,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (!isJsonPointer(pointer)) {
    return { ok: false, detail: 'path must be a JSON Pointer such as /mistakes/0/count' };
  }
  if (pointer === '') return { ok: true, value: root };
  let current: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/.test(token) ? Number(token) : NaN;
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return { ok: false, detail: `path segment '${token}' is not an array index here` };
      }
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      return { ok: false, detail: `path segment '${token}' does not exist in the recorded result` };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { ok: true, value: current };
}

function issue(path: string, detail: string): BlockIssueT {
  return { code: 'chart_series_invalid', path, detail };
}

/**
 * Deterministic chart rules from the design: finite numbers, 500 points total,
 * unique category x per series, bar-only stacked, and a single non-negative
 * series for pie.
 */
export function chartSeriesIssues(block: ChartBlockT): BlockIssueT[] {
  const issues: BlockIssueT[] = [];
  let total = 0;
  for (const [seriesIndex, series] of block.series.entries()) {
    total += series.points.length;
    const seen = new Set<string>();
    for (const [pointIndex, [x, y]] of series.points.entries()) {
      if (typeof y !== 'number' || !Number.isFinite(y)) {
        issues.push(
          issue(`/series/${seriesIndex}/points/${pointIndex}/1`, 'y values must be finite numbers'),
        );
        continue;
      }
      if (block.x.scale === 'category') {
        const key = String(x);
        if (seen.has(key)) {
          issues.push(
            issue(
              `/series/${seriesIndex}/points/${pointIndex}/0`,
              `category '${key}' repeats inside series '${series.name}'`,
            ),
          );
        }
        seen.add(key);
      } else if (typeof x !== 'number' || !Number.isFinite(x)) {
        issues.push(
          issue(
            `/series/${seriesIndex}/points/${pointIndex}/0`,
            `${block.x.scale} x values must be finite numbers`,
          ),
        );
      }
    }
  }
  if (total > CHART_POINTS_MAX) {
    issues.push(issue('/series', `charts carry at most ${CHART_POINTS_MAX} points in total`));
  }
  if (block.stacked === true && block.chart !== 'bar') {
    issues.push(issue('/stacked', 'stacked is only valid for a bar chart'));
  }
  if (block.chart === 'pie') {
    if (block.series.length !== 1) {
      issues.push(issue('/series', 'a pie chart requires exactly one series'));
    }
    if (block.series.some((series) => series.points.some(([, y]) => y < 0))) {
      issues.push(issue('/series', 'pie values must be non-negative'));
    }
  }
  return issues.slice(0, MAX_ISSUES);
}

/** chart blocks whose series are authoritative only after commit binding. */
export function chartPublishedAfterBinding(block: unknown): boolean {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { kind?: unknown }).kind === 'chart' &&
    (block as { data_source?: { kind?: unknown } }).data_source?.kind === 'tool_result'
  );
}

function recordedChartCaption(output: unknown): string | undefined {
  if (output === null || typeof output !== 'object') return undefined;
  const caption = (output as { chart_caption?: unknown }).chart_caption;
  return typeof caption === 'string' ? caption : undefined;
}

/**
 * Replace the model's series with the recorded value at the binding path. The
 * recorded value must already be a series array (`[{name, points:[[x,y],…]}]`);
 * anything else leaves the block unbound so the finalizer drops it. The caption
 * also comes from the record, so a chart can't claim a window its rows don't cover.
 */
export function bindChartSeries(
  block: ChartBlockT,
  output: unknown,
): { ok: true; block: ChartBlockT } | { ok: false; issue: BlockIssueT } {
  if (block.data_source.kind !== 'tool_result') return { ok: true, block };
  const resolved = resolveJsonPointer(output, block.data_source.path);
  if (!resolved.ok) {
    return {
      ok: false,
      issue: {
        code: 'chart_tool_result_unresolved',
        path: '/data_source/path',
        detail: resolved.detail,
      },
    };
  }
  const series = ChartBlock.shape.series.safeParse(resolved.value);
  if (!series.success) {
    return {
      ok: false,
      issue: {
        code: 'chart_tool_result_unresolved',
        path: '/data_source/path',
        detail: 'path must resolve to [{name, points:[[x,y],…]}] with at most 8 series',
      },
    };
  }
  const { caption: _modelCaption, ...rest } = block;
  const caption = recordedChartCaption(output);
  const bound: ChartBlockT = { ...rest, series: series.data, ...(caption ? { caption } : {}) };
  const issues = chartSeriesIssues(bound);
  return issues.length > 0 ? { ok: false, issue: issues[0] } : { ok: true, block: bound };
}
