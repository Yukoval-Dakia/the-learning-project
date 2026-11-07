// YUK-1548 (§4.1) — model instructions generated from the block schemas so
// prose and validator cannot drift. Consumers: the Copilot prompt (slice 1),
// the note-generation prompt (slice 2), the ingestion prompt (slice 3).

import { z } from 'zod';
import {
  type BlockKind,
  DiagramBlock,
  DrawingBlockInput,
  FigureBlockInput,
  InteractiveBlockInput,
  QuestionRefBlock,
} from './block';
import { BLOCK_IMPLEMENTED_KINDS, BLOCK_SURFACE_KINDS, type BlockSurface } from './surfaces';

// Field lists are generated from the MODEL-FACING input schemas so the
// catalogue matches what compose_block actually accepts (figure `svg`,
// interactive `html`), never the asset-only stored form.
// entity_card and chart use compact prose lines below instead of generated
// examples: the catalogue is at its 12,000-char budget.
const MEMBER_META: Record<
  Exclude<BlockKind, 'entity_card' | 'chart'>,
  { schema: z.ZodType; example: unknown }
> = {
  diagram: {
    schema: DiagramBlock,
    example: {
      v: 1,
      kind: 'diagram',
      engine: 'mermaid',
      source: 'flowchart TD\n  A-->B',
      alt: '实验室制取氧气的三步流程',
    },
  },
  figure: {
    schema: FigureBlockInput,
    example: {
      v: 1,
      kind: 'figure',
      svg: '<svg viewBox="0 0 120 80"><rect x="10" y="10" width="40" height="60"/></svg>',
      alt: '加热固体的试管装置',
    },
  },
  drawing: {
    schema: DrawingBlockInput,
    example: {
      v: 1,
      kind: 'drawing',
      brief: '滴定实验装置：铁架台固定酸式滴定管，下置锥形瓶，瓶内指示剂变色',
      alt: '酸碱滴定装置示意',
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
  for (const kind of [
    'diagram',
    'drawing',
    'interactive',
    'question_ref',
    'entity_card',
    'chart',
  ] as const) {
    if (!allowed.has(kind)) continue;
    if (!implemented.has(kind)) {
      lines.push(`- ${kind}：本版本尚未开放，不要调用。`);
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
      continue;
    }
    const meta = MEMBER_META[kind];
    if (kind === 'question_ref') {
      lines.push(
        `- question_ref：仅id题卡；display=link|inline（inline单题，每回复最多3张，其余display=link），alt/label固定，禁caption。入参：${JSON.stringify({ block: meta.example })}`,
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
    '- drawing 返回即占位：图在后台绘制，勿等待或改写；无法核验来源时返回 unavailable，如实告诉学习者不能画。',
  );
  return lines.join('\n');
}
