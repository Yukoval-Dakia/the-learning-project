export interface Rational {
  numerator: bigint;
  denominator: bigint;
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
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

export function formatRational(value: Rational): string {
  return value.denominator === 1n
    ? value.numerator.toString()
    : `${value.numerator}/${value.denominator}`;
}

export function normalizeLatexFractions(value: string): string {
  return value.replace(/\\(?:d?frac)\s*\{\s*([+-]?\d+)\s*\}\s*\{\s*(\d+)\s*\}/g, '$1/$2');
}

export function extractFractionOperands(value: string): Rational[] {
  const normalized = normalizeLatexFractions(value);
  return [...normalized.matchAll(/([+-]?\d+)\s*\/\s*(\d+)/g)].flatMap((match) => {
    const parsed = rational(BigInt(match[1] ?? '0'), BigInt(match[2] ?? '0'));
    return parsed ? [parsed] : [];
  });
}

/**
 * Answers may show working before the final value. The last rational token is
 * the conventional final-answer position; unsupported prose without any exact
 * rational remains ungradable rather than being guessed.
 */
export function extractFinalRational(value: string): Rational | null {
  const normalized = normalizeLatexFractions(value).replace(/[−–—]/g, '-');
  const tokens = [
    ...normalized.matchAll(/(?<![\w/])([+-]?\d+\s*\/\s*\d+|[+-]?\d+(?:\.\d+)?)(?![\w/])/g),
  ];
  const raw = tokens.at(-1)?.[1]?.replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.includes('/')) {
    const [numerator, denominator] = raw.split('/');
    if (!numerator || !denominator) return null;
    return rational(BigInt(numerator), BigInt(denominator));
  }
  return parseDecimalRational(raw);
}
