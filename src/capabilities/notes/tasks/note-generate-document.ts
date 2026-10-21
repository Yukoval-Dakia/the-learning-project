import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { type NoteArtifactType, isNoteArtifactType } from '../server/note-artifact-types';

// NoteGenerate used to ask the model for TipTap JSON. Math notes write LaTeX
// (`\sqrt`, `\frac`, `\left`) inside those strings. JSON.parse rejects the
// illegal escapes and, for the legal ones (`\f` in `\frac`, `\t` in `\theta`),
// stores a control character instead of the command. The model therefore writes
// a NOTE v1 document; this compiler is the only reader of that document.
//
// Inline math is a linear scan. A regex whose alternatives both match `\`
// retries every split of an unclosed `$...` run (about 2^n), and that scan
// sits on the worker event loop, outside the task timeout.

type PmNode = Record<string, unknown>;

const SEMANTIC_KINDS = ['definition', 'mechanism', 'example', 'pitfall', 'check'] as const;
type SemanticKind = (typeof SEMANTIC_KINDS)[number];

const SECTION_NAMES = new Set<string>([...SEMANTIC_KINDS, 'body']);

type SectionDraft = { name: string; lines: string[] };

/**
 * Prose before the first @section. note_long / note_hub are one free body, so a
 * title and intro with no @body are that body. note_atomic has no free body.
 */
const LEADING_PROSE: Record<NoteArtifactType, 'body' | 'reject'> = {
  note_atomic: 'reject',
  note_long: 'body',
  note_hub: 'body',
};

function ensureSection(current: SectionDraft | null, declared: NoteArtifactType): SectionDraft {
  if (current) return current;
  if (LEADING_PROSE[declared] === 'body') return { name: 'body', lines: [] };
  fail('text before the first section');
}

const COMPLETE_STOP = new Set(['end_turn', 'stop']);
const CALLOUT_TONES = new Set(['note', 'tip', 'warning']);
const TRAILING_CHATTER = [
  '以上就是这篇',
  '以上就是本篇',
  '希望对你有帮助',
  '希望对你有用',
  '希望这对你',
  '如有问题',
  '如有疑问',
  '欢迎继续提问',
  '祝你学习',
  '祝学习进步',
];

function fail(message: string): never {
  throw new Error(`parseNoteGenerateOutput: ${message}`);
}

export function assertNoteGenerateStopReason(finishReason: string | undefined): void {
  if (finishReason === undefined || COMPLETE_STOP.has(finishReason)) return;
  fail(`model output stopped at ${finishReason}`);
}

function stripOuterFence(body: string): string {
  if (!body.startsWith('```')) return body;
  const firstBreak = body.indexOf('\n');
  if (firstBreak === -1 || !body.endsWith('```')) return body;
  const inner = body.slice(firstBreak + 1, -3).trim();
  if (inner.startsWith('NOTE v1\n') || inner === 'NOTE v1') return inner;
  return body;
}

function unwrapDocument(text: string): string {
  const body = stripOuterFence(
    text
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .trim(),
  );
  if (!body.startsWith('NOTE v1\n') && body !== 'NOTE v1') {
    fail('expected a NOTE v1 content document');
  }
  return body;
}

function parseLink(line: string): PmNode | null {
  const match = /^\[\[artifact:([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_-]+))?(?:\|([^\]]+))?\]\]$/.exec(
    line.trim(),
  );
  if (!match) return null;
  return {
    type: 'crossLinkBlock',
    attrs: {
      artifact_id: match[1],
      ...(match[2] ? { block_id: match[2] } : {}),
      ...(match[3]?.trim() ? { title: match[3].trim() } : {}),
    },
  };
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function isSafeHref(href: string): boolean {
  if (href.startsWith('//')) return false;
  if (href.startsWith('#') || href.startsWith('/')) return true;
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(href);
  if (!scheme) return !href.includes(':') && !href.includes('\\');
  const name = scheme[0].slice(0, -1).toLowerCase();
  return name === 'http' || name === 'https' || name === 'mailto';
}

