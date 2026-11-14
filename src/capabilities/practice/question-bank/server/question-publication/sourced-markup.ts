// Converts sourced (jyeoo/MathJye) markup at the ingest seam so learner-facing
// fields render as markdown instead of HTML and third-party image URLs:
//
//   fraction table → \frac, radical table → \sqrt, <sup>/<sub> → unicode/LaTeX,
//   other tags → transparent (children kept).
//
// The tokenizer is lenient and never throws; clean input passes through byte-identical.

interface El {
  tag: string;
  attrs: string;
  children: MarkupNode[];
}
type MarkupNode = string | El;

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)(\/?)>/g;
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const SKIP_TAGS = new Set(['script', 'style']);

function parseMarkup(input: string): MarkupNode[] {
  const roots: MarkupNode[] = [];
  const stack: El[] = [];
  const push = (node: MarkupNode) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
  };

  let last = 0;
  for (const m of input.matchAll(TAG_RE)) {
    if (m.index > last) push(input.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1] === '/') {
      // Close the nearest matching open element; unmatched closers are dropped.
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const el: El = { tag, attrs: m[3] ?? '', children: [] };
    // Attach at open time so unclosed elements still render their children.
    push(el);
    if (!VOID_TAGS.has(tag) && m[4] !== '/') stack.push(el);
  }
  if (last < input.length) push(input.slice(last));
  return roots;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  pm: '±',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? raw : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? raw : String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? raw;
  });
}

// Inside LaTeX, full-width ASCII variants are literal glyphs to KaTeX — fold them to ASCII.
function normalizeMathText(text: string): string {
  return text.replace(/[！-～　]/g, (ch) =>
    ch === '　' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  a: 'ᵃ',
  b: 'ᵇ',
  c: 'ᶜ',
  d: 'ᵈ',
  e: 'ᵉ',
  h: 'ʰ',
  i: 'ⁱ',
  m: 'ᵐ',
  n: 'ⁿ',
  o: 'ᵒ',
  p: 'ᵖ',
  r: 'ʳ',
  s: 'ˢ',
  t: 'ᵗ',
  u: 'ᵘ',
  v: 'ᵛ',
  w: 'ʷ',
  x: 'ˣ',
  y: 'ʸ',
  z: 'ᶻ',
};
const SUBSCRIPT: Record<string, string> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  i: 'ᵢ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

function mapScript(
  text: string,
  table: Record<string, string>,
  fallback: (s: string) => string,
): string {
  const chars = [...text];
  // All-or-nothing: a partial map (`²k`) is worse than the unambiguous LaTeX fallback.
  return chars.length > 0 && chars.every((ch) => ch in table)
    ? chars.map((ch) => table[ch]).join('')
    : fallback(text);
}

function cellsOf(row: El): El[] {
  return row.children.filter(
    (c): c is El => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th'),
  );
}

function renderTable(el: El, inMath: boolean): string {
  const rows = el.children.filter((c): c is El => typeof c !== 'string' && c.tag === 'tr');
  if (rows.length === 0) return renderNodes(el.children, inMath);
  // Nested math must not re-open `$…$`; it would terminate the outer run.
  const open = inMath ? '' : '$';
  const close = inMath ? '' : '$';

  // Fraction stack: MathJye draws the bar as the numerator cell's bottom border.
  // Single-cell rows only; a multi-cell bordered row is a real table.
  if (rows.length === 2) {
    const [num] = cellsOf(rows[0]);
    const [den] = cellsOf(rows[1]);
    if (
      num &&
      den &&
      cellsOf(rows[0]).length === 1 &&
      cellsOf(rows[1]).length === 1 &&
      /border-bottom/i.test(num.attrs)
    ) {
      return `${open}\\frac{${renderNodes(num.children, true)}}{${renderNodes(den.children, true)}}${close}`;
    }
  }

  // Radical: a zero-font sprite cell followed by a `border-top` vinculum cell.
  if (rows.length === 1) {
    const cells = cellsOf(rows[0]);
    if (
      cells.length === 2 &&
      (/font-size\s*:\s*0px/i.test(cells[0].attrs) || /formula\/part/i.test(cells[0].attrs)) &&
      /border-top/i.test(cells[1].attrs)
    ) {
      return `${open}\\sqrt{${renderNodes(cells[1].children, true)}}${close}`;
    }
  }

  return renderNodes(el.children, inMath);
}

function renderNodes(nodes: MarkupNode[], inMath = false): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      const text = decodeEntities(node);
      out += inMath ? normalizeMathText(text) : text;
      continue;
    }
    if (SKIP_TAGS.has(node.tag)) continue;
    switch (node.tag) {
      case 'sup':
        // Inside $…$ use LaTeX (KaTeX does not map unicode scripts); plain text keeps
        // unicode scripts so `a²+b²` does not need a math span.
        out += inMath
          ? `^{${renderNodes(node.children, true)}}`
          : mapScript(renderNodes(node.children, false), SUPERSCRIPT, (s) => `^{${s}}`);
        break;
      case 'sub':
        out += inMath
          ? `_{${renderNodes(node.children, true)}}`
          : mapScript(renderNodes(node.children, false), SUBSCRIPT, (s) => `_{${s}}`);
        break;
      case 'br':
        out += '\n';
        break;
      case 'table':
        out += renderTable(node, inMath);
        break;
      default: {
        // A MathJye span is one math boundary, so sibling constructs share a `$…$`
        // run. Emit it unwrapped when it produced no math (CJK breaks KaTeX).
        const isMathSpan = /mathjye|mathtag\s*=\s*['"]math['"]/i.test(node.attrs);
        if (isMathSpan) {
          const inner = renderNodes(node.children, true);
          out += /\\frac|\\sqrt|\^\{|_\{/.test(inner) ? `$${inner}$` : inner;
          break;
        }
        out += renderNodes(node.children, inMath);
      }
    }
  }
  return out;
}

/**
 * Normalize sourced markup to markdown + LaTeX. Idempotent; plain text without
 * tags or entities returns byte-identical.
 */
export function sanitizeSourcedMarkup(input: string): string {
  const rendered =
    input.includes('<') || input.includes('&') ? renderNodes(parseMarkup(input)) : input;
  // Producers also ship pre-baked `$…$` runs, so normalize every math run.
  return rendered.replace(/\$\$[^$]+\$\$|\$[^$]+\$/g, normalizeMathText);
}
