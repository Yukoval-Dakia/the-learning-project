export interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a === 0n ? 1n : a;
}

export function rational(numerator: bigint, denominator: bigint): Rational | null {
  if (denominator === 0n) return null;
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  };
}

export function parseDecimalRational(raw: string): Rational | null {
  const normalized = raw.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const sign = normalized.startsWith('-') ? -1n : 1n;
  const unsigned = normalized.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  return rational(sign * BigInt(`${whole}${fraction}`), denominator);
}

export function addRationals(left: Rational, right: Rational): Rational {
  const result = rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
  if (!result) throw new Error('addRationals produced an impossible zero denominator');
  return result;
}

export function multiplyRationals(left: Rational, right: Rational): Rational {
  const result = rational(left.numerator * right.numerator, left.denominator * right.denominator);
  if (!result) throw new Error('multiplyRationals produced an impossible zero denominator');
  return result;
}

export function divideRationals(left: Rational, right: Rational): Rational | null {
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

export function rationalsEqual(left: Rational, right: Rational): boolean {
  const normalizedLeft = rational(left.numerator, left.denominator);
  const normalizedRight = rational(right.numerator, right.denominator);
  return (
    normalizedLeft !== null &&
    normalizedRight !== null &&
    normalizedLeft.numerator === normalizedRight.numerator &&
    normalizedLeft.denominator === normalizedRight.denominator
  );
}

export function formatRational(value: Rational): string {
  return value.denominator === 1n
    ? value.numerator.toString()
    : `${value.numerator}/${value.denominator}`;
}

export function normalizeLatexFractions(value: string): string {
  return value.replace(/\\(?:[dt]?frac)\s*\{\s*([+-]?\d+)\s*\}\s*\{\s*(\d+)\s*\}/g, '$1/$2');
}

/**
 * Prefer an explicitly labelled answer, a leading answer, or the first equation
 * result. A prose derivation can end in intermediate integers, so an arbitrary
 * trailing numeric token is never treated as the answer.
 */
export function extractFinalRational(value: string): Rational | null {
  const normalized = normalizeLatexFractions(value.replace(/[−–—]/g, '-'));
  const tokenPattern = String.raw`([+-]?\d+\s*\/\s*\d+|[+-]?\d+(?:\.\d+)?)`;
  const marker = new RegExp(
    String.raw`(?:答案|结果|答|answer|result)\s*(?:是|为|[:：=])?\s*${tokenPattern}`,
    'i',
  ).exec(normalized);
  const leading = new RegExp(String.raw`^\s*${tokenPattern}(?![\w/])`).exec(normalized);
  const equation = new RegExp(String.raw`=\s*${tokenPattern}(?![\w/])`).exec(normalized);
  const tokens = [
    ...normalized.matchAll(/(?<![\w/])([+-]?\d+\s*\/\s*\d+|[+-]?\d+(?:\.\d+)?)(?![\w/])/g),
  ];
  const selected =
    marker?.[1] ?? leading?.[1] ?? equation?.[1] ?? (tokens.length === 1 ? tokens[0]?.[1] : null);
  const raw = selected?.replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.includes('/')) {
    const [numerator, denominator] = raw.split('/');
    if (!numerator || !denominator) return null;
    return rational(BigInt(numerator), BigInt(denominator));
  }
  return parseDecimalRational(raw);
}