function readWrapped(
  text: string,
  start: number,
  token: string,
): { body: string; end: number } | null {
  if (!text.startsWith(token, start)) return null;
  const close = text.indexOf(token, start + token.length);
  if (close === -1) return null;
  return { body: text.slice(start + token.length, close), end: close + token.length };
}

/** Href stops at whitespace and brackets, so a run of `[a](` is one forward pass. */
function readLink(
  text: string,
  start: number,
): { label: string; href: string; end: number } | null {
  if (text[start] !== '[') return null;
  let i = start + 1;
  const labelStart = i;
  while (i < text.length && text[i] !== ']') i += 1;
  if (i >= text.length || i === labelStart) return null;
  const label = text.slice(labelStart, i);
  i += 1;
  if (text[i] !== '(') return null;
  i += 1;
  const hrefStart = i;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === ')' || ch === '(' || ch === '[' || ch === ']' || /\s/.test(ch)) break;
    i += 1;
  }
  if (text[i] !== ')' || i === hrefStart) return null;
  return { label, href: text.slice(hrefStart, i), end: i + 1 };
}

function readItalic(text: string, start: number): { word: string; end: number } | null {
  if (text[start] !== '_' || text[start + 1] === '_' || isWordChar(text[start - 1])) return null;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '_' || /\s/.test(ch)) break;
    i += 1;
  }
  if (text[i] !== '_' || i === start + 1 || isWordChar(text[i + 1])) return null;
  return { word: text.slice(start + 1, i), end: i + 1 };
}

function parseMarks(text: string): PmNode[] {
  const out: PmNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf.length > 0) out.push({ type: 'text', text: buf });
    buf = '';
  };
  let skipBold = false;
  let skipStrike = false;
  let skipCode = false;
  let skipLinks = false;
  let i = 0;
  while (i < text.length) {
    if (!skipBold && text.startsWith('**', i)) {
      const wrapped = readWrapped(text, i, '**');
      if (!wrapped) {
        skipBold = true;
        buf += '*';
        i += 1;
        continue;
      }
      flush();
      out.push({ type: 'text', text: wrapped.body, marks: [{ type: 'bold' }] });
      i = wrapped.end;
      continue;
    }
    if (!skipStrike && text.startsWith('~~', i)) {
      const wrapped = readWrapped(text, i, '~~');
      if (!wrapped) {
        skipStrike = true;
        buf += '~';
        i += 1;
        continue;
      }
      flush();
      out.push({ type: 'text', text: wrapped.body, marks: [{ type: 'strike' }] });
      i = wrapped.end;
      continue;
    }
    if (!skipCode && text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        skipCode = true;
        buf += '`';
        i += 1;
        continue;
      }
      flush();
      out.push({ type: 'text', text: text.slice(i + 1, close), marks: [{ type: 'code' }] });
      i = close + 1;
      continue;
    }
    const italic = readItalic(text, i);
    if (italic) {
      flush();
      out.push({ type: 'text', text: italic.word, marks: [{ type: 'italic' }] });
      i = italic.end;
      continue;
    }
    if (!skipLinks && text[i] === '[') {
      if (text.indexOf(']', i + 1) === -1) {
        skipLinks = true;
      } else {
        const link = readLink(text, i);
        if (link && isSafeHref(link.href)) {
          flush();
          out.push({
            type: 'text',
            text: link.label,
            marks: [{ type: 'link', attrs: { href: link.href } }],
          });
          i = link.end;
          continue;
        }
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

function dollarPairCount(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '$' && line[i + 1] === '$') {
      count += 1;
      i += 1;
    }
  }
  return count;
}

