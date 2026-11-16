/** Same prompt despite spacing, full-width punctuation or LaTeX spelling; digits and symbols stay. */
export function normalizePrompt(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\\[dt]frac/g, '\\frac')
    .replace(/\\(?:left|right|displaystyle)(?![a-zA-Z])/g, '')
    .replace(/\\(?:[,;:!]|q?quad(?![a-zA-Z]))/g, '')
    .replace(/[\s{}$]/g, '')
    .replace(/[。.]+$/, '');
}
