import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { type NoteArtifactType, isNoteArtifactType } from '../server/note-artifact-types';

// NoteGenerate used to ask the model for TipTap JSON. Math notes write LaTeX
// (`\sqrt`, `\frac`, `\left`) inside those strings. JSON.parse rejects the
// illegal escapes and, for the legal ones (`\f` in `\frac`, `\t` in `\theta`),
// stores a control character instead of the command. The model therefore writes
// a NOTE v1 document; this compiler is the only reader of that document.

type PmNode = Record<string, unknown>;

const SEMANTIC_KINDS = ['definition', 'mechanism', 'example', 'pitfall', 'check'] as const;
type SemanticKind = (typeof SEMANTIC_KINDS)[number];

const SECTION_NAMES = new Set<string>([...SEMANTIC_KINDS, 'body']);

function fail(message: string): never {
  throw new Error(`parseNoteGenerateOutput: ${message}`);
}

function unwrapDocument(text: string): string {
  let body = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const fenced = /^```(?:markdown|md|text)?[^\n]*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced?.[1]?.includes('\nNOTE v1\n') || fenced?.[1]?.startsWith('NOTE v1\n')) {
    body = fenced[1].trim();
  }
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'NOTE v1');
  if (start === -1) fail('expected a NOTE v1 content document');
  if (start > 30) fail('NOTE v1 header is not at the start of the document');
  return lines.slice(start).join('\n').trim();
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

function parseMarks(text: string): PmNode[] {
  const out: PmNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf.length > 0) out.push({ type: 'text', text: buf });
    buf = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const two = text.slice(i, i + 2);
    const wrapped = two === '**' ? 'bold' : two === '~~' ? 'strike' : null;
    if (wrapped) {
      const close = text.indexOf(two, i + 2);
      if (close === -1) {
        buf += two;
        i += 1;
        continue;
      }
      flush();
      out.push({ type: 'text', text: text.slice(i + 2, close), marks: [{ type: wrapped }] });
      i = close + 1;
      continue;
    }
    if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        buf += '`';
        continue;
      }
      flush();
      out.push({ type: 'text', text: text.slice(i + 1, close), marks: [{ type: 'code' }] });
      i = close;
      continue;
    }
    if (text[i] === '_' && text[i + 1] !== '_') {
      const italic = /^_([^_\s]+)_/.exec(text.slice(i));
      if (italic) {
        flush();
        out.push({ type: 'text', text: italic[1], marks: [{ type: 'italic' }] });
        i += italic[0].length - 1;
        continue;
      }
    }
    if (text[i] === '[') {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (link) {
        flush();
        out.push({
          type: 'text',
          text: link[1],
          marks: [{ type: 'link', attrs: { href: link[2] } }],
        });
        i += link[0].length - 1;
        continue;
      }
    }
    buf += text[i];
  }
  flush();
  return out;
}

function parseInline(input: string): PmNode[] {
  const nodes: PmNode[] = [];
  const math = /\$\$(?:\\.|[^$])+?\$\$|\$(?:\\.|[^$\n])+?\$/g;
  let last = 0;
  for (const match of input.matchAll(math)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(...parseMarks(input.slice(last, index)));
    nodes.push({ type: 'text', text: match[0] });
    last = index + match[0].length;
  }
  if (last < input.length) nodes.push(...parseMarks(input.slice(last)));
  return nodes.filter((node) => node.text !== '');
}

function paragraph(text: string): PmNode | null {
  const content = parseInline(text);
  if (content.length === 0) return null;
  return { type: 'paragraph', content };
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
    if (lines[i].startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      const content = parseInline(quoted.join('\n'));
      blocks.push({
        type: 'blockquote',
        content: [content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }],
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
    while (i < lines.length && lines[i].trim() !== '' && !isStructural(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    const node = paragraph(para.join('\n'));
    if (node) blocks.push(node);
  }
  return blocks;
}

function isSemanticKind(name: string): name is SemanticKind {
  return (SEMANTIC_KINDS as readonly string[]).includes(name);
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
  let current: { name: string; lines: string[] } | null = null;
  for (let i = cursor; i < lines.length; i += 1) {
    const header = /^@([A-Za-z_]+)\s*$/.exec(lines[i].trim());
    if (header) {
      if (!SECTION_NAMES.has(header[1])) fail(`unknown section @${header[1]}`);
      if (current) sections.push({ name: current.name, body: current.lines.join('\n') });
      current = { name: header[1], lines: [] };
      continue;
    }
    if (!current) {
      if (lines[i].trim() === '') continue;
      fail('text before the first section');
    }
    current.lines.push(lines[i]);
  }
  if (current) sections.push({ name: current.name, body: current.lines.join('\n') });
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
