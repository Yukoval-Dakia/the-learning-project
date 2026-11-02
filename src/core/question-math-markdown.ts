// Producer 数学定界契约的确定性检查：renderer 不猜裸公式的结束，producer 必须写显式
// 定界，所以数学模式专属命令（分数/根式族）出现在 math span / code 之外就是缺陷。
//
// 只检测不重写，不猜公式跨度；math/code span 位置取渲染器同一管线（unified +
// remark-parse + remark-math）。legacy \(…\) / \[…\] 按 src/ui/lib/math-markdown.tsx
// 的 LATEX_DELIMITED 镜像保护（core 不得 import UI，两处须同步）。
// 字段选择留给调用方：source URL、raw extract、judge-only 判据等非渲染字段不得递归误检。

import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * 数学模式专属命令：合法 LaTeX 里只可能出现在 math span 内，落在 prose 里必然漏出
 * 反斜杠源码。集合刻意收窄到分数/根式/二项族，每个成员都「不可能是散文词」；
 * 扩充时保持同一判据，避免误报。
 */
export const BARE_MATH_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'frac',
  'dfrac',
  'tfrac',
  'cfrac',
  'sqrt',
  'binom',
]);

/** 一处裸命令缺陷。 */
export interface BareMathCommandIssue {
  /** 裸命令名（不含反斜杠）。 */
  command: string;
  /** 命中点附近的短摘录（空白已折叠），供可执行错误文案使用。 */
  excerpt: string;
}

/** mdast 最小结构视图：只读 type/children/position。 */
interface MathAstNode {
  type: string;
  children?: MathAstNode[] | undefined;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
}

let mathSpanParser: { parse(text: string): unknown } | null = null;

/** 渲染器的 markdown→math 管线（remark-math 默认配置：单 `$` 开启）。 */
function rendererMathParser(): { parse(text: string): unknown } {
  mathSpanParser ??= unified().use(remarkParse).use(remarkMath) as unknown as {
    parse(text: string): unknown;
  };
  return mathSpanParser;
}

function collectProtectedSpans(node: MathAstNode, spans: Array<[number, number]>): void {
  if (
    node.type === 'inlineMath' ||
    node.type === 'math' ||
    node.type === 'inlineCode' ||
    node.type === 'code'
  ) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start === 'number' && typeof end === 'number' && start < end) {
      spans.push([start, end]);
    }
  }
  for (const child of node.children ?? []) collectProtectedSpans(child, spans);
}

/**
 * Mirror of LATEX_DELIMITED (src/ui/lib/math-markdown.tsx) — core 不得 import UI，
 * 渲染端按这套正则把 legacy 数学改写成 $，两处须同步。
 * 组 1 = code（已由 AST span 覆盖，重复保护无害）；组 2/3 = legacy 显示/行内数学。
 */
const LEGACY_MATH_DELIMITED =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;

/** TeX 控制序列；`\\frac` 这种转义反斜杠不算命令。 */
const TEX_COMMAND = /(?<!\\)\\([A-Za-z]+)/g;

function excerptAround(markdown: string, offset: number): string {
  const start = Math.max(0, offset - 16);
  const end = Math.min(markdown.length, offset + 24);
  const text = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/**
 * 检测 markdown 里裸露的数学模式专属命令（显式 math span / code 之外）。纯函数、无 IO。
 * 命中为空 = 该字段符合 producer 数学定界契约。
 */
export function findBareMathCommands(markdown: string): BareMathCommandIssue[] {
  if (!markdown.includes('\\')) return [];
  const protectedSpans: Array<[number, number]> = [];
  try {
    collectProtectedSpans(rendererMathParser().parse(markdown) as MathAstNode, protectedSpans);
  } catch {
    // 解析失败（畸形 markdown）不误报：显式定界语法本身无法确认时保持沉默，
    // 交由渲染层如实呈现；本检查只对「能确认的裸命令」发声。
    return [];
  }
  for (const match of markdown.matchAll(LEGACY_MATH_DELIMITED)) {
    const start = match.index;
    if (start != null) protectedSpans.push([start, start + match[0].length]);
  }
  protectedSpans.sort((a, b) => a[0] - b[0]);

  const issues: BareMathCommandIssue[] = [];
  for (const match of markdown.matchAll(TEX_COMMAND)) {
    const command = match[1];
    const offset = match.index;
    if (command == null || offset == null) continue;
    if (!BARE_MATH_COMMAND_NAMES.has(command)) continue;
    const insideProtected = protectedSpans.some(([start, end]) => offset >= start && offset < end);
    if (insideProtected) continue;
    issues.push({ command, excerpt: excerptAround(markdown, offset) });
  }
  return issues;
}
