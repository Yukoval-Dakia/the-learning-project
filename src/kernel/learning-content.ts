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

// YUK-1763 — the interactive artifact answer-key serve boundary. The
// artifact-authoring tools wrote answers into stored HTML (`data-copilot-answer`)
// and into tool-call payloads (html + content_validation manifest); those tools
// are being removed from the Copilot surface (YUK-1769), so the invariant lives
// at every serve seam: nothing browser-facing may carry an answer key.

/** Tool names whose args carry interactive-artifact HTML and the answer manifest. */
export const INTERACTIVE_ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'author_artifact',
  'update_artifact',
]);

const ANSWER_KEY_ATTRIBUTE_PATTERN =
  /\sdata-(?:copilot-)?answer\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)|\sdata-correct\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Remove answer-key attributes from stored interactive HTML at serve time.
 * Covers `data-copilot-answer`, `data-answer` and `data-correct` with any
 * attribute-name casing and double/single/unquoted values; adjacent names like
 * `data-answers=` or `data-correct-format=` do not match (a value must follow
 * the exact name). Question bindings (`data-copilot-question-id`) stay.
 */
export function stripInteractiveAnswerAttributes(html: string): string {
  return html.replace(ANSWER_KEY_ATTRIBUTE_PATTERN, '');
}

/**
 * Redact an artifact-authoring tool's args at browser-facing seams: strip
 * answer attributes from the HTML and drop the answer manifest wholesale
 * (reference_md IS the answer key). Server-side storage is untouched — only
 * the served projection changes.
 */
export function redactInteractiveArtifactToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...input };
  if (typeof redacted.html === 'string') {
    redacted.html = stripInteractiveAnswerAttributes(redacted.html);
  }
  if (redacted.content_validation !== undefined) {
    redacted.content_validation = { redacted: 'answer_manifest' };
  }
  return redacted;
}
