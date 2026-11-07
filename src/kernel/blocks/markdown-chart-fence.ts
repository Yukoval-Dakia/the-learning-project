// A note write has no tool-result binding step, so a `tlp-block` chart that
// claims recorded data would render 来自记录 over model numbers. The write seam
// rewrites only the binding fields and leaves every other byte of the fence.

import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { TLP_BLOCK_FENCE_INFO, parseBlockFence } from '@/core/schema/blocks/fence';

interface MarkdownNode {
  type?: string;
  lang?: string | null;
  value?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: MarkdownNode[];
}

interface JsonProperty {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

const parser = unified().use(remarkParse);
const MODEL_DATA_SOURCE = '{"kind":"model"}';

function isJsonWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function skipJsonWhitespace(json: string, index: number): number {
  let i = index;
  while (i < json.length && isJsonWhitespace(json[i])) i += 1;
  return i;
}

function scanJsonString(json: string, index: number): number {
  let i = index + 1;
  while (i < json.length) {
    if (json[i] === '\\') {
      i += 2;
      continue;
    }
    if (json[i] === '"') return i + 1;
    i += 1;
  }
  return -1;
}

function scanJsonValue(json: string, index: number): number {
  const char = json[index];
  if (char === '"') return scanJsonString(json, index);
  if (char === '{' || char === '[') {
    const close = char === '{' ? '}' : ']';
    let i = skipJsonWhitespace(json, index + 1);
    if (json[i] === close) return i + 1;
    while (i < json.length) {
      i = skipJsonWhitespace(json, i);
      if (char === '{') {
        const keyEnd = scanJsonString(json, i);
        if (keyEnd < 0) return -1;
        i = skipJsonWhitespace(json, keyEnd);
        if (json[i] !== ':') return -1;
        i = skipJsonWhitespace(json, i + 1);
      }
      i = scanJsonValue(json, i);
      if (i < 0) return -1;
      i = skipJsonWhitespace(json, i);
      if (json[i] === ',') {
        i += 1;
        continue;
      }
      if (json[i] === close) return i + 1;
      return -1;
    }
    return -1;
  }
  let i = index;
  while (
    i < json.length &&
    !isJsonWhitespace(json[i]) &&
    json[i] !== ',' &&
    json[i] !== ']' &&
    json[i] !== '}'
  ) {
    i += 1;
  }
  return i > index ? i : -1;
}

function topLevelProperties(json: string): JsonProperty[] | null {
  let i = skipJsonWhitespace(json, 0);
  if (json[i] !== '{') return null;
  i = skipJsonWhitespace(json, i + 1);
  const properties: JsonProperty[] = [];
  if (json[i] === '}') return properties;
  while (i < json.length) {
    i = skipJsonWhitespace(json, i);
    const keyStart = i;
    const keyEnd = scanJsonString(json, i);
    if (keyEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(json.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    if (typeof key !== 'string') return null;
    i = skipJsonWhitespace(json, keyEnd);
    if (json[i] !== ':') return null;
    i = skipJsonWhitespace(json, i + 1);
    const valueStart = i;
    const valueEnd = scanJsonValue(json, i);
    if (valueEnd < 0) return null;
    properties.push({ key, keyStart, valueStart, valueEnd });
    i = skipJsonWhitespace(json, valueEnd);
    if (json[i] === ',') {
      i += 1;
      continue;
    }
    if (json[i] === '}') {
      return skipJsonWhitespace(json, i + 1) === json.length ? properties : null;
    }
    return null;
  }
  return null;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Rewrite one fence body when it is a chart claiming recorded data. Only the
 * top-level `data_source` value and `caption` property are touched; all other
 * JSON bytes (key order, number spelling, escapes, whitespace) stay as written.
 */
export function downgradeUnboundChartFenceBody(body: string): string | null {
  const block = parseBlockFence(body);
  if (block?.kind !== 'chart' || block.data_source.kind !== 'tool_result') return null;
  const properties = topLevelProperties(body);
  if (!properties) throw new Error('chart fence body is not a readable JSON object');
  let dataSource: JsonProperty | undefined;
  for (const property of properties) {
    if (property.key === 'data_source') dataSource = property;
  }
  if (!dataSource) throw new Error('chart fence body has no data_source property');
  const removals: Array<[number, number]> = [];
  properties.forEach((property, index) => {
    if (property.key !== 'caption') return;
    if (index > 0) {
      // Drop the preceding comma and the caption property itself.
      removals.push([properties[index - 1]?.valueEnd ?? property.keyStart, property.valueEnd]);
      return;
    }
    // First property: drop it and the comma that follows it.
    let after = skipJsonWhitespace(body, property.valueEnd);
    if (body[after] === ',') after += 1;
    removals.push([property.keyStart, after]);
  });
  const edits = mergeRanges(removals).map(([start, end]) => ({ start, end, text: '' }));
  edits.push({ start: dataSource.valueStart, end: dataSource.valueEnd, text: MODEL_DATA_SOURCE });
  edits.sort((a, b) => b.start - a.start);
  let output = body;
  for (const edit of edits) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  const rewritten = parseBlockFence(output);
  if (
    rewritten?.kind !== 'chart' ||
    rewritten.data_source.kind !== 'model' ||
    rewritten.caption !== undefined
  ) {
    throw new Error('chart fence downgrade did not produce a model chart without caption');
  }
  return output;
}

interface RawLine {
  text: string;
  ending: string;
}

function splitRawLines(raw: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  let i = 0;
  while (i < raw.length) {
    const char = raw[i];
    if (char === '\r' || char === '\n') {
      const ending = char === '\r' && raw[i + 1] === '\n' ? '\r\n' : char;
      lines.push({ text: raw.slice(start, i), ending });
      i += ending.length;
      start = i;
      continue;
    }
    i += 1;
  }
  lines.push({ text: raw.slice(start), ending: '' });
  return lines;
}

function rewriteFence(raw: string, cleanBody: string): string | null {
  const downgraded = downgradeUnboundChartFenceBody(cleanBody);
  if (downgraded === null) return null;
  const lines = splitRawLines(raw);
  const open = lines[0];
  if (!open || open.ending === '') return null;
  let closingIndex = lines.length - 1;
  if (closingIndex > 0 && lines[closingIndex]?.text === '' && lines[closingIndex]?.ending === '') {
    closingIndex -= 1;
  }
  const closingMatch = /^([ \t>]*)(?:`{3,}|~{3,})[ \t]*$/.exec(lines[closingIndex]?.text ?? '');
  const closing = closingMatch ? (lines[closingIndex] as RawLine) : null;
  const bodyLines = lines.slice(1, closing ? closingIndex : lines.length);
  const continuation = closingMatch?.[1] ?? /^([ \t>]*)/.exec(bodyLines[0]?.text ?? '')?.[1] ?? '';
  const ending = bodyLines[0]?.ending || open.ending;
  const payload = downgraded
    .replace(/\r\n|\r|\n/g, ending)
    .split(ending)
    .map((line) => `${continuation}${line}`)
    .join(ending);
  const beforeClosing = bodyLines.at(-1)?.ending ?? open.ending;
  const tail = closing ? `${beforeClosing}${closing.text}${closing.ending}` : beforeClosing;
  return `${open.text}${open.ending}${payload}${tail}`;
}

function collectCodeNodes(node: MarkdownNode, found: MarkdownNode[]): void {
  if (node.type === 'code') found.push(node);
  for (const child of node.children ?? []) collectCodeNodes(child, found);
}

/** Downgrade every unbound recorded-data chart fence, leaving all other bytes as written. */
export function downgradeUnboundChartFences(markdown: string): string {
  let tree: MarkdownNode;
  try {
    tree = parser.parse(markdown) as unknown as MarkdownNode;
  } catch {
    return markdown;
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const codeNodes: MarkdownNode[] = [];
  collectCodeNodes(tree, codeNodes);
  for (const node of codeNodes) {
    // `node.lang` is the decoded first info word, the same value ReactMarkdown
    // turns into `language-<lang>` before BlockFenceView sees it.
    if (node.lang !== TLP_BLOCK_FENCE_INFO) continue;
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    const replacement = rewriteFence(markdown.slice(start, end), node.value ?? '');
    if (replacement !== null) edits.push({ start, end, text: replacement });
  }
  if (edits.length === 0) return markdown;
  edits.sort((a, b) => b.start - a.start);
  let output = markdown;
  for (const edit of edits) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return output;
}
