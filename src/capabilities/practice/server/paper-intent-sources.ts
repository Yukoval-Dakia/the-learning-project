export const PAPER_INTENT_SOURCES = [
  'review_plan',
  'quiz_gen',
  'embedded_check',
  'ingestion_paper',
] as const;

export function isPaperIntentSource(value: string | null): boolean {
  return typeof value === 'string' && (PAPER_INTENT_SOURCES as readonly string[]).includes(value);
}
