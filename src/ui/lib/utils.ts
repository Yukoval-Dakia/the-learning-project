// Pure helpers used by UI pages — date formatting + className composition.
// Kept dependency-free; ICU-independent (formatCnDate uses padded numeric).

export type CnArg = string | false | null | undefined;

export function cn(...args: CnArg[]): string {
  return args.filter(Boolean).join(' ');
}

export function formatCnDate(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '--';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

export function formatRelTime(
  input: Date | string | number,
  now: Date = new Date(),
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '--';
  const past = now.getTime() - d.getTime();
  if (past < 10_000) return '刚刚';
  const s = Math.floor(past / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} 天前`;
  return formatCnDate(d);
}
