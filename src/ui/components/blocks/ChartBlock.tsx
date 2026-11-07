// A `chart` block, drawn here as SVG from its declared data, so it follows the theme and prints.
// The companion panel is about 300px wide, so the canvas is too: bars run sideways with their
// values at the ends, which keeps Chinese labels whole. The data table is always in the page for
// printing; on screen it opens from the card.

import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { BlockFrame } from './BlockFrame';
import {
  type ChartBlockT,
  axisLabel,
  fitLabel,
  formatValue,
  formatX,
  niceTicks,
  position,
  valueRange,
  xValues,
} from './chart-scale';

const WIDTH = 320;
const SERIES_COLORS = 8;

function seriesSlot(index: number): number {
  return index % SERIES_COLORS;
}

function valueAt(series: ChartBlockT['series'][number], x: string | number): number | undefined {
  return series.points.find(([px]) => px === x)?.[1];
}

function BarChart({ block }: { block: ChartBlockT }) {
  const labelWidth = 84;
  const valueWidth = 34;
  const plot = WIDTH - labelWidth - valueWidth;
  const stacked = block.stacked === true && block.series.length > 1;
  const groups = stacked ? 1 : block.series.length;
  const barHeight = groups === 1 ? 16 : 12;
  const rowHeight = groups * barHeight + (groups - 1) * 2 + 12;
  const xs = xValues(block);
  const values = stacked
    ? xs.map((x) => block.series.reduce((sum, series) => sum + (valueAt(series, x) ?? 0), 0))
    : block.series.flatMap((series) => series.points.map(([, y]) => y));
  const range = valueRange(values, block.y);
  const zero = position(0, range, plot);
  const height = rowHeight * xs.length + 4;
  return (
    <svg
      className="un-blk-chart-svg"
      viewBox={`0 0 ${WIDTH} ${height}`}
      role="img"
      aria-label={block.alt}
    >
      {xs.map((x, row) => {
        const label = formatX(x, block.x.scale);
        const top = row * rowHeight + 6;
        let stackedAt = 0;
        return (
          <g key={String(x)}>
            <text
              className="un-blk-chart-label"
              x={labelWidth - 8}
              y={top + (rowHeight - 12) / 2 + 4}
              textAnchor="end"
            >
              <title>{label}</title>
              {fitLabel(label, 6.5)}
            </text>
            {block.series.map((series, index) => {
              const value = valueAt(series, x);
              if (value === undefined) return null;
              if (stacked) {
                const from = position(stackedAt, range, plot);
                stackedAt += value;
                const to = position(stackedAt, range, plot);
                return (
                  <rect
                    key={series.name}
                    data-series={seriesSlot(index)}
                    x={labelWidth + from}
                    y={top}
                    width={Math.max(0, to - from)}
                    height={barHeight}
                  >
                    <title>{`${series.name} ${label}：${formatValue(value)}`}</title>
                  </rect>
                );
              }
              const end = position(value, range, plot);
              const y = top + index * (barHeight + 2);
              return (
                <g key={series.name}>
                  <rect
                    data-series={seriesSlot(index)}
                    x={labelWidth + Math.min(zero, end)}
                    y={y}
                    width={Math.abs(end - zero)}
                    height={barHeight}
                    rx={2}
                  >
                    <title>{`${series.name} ${label}：${formatValue(value)}`}</title>
                  </rect>
                  <text
                    className="un-blk-chart-value"
                    x={labelWidth + Math.max(zero, end) + 4}
                    y={y + barHeight / 2 + 4}
                  >
                    {formatValue(value)}
                  </text>
                </g>
              );
            })}
            {stacked ? (
              <text
                className="un-blk-chart-value"
                x={labelWidth + position(stackedAt, range, plot) + 4}
                y={top + barHeight / 2 + 4}
              >
                {formatValue(stackedAt)}
              </text>
            ) : null}
          </g>
        );
      })}
      <line
        className="un-blk-chart-axis"
        x1={labelWidth + zero}
        x2={labelWidth + zero}
        y1={2}
        y2={height - 2}
      />
    </svg>
  );
}

