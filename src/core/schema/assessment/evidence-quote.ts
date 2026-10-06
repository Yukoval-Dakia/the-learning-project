import { z } from 'zod';

const jsonValue = z.json();
type JsonValue = z.infer<typeof jsonValue>;
const numberContext = z.object({ source: z.string() });

/** Inspect raw members before JSON.parse/Zod can overwrite or discard keys. */
function assertLosslessJsonMembers(text: string): void {
  const frames: Array<
    { kind: 'object'; keys: Set<string>; expectingKey: boolean } | { kind: 'array' }
  > = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const frame = frames.at(-1);
    if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        // Skip an entire escape, so escaped quotes/backslashes cannot end the token.
        index += text[index] === '\\' ? 2 : 1;
      }
      if (index >= text.length) throw new Error('Unterminated JSON string');
      if (frame?.kind === 'object' && frame.expectingKey) {
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== 'string' || frame.keys.has(key)) {
          throw new Error('Duplicate JSON member');
        }
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new Error('Prototype-related JSON member');
        }
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    } else if (character === '{') {
      frames.push({ kind: 'object', keys: new Set(), expectingKey: true });
    } else if (character === '[') {
      frames.push({ kind: 'array' });
    } else if (character === '}' || character === ']') {
      frames.pop();
    } else if (character === ',' && frame?.kind === 'object') {
      frame.expectingKey = true;
    }
  }
  // JSON.parse below validates the complete grammar; this scan checks raw member identity.
}

function decimalIdentity(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new Error('Invalid JSON number');
  const [, sign, integer, fraction = '', exponent = '0'] = match;
  const significant = (integer + fraction).replace(/^0+/, '');
  if (significant.length === 0) return `${sign}0`;
  const coefficient = significant.replace(/0+$/, '');
  const scale =
    BigInt(exponent) - BigInt(fraction.length) + BigInt(significant.length - coefficient.length);
  return `${sign}${coefficient}e${scale}`;
}

function parseWithoutNumericLoss(text: string): JsonValue {
  assertLosslessJsonMembers(text);
  return jsonValue.parse(
    JSON.parse(text, (_key: string, value: unknown, context?: unknown) => {
      if (typeof value === 'number') {
        const { source } = numberContext.parse(context);
        // Different decimal leaves must not collapse to the same rounded JS number.
        if (
          !Number.isFinite(value) ||
          decimalIdentity(source) !== decimalIdentity(JSON.stringify(value))
        ) {
          throw new Error('JSON number loses precision');
        }
      }
      return value;
    }),
  );
}

function matchesProjection(original: JsonValue, quote: JsonValue, allowProjection = true): boolean {
  if (Array.isArray(quote)) {
    return (
      Array.isArray(original) &&
      original.length === quote.length &&
      quote.every((value, index) => matchesProjection(original[index], value, false))
    );
  }
  if (quote !== null && typeof quote === 'object') {
    if (original === null || typeof original !== 'object' || Array.isArray(original)) return false;
    const entries = Object.entries(quote);
    const originalSize = Object.keys(original).length;
    return (
      (entries.length > 0 || originalSize === 0) &&
      (allowProjection || originalSize === entries.length) &&
      entries.every(
        ([key, value]) =>
          Object.hasOwn(original, key) && matchesProjection(original[key], value, allowProjection),
      )
    );
  }
  return original === quote;
}

function hasMeaningfulContent(value: JsonValue): boolean {
  if (value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value !== 'object') return true;
  return Object.values(value).some(hasMeaningfulContent);
}

/** Exact text first; JSON projections keep every cited path and value in the original. */
export function isOriginalEvidenceQuote({
  source,
  quote,
}: {
  source: string;
  quote: string;
}): boolean {
  if (quote.trim().length === 0) return false;
  if (source.includes(quote)) return true;
  try {
    const original = parseWithoutNumericLoss(source);
    const projection = parseWithoutNumericLoss(quote);
    return (
      projection !== null &&
      typeof projection === 'object' &&
      !Array.isArray(projection) &&
      hasMeaningfulContent(projection) &&
      matchesProjection(original, projection)
    );
  } catch {
    return false;
  }
}
