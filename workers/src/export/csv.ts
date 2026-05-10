export interface Row {
  [k: string]: unknown;
}

export function csvEscape(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
