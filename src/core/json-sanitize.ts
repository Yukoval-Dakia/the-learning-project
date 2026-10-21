// Escape bare control characters inside JSON string literals. LLM output sometimes
// contains U+0000–U+001F raw, which JSON.parse rejects; a lightweight state machine
// tracks string context and legalizes only those characters, leaving structure alone.

/**
 * Escape bare control characters (U+0000–U+001F) inside string literals. Outside a
 * string nothing is touched, so structural tokens cannot be mangled.
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
        // Pass the escape pair through unchanged; it is already legal.
        out.push(ch);
        i++;
        if (i < text.length) {
          out.push(text[i]);
          i++;
        }
        continue;
      }

      if (ch === '"') {
        inString = false;
        out.push(ch);
        i++;
        continue;
      }

      // Inside a string literal: escape bare control characters.
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
            // Other control chars use the \uXXXX form.
            out.push(`\\u${code.toString(16).padStart(4, '0')}`);
        }
        i++;
        continue;
      }

      out.push(ch);
      i++;
    } else {
      // Outside a string, only the opening quote matters.
      if (ch === '"') {
        inString = true;
      }
      out.push(ch);
      i++;
    }
  }

  return out.join('');
}
