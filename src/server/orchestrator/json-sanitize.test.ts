import { describe, expect, it } from 'vitest';
import { sanitizeJsonStringLiterals } from './json-sanitize';

describe('sanitizeJsonStringLiterals', () => {
  it('leaves valid JSON unchanged', () => {
    const input = '{"kind":"explain","text_md":"hello world","suggested_next":"continue"}';
    expect(sanitizeJsonStringLiterals(input)).toBe(input);
  });

  it('escapes bare newline inside a string literal', () => {
    // Simulate LLM output: {"text_md":"line one\nline two"} with a LITERAL newline
    const input = '{"text_md":"line one\nline two"}';
    const result = sanitizeJsonStringLiterals(input);
    expect(result).toBe('{"text_md":"line one\\nline two"}');
    const parsed = JSON.parse(result) as { text_md: string };
    // The parsed value should preserve the semantic newline
    expect(parsed.text_md).toBe('line one\nline two');
  });

  it('escapes bare tab inside a string literal', () => {
    const input = '{"text_md":"col1\tcol2"}';
    const result = sanitizeJsonStringLiterals(input);
    expect(result).toBe('{"text_md":"col1\\tcol2"}');
    const parsed = JSON.parse(result) as { text_md: string };
    expect(parsed.text_md).toBe('col1\tcol2');
  });

  it('escapes bare carriage-return inside a string literal', () => {
    const input = '{"text_md":"a\rb"}';
    const result = sanitizeJsonStringLiterals(input);
    expect(result).toBe('{"text_md":"a\\rb"}');
    const parsed = JSON.parse(result) as { text_md: string };
    expect(parsed.text_md).toBe('a\rb');
  });

  it('uses \\uXXXX form for other control characters (e.g. U+0001 SOH)', () => {
    const soh = String.fromCharCode(0x01);
    const input = `{"x":"a${soh}b"}`;
    const result = sanitizeJsonStringLiterals(input);
    expect(result).toBe('{"x":"a\\u0001b"}');
    const parsed = JSON.parse(result) as { x: string };
    expect(parsed.x).toBe(`a${soh}b`);
  });

  it('does not escape a legitimate \\n escape sequence (already escaped)', () => {
    // The string already contains \\n (two chars: backslash + n) — must pass through unchanged
    const input = '{"text_md":"line one\\nline two"}';
    expect(sanitizeJsonStringLiterals(input)).toBe(input);
  });

  it('handles escaped quote inside string without breaking context tracking', () => {
    // {"text_md":"say \"hi\"\nworld"} — the \" must not close the string context
    const nul = String.fromCharCode(0x00);
    const withNul = `{"text_md":"say \\"hi\\"${nul}world"}`;
    const result = sanitizeJsonStringLiterals(withNul);
    expect(result).toBe('{"text_md":"say \\"hi\\"\\u0000world"}');
    const parsed = JSON.parse(result) as { text_md: string };
    expect(parsed.text_md).toBe(`say "hi"${nul}world`);
  });

  it('handles multiple string fields, only escaping inside strings', () => {
    const input = `{"a":"foo\nbar","b":42,"c":"baz\ttab"}`;
    const result = sanitizeJsonStringLiterals(input);
    expect(result).toBe('{"a":"foo\\nbar","b":42,"c":"baz\\ttab"}');
    const parsed = JSON.parse(result) as { a: string; b: number; c: string };
    expect(parsed.a).toBe('foo\nbar');
    expect(parsed.b).toBe(42);
    expect(parsed.c).toBe('baz\ttab');
  });
});

// ---------------------------------------------------------------------------
// Integration: parseTurnOutput picks up the sanitizer on bad control chars
// ---------------------------------------------------------------------------
import { TeachingError, parseTurnOutput } from './teaching';

describe('parseTurnOutput — control-char resilience', () => {
  it('parses an explain turn that contains a bare newline in text_md', () => {
    const brokenJson = `{"kind":"explain","text_md":"line one\nline two","suggested_next":"continue"}`;
    const result = parseTurnOutput(brokenJson);
    expect(result.kind).toBe('explain');
    expect(result.text_md).toBe('line one\nline two');
    expect(result.suggested_next).toBe('continue');
  });

  it('parses an explain turn that contains a bare tab in text_md', () => {
    const brokenJson = `{"kind":"explain","text_md":"col1\tcol2","suggested_next":"continue"}`;
    const result = parseTurnOutput(brokenJson);
    expect(result.text_md).toBe('col1\tcol2');
  });

  it('returns valid JSON unchanged (no false sanitization)', () => {
    const good = JSON.stringify({
      kind: 'end',
      text_md: '学完了，做个小测验吧。',
      suggested_next: 'end',
    });
    const result = parseTurnOutput(good);
    expect(result.kind).toBe('end');
  });

  it('still throws TeachingError when JSON is structurally broken (not just control chars)', () => {
    const broken = '{"kind":"explain","text_md": INVALID }';
    expect(() => parseTurnOutput(broken)).toThrow(TeachingError);
  });

  it('throws TeachingError when there is no JSON object at all', () => {
    expect(() => parseTurnOutput('no json here')).toThrow(TeachingError);
  });
});

// ---------------------------------------------------------------------------
// Integration: parseHintTurn picks up the sanitizer on bad control chars
// ---------------------------------------------------------------------------
import { SolveError, parseHintTurn } from './solve';

describe('parseHintTurn — control-char resilience', () => {
  it('parses a hint turn that contains a bare newline in text_md', () => {
    const brokenJson = `{"text_md":"hint line one\nhint line two"}`;
    const result = parseHintTurn(brokenJson);
    expect(result.text_md).toBe('hint line one\nhint line two');
  });

  it('parses a hint turn that contains a bare tab in text_md', () => {
    const brokenJson = `{"text_md":"hint\twith\ttabs"}`;
    const result = parseHintTurn(brokenJson);
    expect(result.text_md).toBe('hint\twith\ttabs');
  });

  it('returns valid JSON unchanged', () => {
    const good = JSON.stringify({ text_md: '这是一条提示。' });
    const result = parseHintTurn(good);
    expect(result.text_md).toBe('这是一条提示。');
  });

  it('still throws SolveError when JSON is structurally broken', () => {
    expect(() => parseHintTurn('{"text_md": BAD}')).toThrow(SolveError);
  });

  it('throws SolveError when there is no JSON object at all', () => {
    expect(() => parseHintTurn('just text')).toThrow(SolveError);
  });
});
