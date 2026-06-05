// Shared JSON string-literal control-character sanitizer.
//
// LLM outputs sometimes embed bare control characters (U+0000–U+001F) inside
// JSON string literals instead of their escape sequences. The JSON spec forbids
// unescaped control characters in strings, so JSON.parse throws "Bad control
// character in string literal". This utility rescans the raw JSON text with a
// lightweight state machine that tracks whether the cursor is inside a string
// literal (handling \" escaped quotes) and replaces any bare control characters
// it finds with their legal JSON escape sequences.
//
// Usage:
//   const sanitized = sanitizeJsonStringLiterals(rawText);
//   // then retry JSON.parse(sanitized)

/**
 * Escape bare control characters (U+0000–U+001F) found inside JSON string
 * literals. Characters outside string literals are left untouched so structural
 * tokens (, : [ { etc.) are never mangled.
 */
export function sanitizeJsonStringLiterals(text: string): string {
  const out: string[] = [];
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    if (inString) {
      if (ch === '\\') {
        // Consume the backslash and whatever follows (escape sequence).
        // We pass both characters through unchanged — they are already legal.
        out.push(ch);
        i++;
        if (i < text.length) {
          out.push(text[i]);
          i++;
        }
        continue;
      }

      if (ch === '"') {
        // Closing quote — exit string context.
        inString = false;
        out.push(ch);
        i++;
        continue;
      }

      // Inside a string literal: escape any bare control character.
      if (code < 0x20) {
        switch (ch) {
          case '\n':
            out.push('\\n');
            break;
          case '\r':
            out.push('\\r');
            break;
          case '\t':
            out.push('\\t');
            break;
          default:
            // Other control chars (U+0000–U+001F except \n \r \t): use \uXXXX form.
            out.push(`\\u${code.toString(16).padStart(4, '0')}`);
        }
        i++;
        continue;
      }

      out.push(ch);
      i++;
    } else {
      // Outside a string: only watch for the opening quote.
      if (ch === '"') {
        inString = true;
      }
      out.push(ch);
      i++;
    }
  }

  return out.join('');
}
