// 启动段预算与裁剪（YUK-1794 B1）。token 数用确定性估计器（不是真实 tokenizer）：
// CJK 按 ~1.6 token/字、其余按 ~1 token/3.5 字符 —— 与 budgets.ts 的既有口径同向
// （CJK 1.5–2.5 token/char），取偏保守中位，验收以真实运行的实测为准。

export const LEARNER_CONTEXT_STARTUP_BUDGET = {
  /** 启动段估计 token 上限（设计 §3.2：学伴 view ≤1000）。 */
  maxEstimatedTokens: 1000,
  /** 兜底字符硬顶：即使估计器失灵，启动段也不会顶穿 conversation_history 的 4000 字符总预算。 */
  maxChars: 2400,
} as const;

const CJK_RE = /[　-鿿豈-﫿＀-￯]/;

/** Deterministic token estimate; intentionally conservative for CJK-heavy text. */
export function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += CJK_RE.test(ch) ? 1.6 : 1 / 3.5;
  return Math.ceil(units);
}

export interface TrimUnit {
  /** Trim priority rank: 0 = kept longest, higher = dropped earlier. */
  readonly rank: number;
  readonly markdown: string | null;
}

/**
 * Trim ordered units to the token budget by dropping the lowest-priority present
 * units first (昨夜 → 信号 → 稳态画像 → 掌握和错因 → Δ；Steering 永不整段丢）。
 * Only when the remainder still overflows does it get a sentence-boundary
 * truncation marked with … — never a mid-sentence cut, and rank 0 (Steering)
 * keeps every complete sentence that fits.
 */
export function trimUnitsToBudget(
  units: readonly TrimUnit[],
  budget = LEARNER_CONTEXT_STARTUP_BUDGET,
): { markdown: string; estimatedTokens: number } {
  const kept = units
    .filter((u): u is TrimUnit & { markdown: string } => !!u.markdown && u.markdown.length > 0)
    .sort((a, b) => a.rank - b.rank);
  const render = () => kept.map((u) => u.markdown).join('\n');

  // Drop the largest-rank (lowest-priority) unit until the estimate fits; rank 0
  // (Steering) is never dropped whole — it takes the boundary truncation instead.
  while (kept.length > 1 && estimateTokens(render()) > budget.maxEstimatedTokens) {
    kept.pop();
  }
  let md = render();
  if (md.length > budget.maxChars) {
    const slice = md.slice(0, budget.maxChars);
    const boundary = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf('；'),
    );
    md = `${boundary > 0 ? slice.slice(0, boundary + 1) : slice}…`;
  }
  return { markdown: md, estimatedTokens: estimateTokens(md) };
}
