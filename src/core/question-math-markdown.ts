// YUK-1406 — producer 数学定界格式检查（确定性、只读、最小共享）。
//
// 2026-10-10 决策：producer 必须写显式数学定界，renderer 不猜裸公式的结束。
// 本模块是该契约背后最小的确定性检查：只会出现在数学模式里的显式 TeX 命令
// （分数/根式族）必须位于显式 math span（$…$ / $$…$$，legacy \(…\) / \[…\]）、
// 行内 code 或 code fence 之内；出现在其余 prose 里的即「裸命令」缺陷。
// 实证（2026-10-19 60 题 DTO，first-post.json）：
//   - cooygx01cb5iz5uqmln990lo（quiz_gen）选项 C/D 裸 \frac / \sqrt；
//   - ubm6yaiw98qdnpddjrjbnc78（web_sourced）选项 B 裸 \dfrac；
//   两题 prompt_md 内的 $…$ 均渲染正常 —— 缺陷恰好集中在未定界的选项正文。
//
// 边界（与 YUK-1406 首片一致，不扩张）：
//   - 只检测、不重写：绝不为裸串自动补 $，不求解，不全局重写数学。
//   - 不猜公式跨度：除显式定界与 code 外，一律按普通 prose 对待。
//   - 语法即渲染器语法：math/code span 位置来自渲染器自己的管线
//     （unified + remark-parse + remark-math，与 react-markdown 实际运行的
//     micromark 语法一致；先例：src/kernel/proposals/presentation.ts 的
//     rendererMathParser）。legacy \(…\) / \[…\] 不被 remark-math 识别，用镜像
//     自 src/ui/lib/math-markdown.tsx LATEX_DELIMITED 的正则按原文偏移保护
//     （keep in lockstep —— 渲染端正是按这套正则把它们改写成 $ 数学）。
//   - 调用方负责字段选择：只对会被渲染的 markdown 字段调用。source URL、
//     raw extract、opaque metadata、judge-only 判据等非渲染字段不得递归误检
//     （本模块不提供「整对象递归」入口，就是为了让字段清单显式留在调用方）。
//
// 首个 consumer：src/core/schema/quiz_gen.ts（QuizGenTask outputSchema）。
// 后续 sourcing 线（web_sourced 裸 dfrac 同缺陷族）由其独占 writer 自行接入，
// 不要复制第二份 validator。

import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * 明确的数学模式专属命令：在合法 LaTeX 里只可能出现在 math span 内，出现在
 * prose 里必然渲染破损（原样漏出反斜杠源码）。集合刻意收窄到分数/根式/二项
 * 族 —— 每个成员都是「不可能是普通散文词」的零误报命令；扩充集合时保持同一
 * 判据（数学模式专属 + 散文中不可能合法出现）。
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
  /** 裸命令名（不含反斜杠），如 'frac'。 */
  command: string;
  /** 命中点附近的短摘录（空白已折叠），供可执行错误文案使用。 */
  excerpt: string;
}

/** Minimal structural mdast view — only type/children/position are read（同 presentation.ts 先例）。 */
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

/** 收集受保护 span：inlineMath/math（数学）与 inlineCode/code（行内代码/fence）。 */
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
 * Mirror of LATEX_DELIMITED (src/ui/lib/math-markdown.tsx) — keep in lockstep
 * （presentation.ts 已有同一镜像先例；core 不得 import UI，故镜像）。
 * 组 1 = code（已由 AST span 覆盖，重复保护无害）；组 2/3 = legacy 显示/行内数学。
 */
const LEGACY_MATH_DELIMITED =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|(?<!\\)\\\[((?:(?!\n\s*\n)[^`])+?)\\\]|(?<!\\)\\\(((?:(?!\n\s*\n)[^`])+?)\\\)/g;

/** TeX 控制序列：反斜杠 + 字母串（前面的反斜杠转义过的 `\\frac` 不算命令）。 */
const TEX_COMMAND = /(?<!\\)\\([A-Za-z]+)/g;

function excerptAround(markdown: string, offset: number): string {
  const start = Math.max(0, offset - 16);
  const end = Math.min(markdown.length, offset + 24);
  const text = markdown.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

/**
 * 检测 markdown 里裸露的数学模式专属命令（$…$/$$…$$/\(…\)/\[…\] 与 code 之外）。
 * 纯函数、无 IO、不改输入。命中为空 = 该字段符合 producer 数学定界契约。
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
