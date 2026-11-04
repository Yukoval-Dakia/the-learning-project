import { Suspense } from 'react';
import { type ApparatusData, ApparatusBlock } from './ApparatusBlock';
import { FlowBlock, type FlowData } from './FlowBlock';
import { PlotBlock, type QuadCase } from './PlotBlock';

export const SALT: FlowData = {
  key: 'salt',
  groups: [
    { id: 'g1', label: '除去不溶性杂质' },
    { id: 'g2', label: '得到精盐' },
  ],
  nodes: [
    { id: 'dissolve', label: '溶解', sub: '粗盐加水，边加边搅拌', group: 'g1' },
    { id: 'filter', label: '过滤', sub: '一贴二低三靠', group: 'g1' },
    { id: 'clear', label: '滤液澄清吗？', kind: 'decision', group: 'g1' },
    { id: 'evap', label: '蒸发', sub: '出现较多固体时停止加热', emphasis: true, group: 'g2' },
    { id: 'move', label: '转移固体', group: 'g2' },
    { id: 'yield', label: '计算产率', kind: 'end', group: 'g2' },
  ],
  edges: [
    { from: 'dissolve', to: 'filter' },
    { from: 'filter', to: 'clear' },
    { from: 'clear', to: 'filter', label: '否', back: true },
    { from: 'clear', to: 'evap', label: '是' },
    { from: 'evap', to: 'move' },
    { from: 'move', to: 'yield' },
  ],
};

export const ROOTS: FlowData = {
  key: 'roots',
  nodes: [
    { id: 'std', label: '化成一般式', sub: 'ax² + bx + c = 0' },
    { id: 'calc', label: '算判别式', sub: 'Δ = b² − 4ac' },
    { id: 'sign', label: 'Δ 的符号', kind: 'decision' },
    { id: 'two', label: '两个不相等的实数根', kind: 'end' },
    { id: 'one', label: '两个相等的实数根', kind: 'end' },
    { id: 'none', label: '没有实数根', kind: 'end' },
  ],
  edges: [
    { from: 'std', to: 'calc' },
    { from: 'calc', to: 'sign' },
    { from: 'sign', to: 'two', label: 'Δ > 0' },
    { from: 'sign', to: 'one', label: 'Δ = 0' },
    { from: 'sign', to: 'none', label: 'Δ < 0' },
  ],
};

export const CHLORINE: ApparatusData = {
  key: 'cl2',
  devices: [
    { id: 'gen', type: 'heated_flask_funnel', flask: 'MnO2', funnel: '浓盐酸', name: '发生装置', role: '固液加热' },
    { id: 'w1', type: 'wash_bottle', liquid: 'brine', name: '饱和食盐水', role: '除去 HCl' },
    { id: 'w2', type: 'wash_bottle', liquid: 'acid', name: '浓硫酸', role: '干燥' },
    { id: 'c', type: 'collect_bottle', gas: 'chlorine', name: '集气瓶', role: '向上排空气法' },
    { id: 'a', type: 'absorb_beaker', liquid: 'base', name: 'NaOH 溶液', role: '吸收尾气' },
  ],
  chain: ['gen', 'w1', 'w2', 'c', 'a'],
  wrap: [
    ['gen', 'w1'],
    ['w2', 'c', 'a'],
  ],
};

export const QUADS: QuadCase[] = [
  { a: 1, b: -2, c: -3 },
  { a: 1, b: -2, c: 1 },
  { a: 1, b: -2, c: 3 },
];

export function Blocks({ only }: { only?: string }) {
  return (
    <Suspense fallback={null}>
      {only === 'apparatus' || !only ? <ApparatusBlock data={CHLORINE} caption="实验室制取氯气" /> : null}
      {only === 'salt' || !only ? <FlowBlock data={SALT} caption="粗盐提纯" /> : null}
      {only === 'roots' || !only ? <FlowBlock data={ROOTS} caption="判断一元二次方程根的情况" /> : null}
      {only === 'plot' || !only ? <PlotBlock cases={QUADS} caption="判别式决定抛物线和 x 轴的交点个数" /> : null}
    </Suspense>
  );
}
