// YUK-607 — lenient JSON extraction for LLM output.
//
// Quiz-supply parsers were brace-slice + JSON.parse and lost whole batches when models
// emitted unescaped quotes in long Chinese strings. Contract:
//   1. Strict parse succeeds → return as-is, repaired:false.
//   2. Strict fails → deterministic repairs (quotes/backslashes/control chars/tail
//      closers) then jsonrepair; success → repaired:true + warn.
//   3. Both fail → throw the ORIGINAL Strict SyntaxError; call sites keep their exact
//      error strings.
//   4. No {...} → null; the caller owns the wording.
// Repairs only fix syntax; schema validation stays with each caller. Distinct from
// json-sanitize.ts, which only escapes bare control characters.

import { jsonrepair } from 'jsonrepair';

import { sanitizeJsonStringLiterals } from './json-sanitize';

// Escape content quotes: an unescaped `"` whose neighbours cannot be structural is
// inside a string value. Legal JSON is unchanged by this mapping.
function escapeContentQuotes(slice: string): string {
  const isOpenerCtx = (c: string | undefined) => c === '{' || c === '[' || c === ',' || c === ':';
  const isCloserCtx = (c: string | undefined) => c === ',' || c === '}' || c === ']' || c === ':';
  const out: string[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (ch !== '"') {
      out.push(ch);
      continue;
    }
    // Already escaped (odd run of preceding backslashes) → keep.
    let bs = 0;
    for (let j = i - 1; j >= 0 && slice[j] === '\\'; j -= 1) bs += 1;
    if (bs % 2 === 1) {
      out.push(ch);
      continue;
    }
    let p = i - 1;
    while (p >= 0 && /\s/.test(slice[p])) p -= 1;
    let n = i + 1;
    while (n < slice.length && /\s/.test(slice[n])) n += 1;
    const prev = p >= 0 ? slice[p] : undefined;
    const next = n < slice.length ? slice[n] : undefined;
    // Quotes at the slice edges are structural.
    if (prev === undefined || next === undefined || isOpenerCtx(prev) || isCloserCtx(next)) {
      out.push(ch);
    } else {
      out.push('\\"');
    }
  }
  return out.join('');
}

// Escape invalid in-string backslashes from LaTeX (`\(`, `\dfrac`) without touching
// legal JSON escapes; only operates inside strings, never re-draws boundaries.
function escapeInvalidJsonStringBackslashes(slice: string): string {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (!inString) {
      out.push(ch);
      if (ch === '"') {
        inString = true;
      }
      continue;
    }
    if (ch === '"') {
      out.push(ch);
      inString = false;
      continue;
    }
    if (ch !== '\\') {
      out.push(ch);
      continue;
    }

    const next = slice[i + 1];
    if (next === '$') {
      out.push('\\\\', '$');
      i += 1;
      continue;
    }
    if (next === '\\' && slice[i + 2] === '$') {
      out.push(ch, next, '$');
      i += 2;
      continue;
    }
    if (next === '"' || next === '\\' || next === '/') {
      out.push(ch, next);
      i += 1;
      continue;
    }
    // Legal control escapes win: `\n` may be a real newline rather than `\nu`.
    if (next && 'bfnrt'.includes(next)) {
      out.push(ch, next);
      i += 1;
      continue;
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(slice.slice(i + 2, i + 6))) {
      out.push(slice.slice(i, i + 6));
      i += 5;
      continue;
    }
    out.push('\\\\');
  }
  return out.join('');
}

// Close only definitely-missing tail containers: the string must be closed and the
// bracket stack never mismatched. Truncation inside a string/value still fails loudly.
function closeUnterminatedJsonContainers(slice: string): string {
  const expectedClosers: string[] = [];
  let inString = false;
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i];
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      expectedClosers.push('}');
    } else if (ch === '[') {
      expectedClosers.push(']');
    } else if (ch === '}' || ch === ']') {
      if (expectedClosers.pop() !== ch) return slice;
    }
  }
  if (inString || expectedClosers.length === 0) return slice;
  return slice + expectedClosers.reverse().join('');
}

export type RepairLevel = false | 'deterministic' | 'jsonrepair';

interface LadderHit {
  json: unknown;
  level: Exclude<RepairLevel, false>;
}

