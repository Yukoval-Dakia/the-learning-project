/**
 * Shared comment/string/template-literal-aware TS tokenizer for the draft-status audits
 * (YUK-569). Factored out of scripts/audit-draft-status.ts so both the INSERT-side audit
 * (extractObjectBlock) and the read-side audit (analyzeSource) share ONE proven scanner
 * instead of each re-implementing the "skip braces/tokens inside comments and strings"
 * state machine (the non-negotiable false-positive control — §6.4 point 2 of the spec).
 *
 * - extractObjectBlock: brace-balanced object-literal extraction (INSERT audit).
 * - analyzeSource: whole-file region map (codeMask) + sql`` tagged-template spans, used by
 *   the read-side audit to positively detect F1 pool-visibility predicate shapes while
 *   skipping predicate PROSE in comments/plain strings for free.
 */

/**
 * Given source text and the index of the `{` that opens an object literal, return the
 * substring from that `{` to its matching `}` (inclusive). Brace-balanced and aware of:
 *   - single / double / template-literal strings (braces inside are NOT counted; for
 *     template literals `${...}` interpolation braces ARE counted so we don't lose the
 *     real object depth)
 *   - line comments (// ...) and block comments (block-comment delimiters)
 * Returns the matched block, or null if no matching close brace is found.
 *
 * Exported pure for unit testing (nested metadata objects, strings carrying '}', etc.).
 */
export function extractObjectBlock(src: string, openIdx: number): string | null {
  if (src[openIdx] !== '{') return null;
  const { codeMask } = analyzeSource(src);
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (codeMask[i] === 0) continue;
    const c = src[i];
    if (c === '{') {
      depth += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(openIdx, i + 1);
      }
    }
  }
  return null;
}

/** A tagged sql`` template-literal span (backtick-to-backtick, inclusive). */
export type SqlSpan = { start: number; end: number };

export type SourceAnalysis = {
  /**
   * Per-char mask: 1 = CODE (plain code OR `${...}` interpolation code), 0 = NON-CODE
   * (comment, single/double string, or template-literal TEXT). Used to (a) skip
   * predicate PROSE in comments/strings and (b) confirm a matched predicate shape sits
   * in real code, not in a docstring.
   */
  codeMask: Uint8Array;
  /** Per-char mask: 1 = comment, 0 = code or literal text. */
  commentMask: Uint8Array;
  /** Spans of `sql`-tagged template literals (raw text incl. `${}` interpolations). */
  sqlSpans: SqlSpan[];
};

type Frame = { isSql: boolean; start: number; inText: boolean; braceDepth: number };

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** True when the identifier ending at index `endExclusive-1` is exactly `sql` (tag detect). */
function endsWithSqlTag(src: string, endExclusive: number): boolean {
  let j = endExclusive - 1;
  let ident = '';
  while (j >= 0 && isIdentChar(src[j])) {
    ident = src[j] + ident;
    j -= 1;
  }
  return ident === 'sql';
}

/**
 * Single-pass lexer producing a code/non-code mask + the sql`` template spans. Handles
 * nested template literals and `${}` interpolations (including strings/comments/templates
 * nested inside an interpolation). Exported pure for unit testing.
 */
export function analyzeSource(src: string): SourceAnalysis {
  const n = src.length;
  const codeMask = new Uint8Array(n);
  const commentMask = new Uint8Array(n);
  const sqlSpans: SqlSpan[] = [];

  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  const tstack: Frame[] = [];

  const topText = (): Frame | null => {
    const top = tstack[tstack.length - 1];
    return top?.inText ? top : null;
  };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (inLine) {
      commentMask[i] = 1;
      if (c === '\n') inLine = false;
      i += 1;
      continue;
    }
    if (inBlock) {
      commentMask[i] = 1;
      if (c === '*' && next === '/') {
        commentMask[i + 1] = 1;
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }

    const textFrame = topText();
    if (textFrame) {
      // inside a template literal's TEXT (non-code).
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        if (textFrame.isSql) sqlSpans.push({ start: textFrame.start, end: i });
        tstack.pop();
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        textFrame.inText = false;
        textFrame.braceDepth = 1;
        codeMask[i] = 1;
        codeMask[i + 1] = 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // CODE mode (top-level, or `${}` interpolation code of the top frame).
    codeMask[i] = 1;
    if (c === '/' && next === '/') {
      codeMask[i] = 0;
      commentMask[i] = 1;
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      codeMask[i] = 0;
      commentMask[i] = 1;
      inBlock = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      codeMask[i] = 0;
      inSingle = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      codeMask[i] = 0;
      inDouble = true;
      i += 1;
      continue;
    }
    if (c === '`') {
      codeMask[i] = 0;
      tstack.push({ isSql: endsWithSqlTag(src, i), start: i, inText: true, braceDepth: 0 });
      i += 1;
      continue;
    }
    const interpFrame = tstack.length > 0 ? tstack[tstack.length - 1] : null;
    if (interpFrame && !interpFrame.inText) {
      if (c === '{') interpFrame.braceDepth += 1;
      else if (c === '}') {
        interpFrame.braceDepth -= 1;
        if (interpFrame.braceDepth === 0) interpFrame.inText = true;
      }
    }
    i += 1;
  }

  return { codeMask, commentMask, sqlSpans };
}

/** 1-based line number of `idx` in `src`. */
export function lineOf(src: string, idx: number): number {
  let line = 1;
  for (let k = 0; k < idx && k < src.length; k += 1) {
    if (src[k] === '\n') line += 1;
  }
  return line;
}
