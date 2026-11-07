import { expect, it } from 'vitest';
import { findPlotParamFences } from './plot-fence';

const PLOT = JSON.stringify({
  v: 1,
  kind: 'plot',
  view: { x: [-2, 2], y: [-2, 2] },
  items: [{ type: 'function', expr: 'x' }],
  params: [{ name: 'a', min: 0, max: 1, value: 0.5 }],
  alt: 'p',
});

// 渲染器（remark）能还原为 tlp-block 代码块的所有拼写都应被门禁检出
const DETECTED: Array<[string, string]> = [
  ['plain', `\`\`\`tlp-block\n${PLOT}\n\`\`\``],
  ['backslash', `\`\`\`tlp\\-block\n${PLOT}\n\`\`\``],
  ['entity', `\`\`\`tlp&#45;block\n${PLOT}\n\`\`\``],
  ['entity-hex', `\`\`\`tlp&#x2D;block\n${PLOT}\n\`\`\``],
  ['cr-only', `\`\`\`tlp-block\r${PLOT}\r\`\`\``],
  ['bom-body', `\`\`\`tlp-block\n﻿${PLOT}\n\`\`\``],
  ['tilde', `~~~tlp-block\n${PLOT}\n~~~`],
];

// @invariant security: 冻结题面材料按渲染器语义检出带 params 的 plot 围栏，转义语言名/BOM/~~~/\r 不构成绕过，普通材料不误拒
// @fails-if 扫描只认字面 ```tlp-block 拼写：tlp\-block、tlp&#45;block、~~~、\r 换行或正文 BOM 漏检，或无参/chart 被误拦
it('plot param fences are detected by renderer semantics', () => {
  for (const [name, md] of DETECTED) {
    expect(findPlotParamFences(md).length, name).toBeGreaterThan(0);
  }
  const staticPlot = JSON.stringify({
    v: 1,
    kind: 'plot',
    view: { x: [-2, 2], y: [-2, 2] },
    items: [{ type: 'function', expr: 'x' }],
    alt: 'p',
  });
  for (const md of [
    `\`\`\`tlp-block\n${staticPlot}\n\`\`\``,
    `\`\`\`tlp-block\n${JSON.stringify({ v: 1, kind: 'chart', chart: 'bar', x: { label: 'a' }, y: { label: 'b' }, series: [] })}\n\`\`\``,
    'no fence at all',
  ]) {
    expect(findPlotParamFences(md)).toHaveLength(0);
  }
});
