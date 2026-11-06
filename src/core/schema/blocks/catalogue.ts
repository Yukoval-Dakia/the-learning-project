// YUK-1548 (§4.1) — model instructions generated from the block schemas so
// prose and validator cannot drift. Consumers: the Copilot prompt (slice 1),
// the note-generation prompt (slice 2), the ingestion prompt (slice 3).

import { z } from 'zod';
import {
  type BlockKind,
  ChartBlock,
  DiagramBlock,
  FigureBlockInput,
  InteractiveBlockInput,
  QuestionRefBlock,
} from './block';
import { BLOCK_IMPLEMENTED_KINDS, BLOCK_SURFACE_KINDS, type BlockSurface } from './surfaces';

// Field lists are generated from the MODEL-FACING input schemas so the
// catalogue matches what compose_block actually accepts (figure `svg`,
// interactive `html`), never the asset-only stored form.
const MEMBER_META: Record<BlockKind, { schema: z.ZodType; example: unknown }> = {
  diagram: {
    schema: DiagramBlock,
    example: {
      v: 1,
      kind: 'diagram',
      engine: 'mermaid',
      source: 'flowchart TD\n  A[加热高锰酸钾] --> B[产生氧气] --> C[排水法收集]',
      alt: '实验室制取氧气的三步流程',
    },
  },
  figure: {
    schema: FigureBlockInput,
    example: {
      v: 1,
      kind: 'figure',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect x="10" y="10" width="40" height="60" fill="none" stroke="black"/><text x="30" y="45" text-anchor="middle" font-size="10">试管</text></svg>',
      alt: '加热固体的试管装置',
      long_desc: '试管口略向下倾斜，内装固体反应物，下方加热。',
    },
  },
  question_ref: {
    schema: QuestionRefBlock,
    example: {
      v: 1,
      kind: 'question_ref',
      question_ids: ['q_id'],
      display: 'inline',
      alt: '题目',
      label: '打开题目',
    },
  },
  chart: { schema: ChartBlock, example: { v: 1, kind: 'chart', chart: 'bar' } },
  interactive: {
    schema: InteractiveBlockInput,
    example: { v: 1, kind: 'interactive', title: '…' },
  },
};

function fieldLine(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: 'input' }) as {
    properties?: Record<string, unknown>;
  };
  const keys = json.properties ? Object.keys(json.properties).join(', ') : '';
  return keys ? `fields: ${keys}` : '';
}

function descriptionOf(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as { description?: string };
  return json.description ?? '';
}

/**
 * One catalogue per surface. Only implemented kinds get full lines; the rest
 * of the union stays listed as unavailable so the stored format stays forward
 * compatible without promising the model capabilities this build lacks.
 */
export function renderBlockCatalogue(surface: BlockSurface): string {
  const allowed = new Set(BLOCK_SURFACE_KINDS[surface]);
  const implemented = new Set(BLOCK_IMPLEMENTED_KINDS);
  const lines: string[] = [
    '【生成式积木】流程图/装置图须用 compose_block；勿手写 tlp-block、mermaid代码块或SVG/ASCII冒充图（页面只显示源码）。成功返ref/place；正文用 `![简短说明](block:<ref>)` 逐块放置；已放一个时，未放者隐藏。失败返回status=invalid和issues[]（code/path/line/expected），修正重提，勿重复原内容。',
  ];
  for (const kind of ['diagram', 'figure', 'chart', 'interactive', 'question_ref'] as const) {
    const meta = MEMBER_META[kind];
    if (!allowed.has(kind)) continue;
    if (!implemented.has(kind)) {
      lines.push(`- ${kind}：本版本尚未开放，不要调用。`);
      continue;
    }
    if (kind === 'question_ref') {
      lines.push(
        `- question_ref：仅id题卡；display=link|inline（inline单题），alt/label固定，禁caption。入参：${JSON.stringify({ block: meta.example })}`,
      );
      continue;
    }
    const description = descriptionOf(meta.schema);
    lines.push(
      `- ${kind}：${description}${fieldLine(meta.schema) ? `（${fieldLine(meta.schema)}）` : ''} 最小示例：${JSON.stringify(meta.example)}`,
    );
  }
  lines.push(
    '- 化学式/方程式：用行内数学 `$\\ce{…}$`，如 `$\\ce{2H2 + O2 -> 2H2O}$`、`$\\ce{CuSO4 * 5H2O}$`。',
  );
  lines.push(
    '- figure 的 images 是位图自检：先看图确认装置连接无误，再写 place；画错修 SVG 重提。',
  );
  return lines.join('\n');
}