function looksLikeMath(interior: string): boolean {
  if (interior.length === 0 || interior.includes('\n')) return false;
  if (interior.includes('\\')) return true;
  // Digit-led spans with a space or CJK punctuation are prices ("$5 and $10"),
  // not formulas. CJK units ("$v=米/秒$") stay math.
  if (/^\d/.test(interior) && /[\s\u3000-\u303f\uff00-\uffef]/.test(interior)) return false;
  return true;
}

/** One forward pass: an unclosed `$` advances one character, a backslash pair two. */
function parseInline(input: string): PmNode[] {
  const nodes: PmNode[] = [];
  let last = 0;
  let i = 0;
  while (i < input.length) {
    if (input[i] === '\\') {
      i += i + 1 < input.length ? 2 : 1;
      continue;
    }
    if (input[i] !== '$') {
      i += 1;
      continue;
    }
    const display = input[i + 1] === '$';
    const open = i;
    const opener = display ? 2 : 1;
    let j = i + opener;
    let close = -1;
    while (j < input.length) {
      if (input[j] === '\\') {
        j += j + 1 < input.length ? 2 : 1;
        continue;
      }
      if (!display && input[j] === '\n') break;
      if (input[j] === '$') {
        if (!display) {
          close = j + 1;
          break;
        }
        if (input[j + 1] === '$') {
          close = j + 2;
          break;
        }
      }
      j += 1;
    }
    const interior = close === -1 ? '' : input.slice(open + opener, close - opener);
    if (close === -1 || !looksLikeMath(interior)) {
      i = open + 1;
      continue;
    }
    if (open > last) nodes.push(...parseMarks(input.slice(last, open)));
    nodes.push({ type: 'text', text: input.slice(open, close) });
    last = close;
    i = close;
  }
  if (last < input.length) nodes.push(...parseMarks(input.slice(last)));
  return nodes.filter((node) => node.text !== '');
}

function paragraphFromLines(lines: string[]): PmNode | null {
  const content: PmNode[] = [];
  let started = false;
  let i = 0;
  while (i < lines.length) {
    const open = dollarPairCount(lines[i] ?? '');
    if (open % 2 === 1) {
      const span = [lines[i] ?? ''];
      let depth = 1;
      i += 1;
      while (i < lines.length && depth !== 0) {
        span.push(lines[i] ?? '');
        depth = (depth + dollarPairCount(lines[i] ?? '')) % 2;
        i += 1;
      }
      if (depth !== 0) fail('unclosed $$ math block');
      if (started) content.push({ type: 'hardBreak' });
      content.push({ type: 'text', text: span.join('\n') });
      started = true;
      continue;
    }
    if (started) content.push({ type: 'hardBreak' });
    content.push(...parseInline(lines[i] ?? ''));
    started = true;
    i += 1;
  }
  const kept = content.filter((node) => node.type === 'hardBreak' || node.text !== '');
  if (kept.every((node) => node.type === 'hardBreak')) return null;
  return { type: 'paragraph', content: kept };
}

function listMarker(line: string): { indent: number; ordered: boolean; text: string } | null {
  const match = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
  if (!match || match[3].trim().length === 0) return null;
  return { indent: match[1].length, ordered: /^\d/.test(match[2]), text: match[3] };
}

function compileList(lines: string[], start: number): { node: PmNode; next: number } {
  const first = listMarker(lines[start]);
  if (!first) fail('expected a list item');
  const items: PmNode[] = [];
  let i = start;
  while (i < lines.length) {
    if (lines[i].trim() === '') break;
    const marker = listMarker(lines[i]);
    if (!marker || marker.indent < first.indent || marker.ordered !== first.ordered) break;
    if (marker.indent > first.indent) {
      if (items.length === 0) fail('nested list has no parent item');
      const nested = compileList(lines, i);
      const parent = items[items.length - 1];
      parent.content = [...((parent.content as PmNode[] | undefined) ?? []), nested.node];
      i = nested.next;
      continue;
    }
    const content = parseInline(marker.text);
    items.push({
      type: 'listItem',
      content: [content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }],
    });
    i += 1;
  }
  if (items.length === 0) fail('empty list');
  return {
    node: {
      type: first.ordered ? 'orderedList' : 'bulletList',
      ...(first.ordered ? { attrs: { start: 1 } } : {}),
      content: items,
    },
    next: i,
  };
}

