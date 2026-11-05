/** Width compatibility is safe for answer text; other compatibility symbols remain distinct. */
export function normalizeAnswerWidth(value: string): string {
  return value
    .replace(/[\u3000\uFF01-\uFF5E]+/gu, (width) => width.normalize('NFKC'))
    .normalize('NFC');
}
