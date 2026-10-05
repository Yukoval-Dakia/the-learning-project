// YUK-987 (985/E2) — SupplyPlan 确定性机器门（纯函数，零 DB import）。
//
// 照 quiz_gen_plan.ts 形状：LLM 产出的 SupplyPlan JSON 先过 lenient parse
// （JSON 抽取 + 严格 zod），再过语义机检（结构去重 / 预算声明 vs 当日剩余 /
// 活 knowledge_id）。拒绝原因以字符串数组返回，由 caller 回喂 LLM 做 ≤2 轮
// 有界重生成；仍不过则 fail closed。LLM 永远在判断路径上，永远不在正确性路径上。

import {
  type SupplyPlanItemV1T,
  SupplyPlanV1,
  type SupplyPlanV1T,
} from '@/core/schema/supply_plan';

export type SupplyPlanParseResult =
  | { ok: true; plan: SupplyPlanV1T }
  | { ok: false; reasons: string[] };

/**
 * Lenient LLM-output parse: extract the first JSON object from the text, then
 * strict-parse it. Never throws — failure reasons are data so the caller can feed
 * them back into the bounded regeneration loop.
 */
export function parseSupplyPlanOutput(text: string): SupplyPlanParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reasons: ['empty output'] };
  }
  const candidate = trimmed.startsWith('{')
    ? trimmed
    : (() => {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
      })();
  try {
    const parsed = SupplyPlanV1.safeParse(JSON.parse(candidate));
    if (!parsed.success) {
      const reasons = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      return { ok: false, reasons };
    }
    return { ok: true, plan: parsed.data };
  } catch (error) {
    return { ok: false, reasons: [`invalid JSON: ${(error as Error).message}`] };
  }
}

function itemKey(item: SupplyPlanItemV1T): string {
  return `${item.knowledge_id}::${item.kind}::${item.difficulty_band}`;
}

/**
 * 结构机检（不依赖 DB 的部分）：
 * - 同 (knowledge_id, kind, difficulty_band) 格子重复 → 拒（迫使 planner 合并，
 *   避免同一格子被两份需求重复计数）；
 * - 声明的 jyeoo 预算 > 当日剩余 → 拒（需求侧自约束不能超物理预算）；
 * - route_preference 仅含 'jyeoo_fetch' 的项的 count 总和 > 声明预算 → 拒
 *   （声明预算必须覆盖它想走的付费路线；含非 jyeoo 路线的项可由他路承担）。
 */
export function checkSupplyPlanStructure(
  plan: SupplyPlanV1T,
  opts: { jyeooBudgetRemaining: number },
): string[] {
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  plan.items.forEach((item, index) => {
    const key = itemKey(item);
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      reasons.push(
        `items[${index}] duplicates items[${firstIndex}] (${key}) — merge into one item`,
      );
    } else {
      seen.set(key, index);
    }
  });
  if (plan.budget.jyeoo_questions > opts.jyeooBudgetRemaining) {
    reasons.push(
      `budget.jyeoo_questions ${plan.budget.jyeoo_questions} exceeds remaining daily budget ${opts.jyeooBudgetRemaining}`,
    );
  }
  const jyeooOnlyCount = plan.items
    .filter((item) => item.route_preference.every((route) => route === 'jyeoo_fetch'))
    .reduce((sum, item) => sum + item.count, 0);
  if (jyeooOnlyCount > plan.budget.jyeoo_questions) {
    reasons.push(
      `jyeoo-only items request ${jyeooOnlyCount} questions but budget.jyeoo_questions declares ${plan.budget.jyeoo_questions}`,
    );
  }
  return reasons;
}

/**
 * 活 knowledge_id 机检：计划引用的每个 knowledge_id 必须在 caller 提供的活节点集里。
 * 模块保持纯函数——活节点集由 caller 从 DB 读出传入（照 checkPlanKnowledgeIds）。
 */
export function checkSupplyPlanKnowledgeIds(
  plan: SupplyPlanV1T,
  liveKnowledgeIds: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  const checked = new Set<string>();
  plan.items.forEach((item, index) => {
    if (checked.has(item.knowledge_id)) return;
    checked.add(item.knowledge_id);
    if (!liveKnowledgeIds.has(item.knowledge_id)) {
      reasons.push(
        `items[${index}].knowledge_id '${item.knowledge_id}' is not a live knowledge node`,
      );
    }
  });
  return reasons;
}