function PlotChart({ block }: { block: ChartBlockT }) {
  const left = 34;
  const right = 12;
  const top = 8;
  const bottom = 24;
  const height = 190;
  const plotW = WIDTH - left - right;
  const plotH = height - top - bottom;
  const range = valueRange(
    block.series.flatMap((series) => series.points.map(([, y]) => y)),
    block.y,
  );
  const xs = xValues(block);
  const numeric = block.x.scale !== 'category';
  const numbers = numeric ? (xs as number[]) : [];
  const xMin = numeric ? Math.min(...numbers) : 0;
  const xMax = numeric ? Math.max(...numbers) : 0;
  const xPosition = (x: string | number) => {
    if (numeric) {
      return xMax > xMin ? ((Number(x) - xMin) / (xMax - xMin)) * plotW : plotW / 2;
    }
    return xs.length > 1 ? (xs.indexOf(x) / (xs.length - 1)) * plotW : plotW / 2;
  };
  const yPosition = (y: number) => plotH - position(y, range, plotH);
  const xTicks: Array<string | number> =
    block.x.scale === 'linear'
      ? niceTicks(xMin, xMax, 4)
      : xs.filter(
          (_, index) =>
            index % Math.max(1, Math.ceil(xs.length / 5)) === 0 || index === xs.length - 1,
        );
  return (
    <svg
      className="un-blk-chart-svg"
      viewBox={`0 0 ${WIDTH} ${height}`}
      role="img"
      aria-label={block.alt}
    >
      <g transform={`translate(${left} ${top})`}>
        {niceTicks(range.min, range.max, 4).map((tick) => (
          <g key={tick}>
            <line
              className="un-blk-chart-grid"
              x1={0}
              x2={plotW}
              y1={yPosition(tick)}
              y2={yPosition(tick)}
            />
            <text className="un-blk-chart-tick" x={-6} y={yPosition(tick) + 3.5} textAnchor="end">
              {formatValue(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((x) => (
          <text
            key={String(x)}
            className="un-blk-chart-tick"
            x={xPosition(x)}
            y={plotH + 15}
            textAnchor="middle"
          >
            {fitLabel(formatX(x, block.x.scale), 4)}
          </text>
        ))}
        {block.series.map((series, index) => {
          const points = numeric
            ? [...series.points].sort(([a], [b]) => Number(a) - Number(b))
            : series.points;
          return (
            <g key={series.name} data-series={seriesSlot(index)}>
              {block.chart === 'line' ? (
                <polyline
                  className="un-blk-chart-line"
                  points={points.map(([x, y]) => `${xPosition(x)},${yPosition(y)}`).join(' ')}
                />
              ) : null}
              {points.map(([x, y], pointIndex) => (
                <circle
                  // biome-ignore lint/suspicious/noArrayIndexKey: a scatter series can repeat a point.
                  key={pointIndex}
                  cx={xPosition(x)}
                  cy={yPosition(y)}
                  r={block.chart === 'line' ? 2.5 : 3.5}
                >
                  <title>{`${series.name} ${formatX(x, block.x.scale)}：${formatValue(y)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function PieChart({ block, total }: { block: ChartBlockT; total: number }) {
  const size = 160;
  const center = size / 2;
  const radius = 74;
  let angle = -Math.PI / 2;
  const points = block.series[0]?.points ?? [];
  return (
    <svg
      className="un-blk-chart-svg un-blk-chart-pie"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={block.alt}
    >
      {points.map(([x, y], index) => {
        const sweep = (y / total) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        const label = `${formatX(x, block.x.scale)}：${formatValue(y)}`;
        if (sweep >= Math.PI * 2 - 1e-6) {
          return (
            <circle
              key={String(x)}
              data-series={seriesSlot(index)}
              cx={center}
              cy={center}
              r={radius}
            >
              <title>{label}</title>
            </circle>
          );
        }
        const large = sweep > Math.PI ? 1 : 0;
        const path = `M${center} ${center} L${center + radius * Math.cos(start)} ${center + radius * Math.sin(start)} A${radius} ${radius} 0 ${large} 1 ${center + radius * Math.cos(angle)} ${center + radius * Math.sin(angle)} Z`;
        return (
          <path key={String(x)} data-series={seriesSlot(index)} d={path}>
            <title>{label}</title>
          </path>
        );
      })}
    </svg>
  );
}

function Legend({ block, total }: { block: ChartBlockT; total: number }) {
  if (block.chart === 'pie') {
    return (
      <ul className="un-blk-chart-legend" aria-hidden="true">
        {(block.series[0]?.points ?? []).map(([x, y], index) => (
          <li key={String(x)}>
            <span className="un-blk-chart-key" data-series={seriesSlot(index)} />
            {formatX(x, block.x.scale)} {formatValue(y)}（{Math.round((y / total) * 100)}%）
          </li>
        ))}
      </ul>
    );
  }
  if (block.series.length < 2) return null;
  return (
    <ul className="un-blk-chart-legend" aria-hidden="true">
      {block.series.map((series, index) => (
        <li key={series.name}>
          <span className="un-blk-chart-key" data-series={seriesSlot(index)} />
          {series.name}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ block, id, total }: { block: ChartBlockT; id: string; total: number }) {
  const xName = block.x.label || '项目';
  const yName = axisLabel(block.y);
  if (block.chart === 'scatter') {
    return (
      <table id={id} className="un-blk-chart-table">
        <thead>
          <tr>
            <th scope="col">系列</th>
            <th scope="col">{axisLabel(block.x)}</th>
            <th scope="col">{yName}</th>
          </tr>
        </thead>
        <tbody>
          {block.series.flatMap((series) =>
            series.points.map(([x, y], index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a scatter series can repeat a point.
              <tr key={`${series.name}:${index}`}>
                <td>{series.name}</td>
                <td>{formatX(x, block.x.scale)}</td>
                <td>{formatValue(y)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    );
  }
  if (block.chart === 'pie') {
    return (
      <table id={id} className="un-blk-chart-table">
        <thead>
          <tr>
            <th scope="col">{xName}</th>
            <th scope="col">{yName}</th>
            <th scope="col">占比</th>
          </tr>
        </thead>
        <tbody>
          {(block.series[0]?.points ?? []).map(([x, y]) => (
            <tr key={String(x)}>
              <td>{formatX(x, block.x.scale)}</td>
              <td>{formatValue(y)}</td>
              <td>{Math.round((y / total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table id={id} className="un-blk-chart-table">
      <thead>
        <tr>
          <th scope="col">{axisLabel(block.x)}</th>
          {block.series.map((series) => (
            <th key={series.name} scope="col">
              {block.series.length > 1 ? series.name : yName}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {xValues(block).map((x) => (
          <tr key={String(x)}>
            <td>{formatX(x, block.x.scale)}</td>
            {block.series.map((series) => {
              const value = valueAt(series, x);
              return <td key={series.name}>{value === undefined ? '—' : formatValue(value)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChartBlock({ block }: { block: ChartBlockT }): ReactElement {
  const tableId = useId();
  const [tableOpen, setTableOpen] = useState(false);
  const pointCount = block.series.reduce((sum, series) => sum + series.points.length, 0);
  const total = block.series[0]?.points.reduce((sum, [, y]) => sum + y, 0) ?? 0;
  const drawable = pointCount > 0 && (block.chart !== 'pie' || total > 0);
  const fromRecords = block.data_source.kind === 'tool_result';
  return (
    <BlockFrame kind="chart" caption={block.caption}>
      <div className="un-blk-chart" data-table-open={tableOpen ? '' : undefined}>
        <div className="un-blk-chart-head">
          <span className="un-blk-chart-source" data-source={block.data_source.kind}>
            {fromRecords ? '来自记录' : '模型整理'}
          </span>
          {drawable ? (
            <button
              type="button"
              className="un-blk-chart-toggle un-hit"
              aria-expanded={tableOpen}
              aria-controls={tableId}
              onClick={() => setTableOpen((open) => !open)}
            >
              {tableOpen ? '收起数据表' : '看数据表'}
            </button>
          ) : null}
        </div>
        {!drawable ? (
          <p className="un-blk-chart-empty">这张图没有可画的数据。</p>
        ) : (
          <>
            {block.chart === 'bar' ? (
              <BarChart block={block} />
            ) : block.chart === 'pie' ? (
              <PieChart block={block} total={total} />
            ) : (
              <PlotChart block={block} />
            )}
            <Legend block={block} total={total} />
            {block.chart === 'pie' ? null : (
              <p className="un-blk-chart-axes">
                {block.chart === 'bar'
                  ? axisLabel(block.y)
                  : `横轴 ${axisLabel(block.x)} · 纵轴 ${axisLabel(block.y)}`}
              </p>
            )}
            <DataTable block={block} id={tableId} total={total} />
          </>
        )}
      </div>
    </BlockFrame>
  );
}
