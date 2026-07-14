export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function weeklyReviewPath(days: number, timeZone: string): string {
  const search = new URLSearchParams({ days: String(days), timezone: timeZone });
  return `/api/review/weekly?${search.toString()}`;
}
