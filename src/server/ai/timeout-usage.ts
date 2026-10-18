/**
 * YUK-1531 — a budget abort often cuts the stream before the provider's final
 * usage chunk. Estimate the tokens that were actually submitted or streamed.
 * Same rough divisor the pi compaction trigger uses: CJK ≈ 1 token, other
 * text ≈ 4 characters per token. The result is an estimate, never a measured
 * invoice, and never the {0,0} placeholder.
 */
const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/gu;

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return Math.max(1, Math.ceil((text.length - cjk) / 4 + cjk));
}

export function estimateAbortedUsage(
  promptText: string,
  outputText: string,
): { inputTokens: number; outputTokens: number } {
  let inputTokens = estimateTextTokens(promptText);
  const outputTokens = estimateTextTokens(outputText);
  // The provider query had started, so at least the prompt was submitted.
  if (inputTokens + outputTokens === 0) inputTokens = 1;
  return { inputTokens, outputTokens };
}
