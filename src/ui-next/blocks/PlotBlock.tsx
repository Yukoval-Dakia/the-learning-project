// A function graph in a reply (`plot`). The model gives expressions and ranges; every point and tick
// comes from computeScene, which runs here on each slider move. Slider state stays in this block:
// nothing is written anywhere, and a reload starts from the values the block was composed with.

import type { ReactElement } from 'react';
import { useDeferredValue, useId, useMemo, useState, useSyncExternalStore } from 'react';
import {
  type PlotParamValues,
  type PlotTick,
  computeScene,
  resolveParamValues,
  samplesForTable,
} from '@/core/blocks/scene/plot';
import type { PlotBlockT, PlotParamT } from '@/core/schema/blocks';
import './plot.css';

const WIDTH = 320;
const DEFAULT_HEIGHT = 250;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 420;
const MARGIN = { left: 10, right: 14, top: 14, bottom: 14 };
/** Rounding noise, like sin(π) coming out as 1e-16, reads as zero. */
const NOISE = 1e-9;
/** A tick label's rough width per character, enough to keep neighbours from touching. */
const TICK_CHAR_WIDTH = 6.2;
const TICK_GAP = 8;
const TICK_LINE_HEIGHT = 14;

function createValueStore(start: PlotParamValues) {
  let values = start;
  const listeners = new Set<() => void>();
  return {
    get: () => values,
    set(next: PlotParamValues) {
      values = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const minusSign = (text: string) => text.replace(/^-/, '−');

function numberText(value: number): string {
  if (Math.abs(value) < NOISE) return '0';
  return minusSign(String(Number(value.toPrecision(6))));
}

function paramText(param: PlotParamT, value: number): string {
  const decimals = param.step === undefined ? 2 : (String(param.step).split('.')[1] ?? '').length;
  return minusSign(String(Number(value.toFixed(decimals))));
}

/** Keeps ticks in order, skipping any that would touch the one before it. */
function spacedTicks(
  ticks: ReadonlyArray<PlotTick>,
  position: (value: number) => number,
  room: (tick: PlotTick) => number,
): PlotTick[] {
  const kept: PlotTick[] = [];
  let last: number | null = null;
  for (const tick of ticks) {
    const at = position(tick.value);
    if (last !== null && Math.abs(at - last) < room(tick)) continue;
    kept.push(tick);
    last = at;
  }
  return kept;
}

function Sliders({
  params,
  values,
  onChange,
}: {
  params: readonly PlotParamT[];
  values: PlotParamValues;
  onChange: (name: string, value: number) => void;
}) {
  return (
    <fieldset className="un-plot-sliders" aria-label="调整参数">
      {params.map((param) => {
        const value = values[param.name] ?? param.value;
        return (
          <label key={param.name} className="un-plot-slider">
            <span className="un-plot-slider-name">
              <i>{param.name}</i>
              {param.label ? <span>{param.label}</span> : null}
            </span>
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={param.step ?? 'any'}
              value={value}
              aria-valuetext={`${param.name} 等于 ${paramText(param, value)}`}
              onChange={(event) => onChange(param.name, Number(event.currentTarget.value))}
            />
            <output className="un-plot-slider-value">{paramText(param, value)}</output>
          </label>
        );
      })}
    </fieldset>
  );
}

function ValueTable({ block, values }: { block: PlotBlockT; values: PlotParamValues }) {
  const rows = useMemo(() => samplesForTable(block, values), [block, values]);
  return (
    <table className="un-blk-chart-table">
      <thead>
        <tr>
          <th scope="col">{block.axes?.x_label ?? 'x'}</th>
          {block.items.map((item) => (
            <th key={item.expr} scope="col">
              {item.label ?? block.axes?.y_label ?? 'y'}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.x}>
            <td>{row.x_label}</td>
            {block.items.map((item, column) => {
              const y = row.y[column] ?? null;
              return <td key={item.expr}>{y === null ? '无定义' : numberText(y)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PlotBlock({ block }: { block: PlotBlockT }): ReactElement {
  const params = block.params ?? [];
  const [start] = useState(() => resolveParamValues(params));
  const [store] = useState(() => createValueStore(start));
  const values = useSyncExternalStore(store.subscribe, store.get, store.get);
  // The slider follows the finger; the curve catches up when computing it takes longer.
  const shown = useDeferredValue(values);
  const [open, setOpen] = useState(false);
  const scene = useMemo(() => computeScene(block, shown), [block, shown]);
  const ids = useId().replace(/[^a-zA-Z0-9]/g, '');
  const changed = params.some((param) => values[param.name] !== start[param.name]);

  const [x0, x1] = scene.view.x;
  const [y0, y1] = scene.view.y;
  // An axis on the view's edge has its numbers outside the plot, so they need the room.
  const longestY = Math.max(0, ...scene.ticks.y.map((tick) => tick.label.length));
  const margin = {
    ...MARGIN,
    left: scene.axis_lines.y_axis_x === x0 ? MARGIN.left + longestY * TICK_CHAR_WIDTH : MARGIN.left,
    bottom: scene.axis_lines.x_axis_y === y0 ? MARGIN.bottom + TICK_LINE_HEIGHT : MARGIN.bottom,
  };
  const plotW = WIDTH - margin.left - margin.right;
  const height = scene.view.equal_aspect
    ? Math.max(
        MIN_HEIGHT,
        Math.min(MAX_HEIGHT, (plotW * (y1 - y0)) / (x1 - x0) + margin.top + margin.bottom),
      )
    : DEFAULT_HEIGHT;
  const plotH = height - margin.top - margin.bottom;
  const px = (x: number) => margin.left + ((x - x0) / (x1 - x0)) * plotW;
  const py = (y: number) => margin.top + plotH - ((y - y0) / (y1 - y0)) * plotH;
  const axisX = px(scene.axis_lines.y_axis_x);
  const axisY = py(scene.axis_lines.x_axis_y);
  const atOrigin = scene.axis_lines.x_axis_y === 0 && scene.axis_lines.y_axis_x === 0;

  const xTicks = spacedTicks(
    scene.ticks.x.filter((tick) => !(atOrigin && tick.value === 0)),
    px,
    (tick) => tick.label.length * TICK_CHAR_WIDTH + TICK_GAP,
  );
  const yTicks = spacedTicks(
    scene.ticks.y.filter((tick) => !(atOrigin && tick.value === 0)),
    py,
    () => TICK_LINE_HEIGHT,
  );

  const current = params.map((p) => `${p.name} = ${paramText(p, shown[p.name] ?? p.value)}`);
  const label = current.length > 0 ? `${block.alt}，当前 ${current.join('，')}` : block.alt;
  const legend = scene.curves.filter((curve) => curve.label);
  const empty = scene.curves.every((curve) => curve.segments.length === 0);

  return (
    <figure className="un-blk" data-kind="chart">
      <div className="un-blk-chart" data-table-open={open ? '' : undefined}>
        <div className="un-blk-chart-head">
          <span className="un-blk-chart-source">{scene.title ?? '按公式计算'}</span>
          <span className="un-plot-actions">
            {changed ? (
              <button
                type="button"
                className="un-blk-chart-toggle un-hit"
                onClick={() => store.set(start)}
              >
                恢复
              </button>
            ) : null}
            <button
              type="button"
              className="un-blk-chart-toggle un-hit"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? '收起取值' : '看取值'}
            </button>
          </span>
        </div>
        {scene.title ? <p className="un-plot-source">按公式计算</p> : null}
        <svg
          className="un-blk-chart-svg"
          viewBox={`0 0 ${WIDTH} ${height}`}
          role="img"
          aria-label={label}
        >
          <defs>
            <clipPath id={`${ids}c`}>
              <rect x={margin.left} y={margin.top} width={plotW} height={plotH} />
            </clipPath>
            <marker
              id={`${ids}a`}
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="3.5"
              orient="auto"
            >
              <path d="M1 1 L6 3.5 L1 6" className="un-plot-arrow" />
            </marker>
          </defs>
          {scene.grid
            ? xTicks.map((tick) => (
                <line
                  key={`gx${tick.value}`}
                  className="un-blk-chart-grid"
                  x1={px(tick.value)}
                  x2={px(tick.value)}
                  y1={margin.top}
                  y2={height - margin.bottom}
                />
              ))
            : null}
          {scene.grid
            ? yTicks.map((tick) => (
                <line
                  key={`gy${tick.value}`}
                  className="un-blk-chart-grid"
                  x1={margin.left}
                  x2={WIDTH - margin.right}
                  y1={py(tick.value)}
                  y2={py(tick.value)}
                />
              ))
            : null}
          <line
            className="un-blk-chart-axis"
            x1={margin.left}
            x2={WIDTH - margin.right + 6}
            y1={axisY}
            y2={axisY}
            markerEnd={`url(#${ids}a)`}
          />
          <line
            className="un-blk-chart-axis"
            x1={axisX}
            x2={axisX}
            y1={height - margin.bottom}
            y2={margin.top - 6}
            markerEnd={`url(#${ids}a)`}
          />
          {/* Words go under the curve: a label's halo never cuts a line the learner is reading. */}
          {xTicks.map((tick) => (
            <text
              key={`lx${tick.value}`}
              className="un-blk-chart-tick un-plot-halo"
              x={px(tick.value)}
              y={axisY + 13}
              textAnchor="middle"
            >
              {tick.label}
            </text>
          ))}
          {yTicks.map((tick) => (
            <text
              key={`ly${tick.value}`}
              className="un-blk-chart-tick un-plot-halo"
              x={axisX - 5}
              y={py(tick.value) + 3.5}
              textAnchor="end"
            >
              {tick.label}
            </text>
          ))}
          {atOrigin ? (
            <text
              className="un-blk-chart-tick un-plot-halo"
              x={axisX - 7}
              y={axisY + 14}
              textAnchor="end"
            >
              O
            </text>
          ) : null}
          <text
            className="un-blk-chart-tick un-plot-halo un-plot-axis-name"
            x={WIDTH - 4}
            y={axisY - 6}
            textAnchor="end"
          >
            {scene.x_label ?? 'x'}
          </text>
          <text
            className="un-blk-chart-tick un-plot-halo un-plot-axis-name"
            x={axisX + 7}
            y={margin.top + 2}
          >
            {scene.y_label ?? 'y'}
          </text>
          <g clipPath={`url(#${ids}c)`}>
            {scene.curves.map((curve) => (
              <g key={curve.index} data-series={curve.color}>
                {curve.segments.map((segment) => (
                  <path
                    key={`${segment[0]?.[0]}:${segment[0]?.[1]}`}
                    className="un-plot-curve"
                    data-dashed={curve.dashed ? '' : undefined}
                    d={segment
                      .map(
                        ([x, y], i) =>
                          `${i === 0 ? 'M' : 'L'}${px(x).toFixed(2)} ${py(y).toFixed(2)}`,
                      )
                      .join('')}
                  />
                ))}
              </g>
            ))}
          </g>
        </svg>
        {empty ? <p className="un-plot-source">这组取值下，曲线不在图的范围内。</p> : null}
        {legend.length > 0 ? (
          <ul className="un-blk-chart-legend" aria-hidden="true">
            {legend.map((curve) => (
              <li key={curve.index}>
                <span className="un-blk-chart-key" data-series={curve.color} />
                {curve.label}
              </li>
            ))}
          </ul>
        ) : null}
        {params.length > 0 ? (
          <Sliders
            params={params}
            values={values}
            onChange={(name, value) =>
              store.set(resolveParamValues(params, { ...store.get(), [name]: value }))
            }
          />
        ) : null}
        {open ? <ValueTable block={block} values={shown} /> : null}
      </div>
      {block.caption ? <figcaption className="un-blk-caption">{block.caption}</figcaption> : null}
    </figure>
  );
}
