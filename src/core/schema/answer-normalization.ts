/** Width compatibility is safe for answer text; other compatibility symbols remain distinct. */
export function normalizeAnswerWidth(value: string): string {
  return value
    .replace(/[\u3000\uFF01-\uFF5E]+/gu, (width) => width.normalize('NFKC'))
    .normalize('NFC');
}

/** Unit suffixes keep mathjs compatibility spellings; the numeric prefix must not lose symbols. */
export function normalizeNumericAnswer(raw: string, hasUnit: boolean): string | null {
  let numericPrefix = true;
  for (const char of raw) {
    if (normalizeAnswerWidth(char) !== char.normalize('NFKC') && (!hasUnit || numericPrefix))
      return null;
    numericPrefix &&= /^[+\-0-9.eE\s]*$/.test(char.normalize('NFKC'));
  }
  return (hasUnit ? raw.normalize('NFKC') : normalizeAnswerWidth(raw)).trim();
}
