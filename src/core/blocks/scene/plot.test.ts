import { expect, it } from 'vitest';
import type { PlotBlockInputT, PlotBlockT } from '../../schema/blocks/block';
import { evaluateExpression, parseExpression } from '../expr';
import { type PlotCurveSegment, compilePlotBlock, computeScene, samplesForTable } from './plot';

const compile = (
  exprs: string[],
  x: [number, number],
  y: [number, number] | 'auto',
  axes?: PlotBlockInputT['axes'],
): PlotBlockT => {
  const input: PlotBlockInputT = {
    v: 1,
    kind: 'plot',
    engine: 'tlp-scene@1',
    alt: 'a',
    view: { x, y },
    items: exprs.map((expr) => ({ type: 'function', expr })),
    ...(axes ? { axes } : {}),
  };
  const result = compilePlotBlock(input, 'note');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('compilePlotBlock rejected a valid input');
  return result.block;
};

const segs = (block: PlotBlockT): readonly PlotCurveSegment[] =>
  computeScene(block, {}).curves[0].segments;

const visible = (s: readonly PlotCurveSegment[], y0: number, y1: number): boolean =>
  s.some((sg) => sg.some((p) => p[1] >= y0 && p[1] <= y1));

const maxDy = (s: readonly PlotCurveSegment[]): number =>
  s.reduce(
    (m, sg) => sg.reduce((n, p, i) => (i ? Math.max(n, Math.abs(p[1] - sg[i - 1][1])) : n), m),
    0,
  );

const crossesX = (s: readonly PlotCurveSegment[], x: number): boolean =>
  s.some((sg) => sg.some((p, i) => i > 0 && sg[i - 1][0] < x && p[0] > x));

// @invariant grading: 表达式曲线的确定性绘制契约——连续段不误断、跳点/极点必断、表格未定义点为 null、同输入两轮字节一致
// @fails-if 断点判据依赖视窗 y 阈值或细分预算：atan(1000x)/x^9 等连续曲线被断开，floor/1/x 的断点被连线，或表格在极点给数
it('plot curves follow the deterministic continuity contract', () => {
  // 视窗无关：4 条 x 在 ±1e6 视窗各过原点且有可见线段
  const huge = computeScene(compile(['x', 'x', 'x', 'x'], [-1e6, 1e6], [-1, 1]), {});
  for (const c of huge.curves) expect(visible(c.segments, -1, 1)).toBe(true);
  expect(visible(segs(compile(['x'], [-1, 1], [-0.001, 0.001])), -0.001, 0.001)).toBe(true);
  // 陡峭连续绝不断
  for (const e of ['atan(1000*x)', 'tanh(100*x)']) {
    expect(segs(compile([e], [-100, 100], [-2, 2])).length).toBe(1);
  }
  for (const e of ['x^9', 'exp(x)', 'sin(x)', 'x^2']) {
    expect(segs(compile([e], [-10, 10], [-50, 50])).length).toBe(1);
  }
  // 跳点必断且无竖线（相邻点 |dy| 不超过步幅）
  for (const [e, amp] of [
    ['floor(x)', 1],
    ['ceil(x)', 1],
    ['sign(x)', 2],
  ] as const) {
    for (const yr of [
      [-20, 20],
      [-3, 3],
    ] as const) {
      const s = segs(compile([e], [-2, 2], [yr[0], yr[1]]));
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(maxDy(s)).toBeLessThanOrEqual(amp);
    }
  }
  // 极点必断：同侧等高端点也断；后续区间仍有曲线
  const sameSide = segs(compile(['1/(x-0.00390625)^2'], [-2, 2], [0, 1e5]));
  expect(sameSide.length).toBeGreaterThanOrEqual(2);
  expect(crossesX(sameSide, 0.00390625)).toBe(false);
  for (const [e, y] of [
    ['1/x', [-10, 10]],
    ['tan(x)', [-2, 2]],
    ['1/(x-1)^2', [0, 100]],
  ] as const) {
    expect(segs(compile([e], [-2, 2], [y[0], y[1]])).length).toBeGreaterThanOrEqual(2);
  }
  const osc = segs(compile(['sin(10000*x)+0.000001/(x-1.001)^2'], [-2, 2], [-2, 2]));
  expect(crossesX(osc, 1.001)).toBe(false);
  expect(osc.some((sg) => sg.some((p) => p[0] > 1.001))).toBe(true);
  // 小视窗完整对角线；极端视窗不卡死（x 视窗在自身量级不可解时编译拒绝）
  expect(segs(compile(['x'], [0, 0.001], [0, 0.001])).length).toBe(1);
  expect(
    compilePlotBlock(
      {
        v: 1,
        kind: 'plot',
        engine: 'tlp-scene@1',
        alt: 'a',
        view: { x: [1e16, 1e16 + 2], y: [-1, 1] },
        items: [{ type: 'function', expr: '0' }],
      },
      'note',
    ).ok,
  ).toBe(false);
  // 未定义点：tan 在 π/2 映射 NaN，域外函数 NaN
  const vars = new Set(['x']);
  for (const e of ['tan(pi/2)', 'log(0,2)', 'log(1,2)', 'sqrt(-1)']) {
    const p = parseExpression(e, vars);
    expect(p.ok).toBe(true);
    if (p.ok) expect(Number.isFinite(evaluateExpression(p.ast, { x: 0 }))).toBe(false);
  }
  // π 刻度：表格在极点为 null
  const row = samplesForTable(
    compile(['tan(x)'], [-Math.PI, Math.PI], [-2, 2], { pi_ticks: true }),
    {},
  ).find((r) => Math.abs(r.x - Math.PI / 2) < 0.01);
  expect(row?.y[0]).toBeNull();
  // 同输入两轮字节一致
  const d = compile(['x^2', 'sin(x)', '1/x'], [-4, 4], [-8, 8]);
  expect(JSON.stringify(computeScene(d, {}))).toBe(JSON.stringify(computeScene(d, {})));
});