// Repair ladder. Deterministic levels preserve content (escape only, never re-draw
// boundaries): content quotes, invalid backslashes, bare control chars, tail closers.
// jsonrepair is heuristic and may silently re-draw boundaries/truncate, so
// riskyRepair='reject' stops at the deterministic levels for unisolated writes.
function tryRepairLadder(
  slice: string,
  allowRisky: boolean,
  allowContainerClosure: boolean,
  repairMarkdownMathEscapes: boolean,
): LadderHit {
  const quoteEscaped = escapeContentQuotes(slice);
  const escaped = repairMarkdownMathEscapes
    ? escapeInvalidJsonStringBackslashes(quoteEscaped)
    : quoteEscaped;
  try {
    return { json: JSON.parse(escaped), level: 'deterministic' };
  } catch {
    /* 下一级 */
  }
  const sanitizedEscaped = sanitizeJsonStringLiterals(escaped);
  const sanitized = allowContainerClosure
    ? closeUnterminatedJsonContainers(sanitizedEscaped)
    : sanitizedEscaped;
  try {
    return { json: JSON.parse(sanitized), level: 'deterministic' };
  } catch (deterministicErr) {
    if (!allowRisky) throw deterministicErr;
  }
  try {
    return { json: JSON.parse(jsonrepair(slice)), level: 'jsonrepair' };
  } catch {
    /* 下一级 */
  }
  return { json: JSON.parse(jsonrepair(sanitized)), level: 'jsonrepair' }; // 失败向上抛，由调用方包装
}

export interface LooseJsonResult {
  json: unknown;
  /**
   * false = strict parse; 'deterministic' = content-preserving escape repairs;
   * 'jsonrepair' = heuristic (may truncate/re-draw boundaries) and must be isolated
   * by callers that persist the content.
   */
  repaired: RepairLevel;
}

export interface ParseJsonLooseOpts {
  /** 'reject' forbids the heuristic level, for sites that persist without isolation. */
  riskyRepair?: 'allow' | 'reject';
  /**
   * Missing tail closers are ambiguous with truncation. Enable only when a strict
   * schema immediately proves every required field/cardinality is present.
   */
  containerClosure?: 'schema_validated';
  /**
   * Preserve invalid backslashes for Markdown-math outputs; legal control escapes
   * remain authoritative.
   */
  latexEscapes?: 'markdown_math';
}

/**
 * Slice from the first `{` to the last `}` and parse leniently.
 * @returns null when the text contains no `{...}`.
 * @throws the original strict SyntaxError when both strict and repair parsing fail.
 */
export function parseJsonObjectLoose(
  text: string,
  label: string,
  opts: ParseJsonLooseOpts = {},
): LooseJsonResult | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1) return null;
  const hasCompleteEnd = end >= start;
  if (!hasCompleteEnd && opts.containerClosure !== 'schema_validated') return null;
  const slice = hasCompleteEnd ? text.slice(start, end + 1) : text.slice(start);
  const hasTruncatedSuffix = hasCompleteEnd && text.slice(end + 1).trim().length > 0;
  const repairMarkdownMathEscapes = opts.latexEscapes === 'markdown_math';
  const needsLatexRepair =
    repairMarkdownMathEscapes && escapeInvalidJsonStringBackslashes(slice) !== slice;
  let strictErr: unknown;
  try {
    const strictJson = JSON.parse(slice);
    if (!needsLatexRepair) return { json: strictJson, repaired: false };
    strictErr = new SyntaxError(`${label} contained an ambiguous LaTeX escape`);
  } catch (err) {
    strictErr = err;
  }
  {
    let hit: LadderHit;
    try {
      hit = tryRepairLadder(
        slice,
        (opts.riskyRepair ?? 'allow') === 'allow',
        opts.containerClosure === 'schema_validated' && !hasTruncatedSuffix,
        repairMarkdownMathEscapes,
      );
    } catch (repairErr) {
      // Keep a bounded window around the error for diagnosis; the raw output is not stored.
      const posMatch = /position (\d+)/.exec((strictErr as Error).message);
      const pos = posMatch ? Number(posMatch[1]) : 0;
      const snippet = slice.slice(Math.max(0, pos - 120), pos + 120);
      console.warn(
        `[json-extract] ${label}: UNREPAIRABLE (strict: ${(strictErr as Error).message}; repair: ${(repairErr as Error).message}); snippet@${pos}: ${JSON.stringify(snippet)}`,
      );
      throw strictErr;
    }
    console.warn(
      `[json-extract] ${label}: repaired malformed LLM JSON (level=${hit.level}, YUK-607 repair band)`,
    );
    return { json: hit.json, repaired: hit.level };
  }
}