function isStructural(line: string): boolean {
  return (
    line.startsWith('```') ||
    line.trim() === '$$' ||
    /^#{1,6}\s+\S/.test(line) ||
    line.startsWith('>') ||
    listMarker(line) !== null ||
    parseLink(line) !== null
  );
}

function compileBlocks(src: string): PmNode[] {
  const lines = src.split('\n');
  const blocks: PmNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i += 1;
      continue;
    }
    if (lines[i].trim() === '$$') {
      const math = ['$$'];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        math.push(lines[i]);
        if (lines[i].trim() === '$$') {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) fail('unclosed $$ math block');
      blocks.push({ type: 'paragraph', content: [{ type: 'text', text: math.join('\n') }] });
      continue;
    }
    if (lines[i].startsWith('```')) {
      const language = lines[i].slice(3).trim();
      const code: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].startsWith('```')) {
          closed = true;
          i += 1;
          break;
        }
        code.push(lines[i]);
        i += 1;
      }
      if (!closed) fail('unclosed code fence');
      blocks.push({
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        ...(code.length > 0 ? { content: [{ type: 'text', text: code.join('\n') }] } : {}),
      });
      continue;
    }
    const heading = /^(#{1,6})\s+(\S.*)$/.exec(lines[i]);
    if (heading) {
      const content = parseInline(heading[2]);
      blocks.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        ...(content.length > 0 ? { content } : {}),
      });
      i += 1;
      continue;
    }
    const callout = /^>\s*\[!([A-Za-z]{1,20})\](?:\s+(.*))?$/.exec(lines[i]);
    if (callout) {
      const tone = callout[1].toLowerCase();
      if (!CALLOUT_TONES.has(tone)) fail(`unknown callout tone ${tone}`);
      const title = callout[2]?.trim() ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].startsWith('>')) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      const content = paragraphFromLines(body);
      if (!content && title.length === 0) fail('empty callout');
      blocks.push({
        type: 'calloutBlock',
        attrs: { tone, ...(title ? { title } : {}) },
        ...(content ? { content: [content] } : {}),
      });
      continue;
    }
    if (lines[i].startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      const content = paragraphFromLines(quoted);
      blocks.push({
        type: 'blockquote',
        content: [content ?? { type: 'paragraph' }],
      });
      continue;
    }
    const link = parseLink(lines[i]);
    if (link) {
      blocks.push(link);
      i += 1;
      continue;
    }
    if (listMarker(lines[i])) {
      const list = compileList(lines, i);
      blocks.push(list.node);
      i = list.next;
      continue;
    }
    const para: string[] = [];
    let depth = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (depth === 0 && (line.trim() === '' || isStructural(line))) break;
      para.push(line);
      depth = (depth + dollarPairCount(line)) % 2;
      i += 1;
    }
    if (depth !== 0) fail('unclosed $$ math block');
    const node = paragraphFromLines(para);
    if (node) blocks.push(node);
  }
  return blocks;
}

function isSemanticKind(name: string): name is SemanticKind {
  return (SEMANTIC_KINDS as readonly string[]).includes(name);
}

function isTrailingChatter(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (trimmed.includes('$') || trimmed.includes('\\')) return false;
  return TRAILING_CHATTER.some((phrase) => trimmed.includes(phrase));
}

/** Drop closing pleasantries that the model appends to the last section, above @end. */
function stripTrailingChatter(lines: string[]): string[] {
  const kept = [...lines];
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop();
  while (kept.length > 0 && isTrailingChatter(kept[kept.length - 1] ?? '')) {
    kept.pop();
    while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop();
  }
  return kept;
}

