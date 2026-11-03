// YUK-1548 (§3.2/D4) — figure sanitisation by allowlist REBUILD, not removal.
// The source SVG is parsed with a strict XML parser and re-serialised from a
// fixed element/attribute allowlist. Anything outside the allowlist is a typed
// issue returned to the model — never silently dropped. Output feeds a
// write-once svf_ asset shown through <img> (inert even on a sanitiser bug).

import { SaxesParser } from 'saxes';
import type { BlockIssueT } from '@/core/schema/blocks';

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'symbol',
  'use',
]);

const ALLOWED_ATTRIBUTES = new Set([
  // geometry / layout
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'refX',
  'refY',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'orient',
  'dx',
  'dy',
  'rotate',
  'textLength',
  'lengthAdjust',
  'offset',
  'gradientTransform',
  'gradientUnits',
  'spreadMethod',
  'clipPathUnits',
  'patternUnits',
  'patternContentUnits',
  'patternTransform',
  // presentation
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'letter-spacing',
  'word-spacing',
  'marker-start',
  'marker-mid',
  'marker-end',
  'stop-color',
  'stop-opacity',
  'clip-path',
  'mask',
  'vector-effect',
  'visibility',
  'display',
  'transform',
  'color',
  'paint-order',
  'overflow',
  'text-decoration',
  // identity / reference
  'id',
  'class',
]);

const MAX_ELEMENTS = 5_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const SYSTEM_FONT_STACK =
  '-apple-system, "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(text: string): string {
  return esc(text).replace(/"/g, '&quot;');
}

export type SvgRebuildResult = { ok: true; svg: string } | { ok: false; issues: BlockIssueT[] };

function issueAt(parser: SaxesParser, partial: Omit<BlockIssueT, 'path'>): BlockIssueT {
  return {
    path: '/svg',
    line: parser.line,
    column: parser.column + 1,
    ...partial,
  };
}

/**
 * Parse + rebuild the figure. A single pass collects up to 12 issues so the
 * model sees the full repair list; any issue means nothing is emitted.
 */
