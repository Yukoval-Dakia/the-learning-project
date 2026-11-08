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

/**
 * Some imported options carry their letter twice in one text ("B. B．（0，1）"). Keep one copy:
 * "B. （0，1）". Text that merely starts with names ("A、B两点…") is left as it is. Used where the
 * option's own text is recorded or compared, so it matches what the page shows.
 */
export function collapseRepeatedLabel(text: string): string {
  const lead = /^\s*([A-Za-z])\s*[.．、:：]\s*/.exec(text);
  if (!lead) return text;
  const rest = text.slice(lead[0].length);
  const content = displayOptionContent(rest, lead[1]);
  return content === rest ? text : `${lead[1]}. ${content}`;
}
