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

type KeptUnit = TrimUnit & { markdown: string };

/**
 * Trim ordered units to the token budget by dropping the lowest-priority present
 * units first（明细 → 昨夜 → 信号 → 稳态画像 → 掌握和错因 → Δ；Steering 整段最后丢）。
 * Only when the remainder still overflows does it get a sentence-boundary
 * truncation marked with … — never a mid-sentence cut, and rank 0 (Steering)
 * keeps every complete sentence that fits.
 *
 * Protected units are bounded upstream but cannot be shown to fit every explicit
 * budget: the curator view runs at 800 tokens while the learner-written communication
 * brief may use its full 400 characters. So they degrade too — shortened at a
 * sentence boundary first, dropped last — and the result is finally clamped. Every
 * step strictly shrinks the render, so no learner input makes this throw or spin.
 */
export function trimUnitsToBudget(
  units: readonly TrimUnit[],
  budget: { maxEstimatedTokens: number; maxChars: number } = LEARNER_CONTEXT_STARTUP_BUDGET,
): TrimResult {
  const kept: KeptUnit[] = units
    .filter((u): u is KeptUnit => !!u.markdown && u.markdown.length > 0)
    .sort((a, b) => a.rank - b.rank);
  const over = (text: string) =>
    estimateContextTokens(text) > budget.maxEstimatedTokens || text.length > budget.maxChars;
  const render = (override?: { unit: KeptUnit; text: string }) =>
    kept
      .map((u) => (u === override?.unit ? override.text : u.markdown))
      .filter((text) => text.length > 0)
      .join('\n');
  const tokensBeforeTrim = estimateContextTokens(render());
  const droppedUnits: string[] = [];
  const lowestPriority = (filter: (unit: KeptUnit) => boolean) =>
    kept.filter(filter).sort((a, b) => (b.dropRank ?? b.rank) - (a.dropRank ?? a.rank))[0];
  const drop = (unit: KeptUnit) => {
    droppedUnits.push(unit.name);
    kept.splice(kept.indexOf(unit), 1);
  };
  /**
   * Longest whole-sentence prefix (plus …) that still fits in place, or null when no
   * strict shortening exists. Returning null keeps the caller's loop progressing: it
   * drops the unit instead of retrying the same text.
   */
  const shorten = (unit: KeptUnit): string | null => {
    const full = unit.markdown;
    const fits = (length: number) => !over(render({ unit, text: `${full.slice(0, length)}…` }));
    let low = 0;
    let high = full.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    let cut = full.slice(0, low);
    const boundary = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'), cut.lastIndexOf('；'));
    if (boundary > 0) cut = cut.slice(0, boundary + 1);
    if (cut.length === 0 || cut.length >= full.length) return null;
    return `${cut}…`;
  };

  // 1. Drop the highest-dropRank (lowest-priority) unit until the estimate fits;
  // rank 0 (Steering) is never dropped whole — it takes the boundary truncation instead.
  while (over(render())) {
    const next = lowestPriority((u) => u.rank !== 0 && !u.protected);
    if (!next) break;
    drop(next);
  }

  // 2. Steering keeps every complete sentence that fits beside the resident units.
  // When not even an ellipsis fits, its text is parked and the line waits empty while
  // step 3 frees room from resident content.
  const parked = { text: null as string | null };
  const fitSteering = () => {
    const steering = kept.find((u) => u.rank === 0);
    if (!steering || !over(render())) return;
    const text = shorten(steering);
    if (text) {
      steering.markdown = text;
      return;
    }
    parked.text = steering.markdown;
    steering.markdown = '';
  };
  fitSteering();

  // 3. Resident content still cannot coexist with even an emptied steering line (a
  // 400-char communication brief plus the stage line against the curator's 800):
  // shorten it lowest-priority first, dropping a unit only when it cannot shorten.
  while (over(render())) {
    const next = lowestPriority((u) => u.protected === true && u.rank !== 0);
    if (!next) break;
    const text = shorten(next);
    if (text) next.markdown = text;
    else drop(next);
  }
  // Room freed by step 3 goes back to steering.
  const parkedSteering = kept.find((u) => u.rank === 0);
  if (parkedSteering && parked.text !== null) {
    parkedSteering.markdown = parked.text;
    parked.text = null;
    fitSteering();
  }

  // 4. A budget below even that: drop residents one by one, then steering, then clamp.
  // The caller still gets a header instead of an exception.
  while (over(render())) {
    const next = lowestPriority((u) => u.rank !== 0);
    if (!next) break;
    drop(next);
  }
  if (over(render())) {
    const steering = kept.find((u) => u.rank === 0);
    if (steering) drop(steering);
  }
  let md = render();
  if (over(md)) {
    let low = 0;
    let high = md.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (over(`${md.slice(0, mid)}…`)) high = mid - 1;
      else low = mid;
    }
    md = low > 0 ? `${md.slice(0, low)}…` : '';
  }
  return {
    markdown: md,
    estimatedTokens: estimateContextTokens(md),
    droppedUnits,
    tokensBeforeTrim,
  };
}
