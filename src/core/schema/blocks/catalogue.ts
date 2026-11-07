// Model instructions generated from the block schemas so prose and validator
// cannot drift. Consumers: the Copilot prompt, the note-generation prompt and
// the ingestion prompt.
//
// The catalogue sits at the owner's 12,000-char system-prompt budget, so the
// lines are hand-tightened: every rule that used to be stated is still stated,
// only shorter. The full schemas travel in the tool JSON, which the budget does
// not count. Adding a kind must therefore keep this file net non-growing.

import { BLOCK_IMPLEMENTED_KINDS, BLOCK_SURFACE_KINDS, type BlockSurface } from './surfaces';

const QUESTION_REF_EXAMPLE = {
  block: {
    v: 1,
    kind: 'question_ref',
    question_ids: ['q_id'],
    display: 'inline',
    alt: '题目',
    label: '打开题目',
  },
};

/**
 * One catalogue per surface. Only implemented kinds get full lines; the rest
 * of the union stays listed as unavailable so the stored format stays forward
 * compatible without promising the model capabilities this build lacks.
 */
export function renderBlockCatalogue(surface: BlockSurface): string {
  const allowed = new Set(BLOCK_SURFACE_KINDS[surface]);
  const implemented = new Set(BLOCK_IMPLEMENTED_KINDS);
  const lines: string[] = [
    '【生成式积木】图/积木须用 compose_block；勿手写 tlp-block、mermaid 或 SVG/ASCII（页面只显示源码）。成功返 ref/place；正文用 `![简短说明](block:<ref>)` 逐块放置；已放一个时未放者隐藏。失败返 status=invalid+issues[]（code/path/line/expected），修正重提，勿重复。',
  ];
  for (const kind of [
    'diagram',
    'figure',
    'interactive',
    'question_ref',
    'entity_card',
    'chart',
    'plot',
  ] as const) {
    if (!allowed.has(kind)) continue;
    if (!implemented.has(kind)) {
      lines.push(`- ${kind}：本版本尚未开放，不要调用。`);
      continue;
    }
    if (kind === 'plot') {
      lines.push(
        '- plot：函数曲线用 plot，chart 折线只给离散数据。view.x=[min,max]、view.y="auto"|[min,max]、items[{type:"function",expr,label?,color?,dashed?}]、params≤4{name,min,max,value,step?}。入参：{"block":{"v":1,"kind":"plot","view":{"x":[-3,3],"y":"auto"},"items":[{"type":"function","expr":"x^2"}],"alt":"…"}}',
      );
      continue;
    }
    if (kind === 'diagram') {
      lines.push(
        '- diagram：Mermaid12 流程图/时序/状态/思维导图/时间线/ER/类图；禁 click/href/callback、%%{}、HTML 标签、style/classDef 的 url()。入参：{"block":{"v":1,"kind":"diagram","engine":"mermaid","source":"flowchart TD\\n  A-->B","alt":"…"}}',
      );
      continue;
    }
    if (kind === 'figure') {
      lines.push(
        '- figure：模型自绘 SVG（装置/受力/几何/电路），服务端按白名单重建、存只读资产并返回位图自检。入参：{"block":{"v":1,"kind":"figure","svg":"<svg viewBox=\'0 0 120 80\'><rect x=\'10\' y=\'10\' width=\'40\' height=\'60\'/></svg>","alt":"…"}}',
      );
      continue;
    }
    if (kind === 'question_ref') {
      lines.push(
        `- question_ref：仅id题卡；display=link|inline（inline单题，每回复最多3张，其余display=link），alt/label固定，禁caption。入参：${JSON.stringify(QUESTION_REF_EXAMPLE)}`,
      );
      continue;
    }
    if (kind === 'entity_card') {
      lines.push(
        '- entity_card：知识点/笔记卡，只存 id，内容由服务端读；entity_kind=knowledge|note，entity_id，alt 知识点/笔记，label 打开，禁 caption。',
      );
      continue;
    }
    if (kind === 'chart') {
      lines.push(
        '- chart：chart=bar|line|scatter|pie、x{label,scale}、y{label}、series[{name,points}]；line 仅离散点，不画函数；data_source={kind:"model"} 仅学习内容，学习者统计用 {kind:"tool_result",tool_use_id,path}（query_mistakes 聚合）。',
      );
    }
  }
  lines.push(
    '- 化学式/方程式：用行内数学 `$\\ce{…}$`，如 `$\\ce{2H2 + O2 -> 2H2O}$`、`$\\ce{CuSO4 * 5H2O}$`。',
  );
  lines.push(
    '- figure 的 images 是位图自检：先看图确认装置连接无误，再写 place；画错修 SVG 重提。',
  );
  return lines.join('\n');
}
