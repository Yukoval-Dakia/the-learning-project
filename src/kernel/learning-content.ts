import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5';

const BLOCK_TAGS = new Set<string>([
  'article',
  'aside',
  'br',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'section',
  'table',
  'tr',
] as const);
const NON_VISIBLE_TAGS = new Set<string>(['script', 'style', 'template'] as const);

function appendVisibleText(node: DefaultTreeAdapterTypes.Node, chunks: string[]): void {
  if ('value' in node) {
    chunks.push(node.value);
    return;
  }
  if ('tagName' in node) {
    if (NON_VISIBLE_TAGS.has(node.tagName)) return;
    const isBlock = BLOCK_TAGS.has(node.tagName);
    if (isBlock) chunks.push('\n');
    for (const child of node.childNodes) appendVisibleText(child, chunks);
    if (isBlock) chunks.push('\n');
    return;
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) appendVisibleText(child, chunks);
  }
}

export function extractVisibleHtmlText(html: string): string {
  const chunks: string[] = [];
  appendVisibleText(parseFragment(html), chunks);
  return chunks
    .join('')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function htmlContainsAssessment(html: string): boolean {
  const structuralMarker =
    /(?:data-(?:copilot-question-id|copilot-answer|answer|correct)|\b(?:quiz|question|exercise)\b)/i;
  const visibleMarker = /(?:\b(?:quiz|question|exercise)\b|题目|练习题|测验|作答|答案)/i;
  return structuralMarker.test(html) || visibleMarker.test(extractVisibleHtmlText(html));
}
