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

// YUK-1763 — the assessed interactive artifact answer-key boundary. The answer
// key never ships to the browser: authoring rejects answer-bearing attributes,
// and the serve path strips any that legacy stored HTML still carries.

const ANSWER_ATTRIBUTE_NAME = 'data-copilot-answer';

function tagAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match?.[1] ?? match?.[2];
}

/** Question bindings in assessed artifact HTML: data-copilot-question-id (+ any legacy answer). */
export function assessmentBindings(
  html: string,
): Array<{ id: string; answer: string | undefined }> {
  return (html.match(/<[^>]*\bdata-copilot-question-id\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi) ?? [])
    .map((tag) => ({
      id: tagAttribute(tag, 'data-copilot-question-id') ?? '',
      answer: tagAttribute(tag, ANSWER_ATTRIBUTE_NAME),
    }))
    .filter((binding) => binding.id.length > 0);
}

/** True when the HTML carries any answer-key attribute. Assessed authoring rejects this. */
export function containsAnswerKeyAttributes(html: string): boolean {
  return /\bdata-(?:copilot-answer|answer|correct)\s*=/.test(html);
}

/** Remove data-copilot-answer attributes from stored HTML at serve time (legacy rows). */
export function stripInteractiveAnswerAttributes(html: string): string {
  return html.replace(/\sdata-copilot-answer\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}