export function rebuildSvgFigure(source: string): SvgRebuildResult {
  const issues: BlockIssueT[] = [];
  const out: string[] = [];
  let elements = 0;
  let rootSawViewBox = false;
  let depth = 0;
  let rootClosed = false;

  const parser = new SaxesParser({ xmlns: true, position: true });

  parser.on('error', (err) => {
    issues.push({
      code: 'svg_parse_error',
      path: '/svg',
      line: parser.line,
      column: parser.column + 1,
      detail: `SVG is not well-formed XML: ${err.message.split('\n')[0]}`,
    });
  });

  parser.on('doctype', () => {
    issues.push(
      issueAt(parser, {
        code: 'svg_parse_error',
        detail: 'DOCTYPE is not allowed; submit a bare <svg> document',
      }),
    );
  });

  parser.on('processinginstruction', () => {
    issues.push(
      issueAt(parser, {
        code: 'svg_element_forbidden',
        detail: 'processing instructions are not allowed in figures',
      }),
    );
  });

  parser.on('opentag', (tag) => {
    const name = tag.name;
    if (depth === 0 && rootClosed) {
      issues.push(
        issueAt(parser, {
          code: 'svg_parse_error',
          detail: 'content after the root </svg> is not allowed',
        }),
      );
      return;
    }
    depth += 1;
    elements += 1;
    if (elements > MAX_ELEMENTS) {
      issues.push(
        issueAt(parser, {
          code: 'svg_too_complex',
          detail: `figure exceeds the ${MAX_ELEMENTS}-element limit`,
        }),
      );
      return;
    }
    const local = tag.local || name;
    if (!ALLOWED_ELEMENTS.has(local)) {
      issues.push(
        issueAt(parser, {
          code: 'svg_element_forbidden',
          detail: `<${local}> is not allowed; draw with the allowlisted SVG elements`,
          expected: [...ALLOWED_ELEMENTS].slice(0, 12),
        }),
      );
      return; // element and its children are dropped by skipping output below
    }
    if (depth === 1 && local === 'svg') {
      rootSawViewBox = tag.attributes.viewBox !== undefined || 'viewBox' in tag.attributes;
    }
    const attrs: string[] = [];
    let elementRejected = false;
    for (const [attrKey, attrVal] of Object.entries(tag.attributes)) {
      const attr = attrVal as { name?: string; local?: string; uri?: string; value: string };
      const attrName = attr.name ?? attrKey;
      const attrLocal = attr.local ?? attrName;
      const value = String(attr.value ?? '');
      if (/^on/i.test(attrLocal)) {
        issues.push(
          issueAt(parser, {
            code: 'svg_attribute_forbidden',
            detail: `event handler attribute '${attrName}' is not allowed`,
          }),
        );
        elementRejected = true;
        continue;
      }
      if (attrName === 'xmlns' || attr.uri === 'http://www.w3.org/2000/xmlns/') {
        // serialised explicitly on the root element below
        continue;
      }
      const isHref =
        attrLocal === 'href' &&
        (attr.uri === XLINK_NS || attr.uri === '' || attr.uri === undefined || !attr.uri);
      if (isHref || attrName === 'xlink:href') {
        if (!/^#[A-Za-z_][\w:.-]*$/.test(value)) {
          issues.push(
            issueAt(parser, {
              code: 'svg_external_reference',
              detail: `href must reference a local '#id', got '${value.slice(0, 80)}'`,
            }),
          );
          elementRejected = true;
          continue;
        }
        attrs.push(`xlink:href="${escAttr(value)}"`);
        continue;
      }
      if (!ALLOWED_ATTRIBUTES.has(attrLocal)) {
        issues.push(
          issueAt(parser, {
            code: 'svg_attribute_forbidden',
            detail: `attribute '${attrName}' is not allowed`,
          }),
        );
        elementRejected = true;
        continue;
      }
      if (/url\(/i.test(value) && !/^\s*url\(#[A-Za-z_][\w:.-]*\)\s*$/i.test(value)) {
        issues.push(
          issueAt(parser, {
            code: 'svg_external_reference',
            detail: `attribute '${attrName}' must reference local 'url(#id)' only`,
          }),
        );
        elementRejected = true;
        continue;
      }
      if (attrLocal === 'font-family') {
        attrs.push(`font-family="${escAttr(SYSTEM_FONT_STACK)}"`);
        continue;
      }
      attrs.push(`${attrLocal}="${escAttr(value)}"`);
    }
    if (elementRejected) return;
    if (depth === 1 && local === 'svg') {
      attrs.unshift(`xmlns="${SVG_NS}"`, `xmlns:xlink="${XLINK_NS}"`);
    }
    out.push(`<${local}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`);
  });

  parser.on('comment', () => {
    // Out-of-allowlist content is a typed issue, never silently dropped.
    issues.push(
      issueAt(parser, {
        code: 'svg_element_forbidden',
        detail: 'comments are not allowed in figures',
      }),
    );
  });

  parser.on('text', (text) => {
    if (depth > 0) out.push(esc(text));
    else if (text.trim() !== '') {
      issues.push(
        issueAt(parser, {
          code: 'svg_parse_error',
          detail: 'text outside the root <svg> is not allowed',
        }),
      );
    }
  });

  parser.on('cdata', (data) => {
    // CDATA inside a figure is only ever label text; escape it like text.
    if (depth > 0) out.push(esc(data));
    else if (data.trim() !== '') {
      issues.push(
        issueAt(parser, {
          code: 'svg_parse_error',
          detail: 'CDATA outside the root <svg> is not allowed',
        }),
      );
    }
  });

  parser.on('closetag', (tag) => {
    const local = tag.local || tag.name;
    if (depth === 1) rootClosed = true;
    depth -= 1;
    if (ALLOWED_ELEMENTS.has(local)) out.push(`</${local}>`);
  });

  parser.write(source).close();

  if (issues.length > 0) return { ok: false, issues: issues.slice(0, 12) };
  if (!rootSawViewBox) {
    return {
      ok: false,
      issues: [
        {
          code: 'svg_missing_viewbox',
          path: '/svg',
          detail: 'the root <svg> must declare a viewBox so the figure can be sized',
        },
      ],
    };
  }
  const svg = out.join('');
  if (!svg.startsWith('<svg')) {
    return {
      ok: false,
      issues: [{ code: 'svg_parse_error', path: '/svg', detail: 'document root must be <svg>' }],
    };
  }
  return { ok: true, svg };
}
