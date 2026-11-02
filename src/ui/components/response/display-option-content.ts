/** Presentation only: the separate letter marker owns its label; response IDs/text stay untouched. */
export function displayOptionContent(text: string, label: string | null): string {
  if (!label || !/^[A-Za-z]$/.test(label)) return text;
  const prefix = new RegExp(`^\\s*(?:${label}[.．、:：]\\s*|[（(]${label}[)）]\\s*)`);
  let content = text;
  for (;;) {
    const match = prefix.exec(content);
    if (!match) return content;
    const remainder = content.slice(match[0].length);
    // Preserve literal names such as “A、B两点”; repeated copies of this exact marker are unambiguous.
    if (!remainder.trim() || (/^[A-Za-z]/.test(remainder) && !prefix.test(remainder)))
      return content;
    content = remainder;
  }
}