/** Compile one model-authored NOTE v1 document into a body the Notes owner materializes. */
export function compileNoteGenerateDocument(
  text: string,
  artifactType?: string,
): ArtifactBodyBlocksT {
  const document = unwrapDocument(text);
  const lines = document.split('\n');
  if (lines[0]?.trim() !== 'NOTE v1') fail('expected a NOTE v1 content document');
  let cursor = 1;
  while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
  const typeMatch = /^@type (note_atomic|note_long|note_hub)$/.exec(lines[cursor]?.trim() ?? '');
  if (!typeMatch) fail('missing @type note_atomic, note_long, or note_hub');
  const declared = typeMatch[1] as NoteArtifactType;
  if (artifactType !== undefined) {
    if (!isNoteArtifactType(artifactType)) fail(`unsupported artifact type ${artifactType}`);
    if (declared !== artifactType) {
      fail(`@type ${declared} does not match artifact type ${artifactType}`);
    }
  }
  cursor += 1;

  const sections: Array<{ name: string; body: string }> = [];
  let current: SectionDraft | null = null;
  let ended = false;
  let inFence = false;
  let inDisplay = false;
  for (let i = cursor; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (inFence) {
      current = ensureSection(current, declared);
      current.lines.push(line);
      if (trimmed.startsWith('```')) inFence = false;
      continue;
    }
    if (trimmed.startsWith('```')) {
      current = ensureSection(current, declared);
      inFence = true;
      current.lines.push(line);
      continue;
    }
    const dollars = dollarPairCount(line);
    if (inDisplay) {
      current = ensureSection(current, declared);
      current.lines.push(line);
      if (dollars % 2 === 1) inDisplay = false;
      continue;
    }
    if (dollars % 2 === 1) {
      current = ensureSection(current, declared);
      inDisplay = true;
      current.lines.push(line);
      continue;
    }
    const header = /^@([A-Za-z_]+)\s*$/.exec(trimmed);
    if (header) {
      if (header[1] === 'end') {
        if (ended) fail('text after @end');
        if (current) {
          sections.push({
            name: current.name,
            body: stripTrailingChatter(current.lines).join('\n'),
          });
        }
        current = null;
        ended = true;
        continue;
      }
      if (ended) fail('text after @end');
      if (!SECTION_NAMES.has(header[1])) fail(`unknown section @${header[1]}`);
      if (current) sections.push({ name: current.name, body: current.lines.join('\n') });
      current = { name: header[1], lines: [] };
      continue;
    }
    if (ended) {
      if (trimmed === '') continue;
      fail('text after @end');
    }
    if (!current) {
      if (trimmed === '') continue;
      current = ensureSection(current, declared);
    }
    current.lines.push(line);
  }
  if (!ended) fail('missing @end');
  if (sections.length === 0) fail('document has no sections');
  if (declared === 'note_atomic' && sections.some((section) => section.name === 'body')) {
    fail('note_atomic cannot use @body');
  }
  if (declared === 'note_atomic') {
    const found = new Set(sections.map((section) => section.name));
    const missing = SEMANTIC_KINDS.filter((kind) => !found.has(kind));
    if (missing.length > 0) fail(`note_atomic missing ${missing.join(', ')}`);
  }

  const content: PmNode[] = [];
  for (const section of sections) {
    const blocks = compileBlocks(section.body);
    if (blocks.length === 0) fail(`empty @${section.name}`);
    if (section.name === 'body') {
      content.push(...blocks);
      continue;
    }
    if (!isSemanticKind(section.name)) fail(`unknown section @${section.name}`);
    content.push({
      type: 'semanticBlock',
      attrs: { semantic_kind: section.name },
      content: blocks,
    });
  }
  if (content.length === 0) fail('document has no blocks');
  return { type: 'doc', content };
}
