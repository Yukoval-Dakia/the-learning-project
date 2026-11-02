/**
 * YUK-1531 — a budget abort often cuts the stream before the final usage chunk, so
 * estimate tokens from what was submitted or streamed. Same rough divisor as pi
 * compaction: CJK ≈ 1 token, other text ≈ 4 chars. An estimate, never an invoice
 * and never the {0,0} placeholder.
 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/gu;

/** Character totals for one stream. The text itself is not retained. */
export interface StreamTextStats {
  chars: number;
  cjk: number;
}

export function emptyStreamTextStats(): StreamTextStats {
  return { chars: 0, cjk: 0 };
}

export function addStreamText(stats: StreamTextStats, text: string): void {
  if (text.length === 0) return;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  stats.chars += text.length;
  stats.cjk += cjk;
}

export function tokensFromStreamText(stats: StreamTextStats): number {
  if (stats.chars === 0) return 0;
  return Math.max(1, Math.ceil((stats.chars - stats.cjk) / 4 + stats.cjk));
}

export function estimateTextTokens(text: string): number {
  const stats = emptyStreamTextStats();
  addStreamText(stats, text);
  return tokensFromStreamText(stats);
}

export function estimateAbortedUsage(
  promptText: string,
  output: StreamTextStats,
): { inputTokens: number; outputTokens: number } {
  let inputTokens = estimateTextTokens(promptText);
  const outputTokens = tokensFromStreamText(output);
  // The provider query had started, so at least the prompt was submitted.
  if (inputTokens + outputTokens === 0) inputTokens = 1;
  return { inputTokens, outputTokens };
}
