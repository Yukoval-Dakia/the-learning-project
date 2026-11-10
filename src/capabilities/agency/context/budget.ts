// 启动段预算与裁剪（YUK-1794 B1）。token 数用 kernel 的确定性估计器（不是真实
// tokenizer）。概况头有自己的预算，不计入对话历史。

import { estimateContextTokens } from '@/kernel/tools/budgets';

export const LEARNER_CONTEXT_STARTUP_BUDGET = {
  /** 启动段估计 token 上限（设计 §3.2：学伴 view ≤1000）。 */
  maxEstimatedTokens: 1000,
  /** 启动段自己的字符硬顶，与对话历史预算分开。 */
  maxChars: 2400,
} as const;

export interface TrimUnit {
  /** Render order AND default drop priority: 0 = rendered first, kept longest. */
  readonly rank: number;
  /**
   * Drop priority override (higher = dropped earlier). Defaults to `rank`.
   * §13「怎么和我说话」要常驻，所以 YUK-1811 的明细段各自成 unit、dropRank
   * 比所有基础段高：预算紧时先丢明细、不动既有段落，也给 §13 留空间。
   */
  readonly dropRank?: number;
  readonly protected?: boolean;
  /** 遥测名：被裁时按名字记（只记名不记内容）。 */
  readonly name: string;
  readonly markdown: string | null;
}

export interface TrimResult {
  readonly markdown: string;
  readonly estimatedTokens: number;
  /** 按裁剪顺序记录的被裁单元名（present 但被丢的；缺 markdown 的不算被裁）。 */
  readonly droppedUnits: string[];
  /** 一个单元都没丢时整段渲染的估计 token（裁前值）。 */
  readonly tokensBeforeTrim: number;
}

/**
 * Trim ordered units to the token budget by dropping the lowest-priority present
 * units first（明细 → 昨夜 → 信号 → 稳态画像 → 掌握和错因 → Δ；Steering 永不整段丢）。
 * Only when the remainder still overflows does it get a sentence-boundary
 * truncation marked with … — never a mid-sentence cut, and rank 0 (Steering)
 * keeps every complete sentence that fits.
 */
export function trimUnitsToBudget(
  units: readonly TrimUnit[],
  budget: { maxEstimatedTokens: number; maxChars: number } = LEARNER_CONTEXT_STARTUP_BUDGET,
): TrimResult {
  const kept = units
    .filter((u): u is TrimUnit & { markdown: string } => !!u.markdown && u.markdown.length > 0)
    .sort((a, b) => a.rank - b.rank);
  const render = () => kept.map((u) => u.markdown).join('\n');
  const tokensBeforeTrim = estimateContextTokens(render());
  const droppedUnits: string[] = [];

  // Drop the highest-dropRank (lowest-priority) unit until the estimate fits;
  // rank 0 (Steering) is never dropped whole — it takes the boundary truncation instead.
  while (
    estimateContextTokens(render()) > budget.maxEstimatedTokens ||
    render().length > budget.maxChars
  ) {
    const candidates = kept.filter((u) => u.rank !== 0 && !u.protected);
    const drop = candidates.sort((a, b) => (b.dropRank ?? b.rank) - (a.dropRank ?? a.rank))[0];
    if (!drop) break;
    droppedUnits.push(drop.name);
    kept.splice(kept.indexOf(drop), 1);
  }
  let md = render();
  if (estimateContextTokens(md) > budget.maxEstimatedTokens || md.length > budget.maxChars) {
    const steering = kept.find((u) => u.rank === 0);
    if (steering) {
      const protectedText = kept
        .filter((u) => u !== steering)
        .map((u) => u.markdown)
        .join('\n');
      let text = steering.markdown;
      const fits = () =>
        estimateContextTokens(`${text}…\n${protectedText}`) <= budget.maxEstimatedTokens &&
        text.length + protectedText.length + 2 <= budget.maxChars;
      while (text.length && !fits()) text = text.slice(0, -1);
      const boundary = Math.max(
        text.lastIndexOf('。'),
        text.lastIndexOf('\n'),
        text.lastIndexOf('；'),
      );
      if (boundary > 0) text = text.slice(0, boundary + 1);
      steering.markdown = `${text}…`;
      md = render();
    }
    if (estimateContextTokens(md) > budget.maxEstimatedTokens || md.length > budget.maxChars)
      throw new Error('communication brief exceeds its compact storage contract');
  }
  return {
    markdown: md,
    estimatedTokens: estimateContextTokens(md),
    droppedUnits,
    tokensBeforeTrim,
  };
}
