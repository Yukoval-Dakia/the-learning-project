/**
 * YUK-988 (Supply-Agent/3) — 手动供给执行 caller（executor 三入口之三）。
 *
 * 确定性两步：读 accepted supply_planner 计划事件（--plan <id> | --latest）→
 * executeSupplyPlan 原地执行（planner phase-2 同款幂等：plan_event_id 键，重跑只吃
 * duplicate_exact 软拒）。也可 --dry-run 只打印将执行的需求项。
 *
 * 用法：
 *   pnpm supply:execute --latest                # 最新 accepted 计划
 *   pnpm supply:execute --plan <plan-event-id>  # 指定计划
 *   pnpm supply:execute --latest --dry-run      # 只看不动
 */
import { config } from 'dotenv';

config({ path: '.env', override: false });

import { and, desc, eq } from 'drizzle-orm';
import { buildSupplyExecutorDeps } from '@/capabilities/practice/jobs/supply_execute';
import {
  type SupplyDemandItem,
  executeSupplyPlan,
} from '@/capabilities/practice/server/question-supply/plan-executor';
import { SupplyPlanV1 } from '@/core/schema/supply_plan';
import { db } from '@/db/client';
import { event } from '@/db/schema';

interface CliArgs {
  plan: string | null;
  latest: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { plan: null, latest: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--latest') args.latest = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--plan') {
      args.plan = argv[i + 1];
      i += 1;
    } else {
      console.error(`未知参数: ${arg}（可用: --latest | --plan <id> | --dry-run）`);
      process.exit(2);
    }
  }
  if (!args.latest && !args.plan) {
    console.error('必须指定 --latest 或 --plan <plan-event-id>');
    process.exit(2);
  }
  return args;
}

interface PlanEventRow {
  id: string;
  action?: string;
  outcome?: string | null;
  payload: unknown;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── 1. 计划事件定位（accepted = payload.plan 非空） ──────────────────────
  let planRow: PlanEventRow | undefined;
  if (args.plan) {
    const rows = await db
      .select({
        id: event.id,
        action: event.action,
        outcome: event.outcome,
        payload: event.payload,
      })
      .from(event)
      .where(eq(event.id, args.plan));
    planRow = rows[0];
    if (!planRow) {
      console.error(`计划事件不存在: ${args.plan}`);
      process.exit(1);
    }
    // Oracle P2：不盲信任意事件 id——必须是 accepted 的 supply_planner 计划事件。
    if (planRow.action !== 'experimental:supply_planner' || planRow.outcome !== 'accepted') {
      console.error(
        `事件 ${args.plan} 不是 accepted 的 supply_planner 计划（action=${planRow.action}, outcome=${planRow.outcome}）`,
      );
      process.exit(1);
    }
  } else {
    const rows = await db
      .select({ id: event.id, payload: event.payload })
      .from(event)
      .where(and(eq(event.action, 'experimental:supply_planner'), eq(event.outcome, 'accepted')))
      .orderBy(desc(event.created_at))
      .limit(1);
    planRow = rows[0];
    if (!planRow) {
      console.error('没有 accepted 的 supply_planner 计划事件');
      process.exit(1);
    }
  }

  const payload = planRow.payload as { plan?: unknown } | null;
  const planParsed = SupplyPlanV1.safeParse(payload?.plan);
  if (!planParsed.success) {
    console.error(
      `计划事件 ${planRow.id} 的 plan 载荷未过 SupplyPlanV1 校验：${planParsed.error.issues.map((i) => i.message).join('; ')}`,
    );
    process.exit(1);
  }
  const planItems = planParsed.data.items;
  if (planItems.length === 0) {
    console.error(`计划事件 ${planRow.id} 无 plan.items`);
    process.exit(1);
  }

  // ── 2. plan items → 需求项（Oracle P2：planner 逐项按 plan 顺序写 demand 事件——
  // 按 plan_event_id 过滤后 created_at 序与 items 索引对位，同 KC 多项不串位；
  // placement claim 从 demand 事件载荷取（plan item 本身不带）。──
  const demandRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(eq(event.action, 'experimental:supply_planner_demand'))
    .orderBy(event.created_at, event.dispatch_seq);
  const planDemandRows = demandRows.filter(
    (row) =>
      ((row.payload as { plan_event_id?: string } | null)?.plan_event_id ?? undefined) ===
      planRow.id,
  );
  const demandIdByItemIndex = new Map<number, string>();
  const claimIdByItemIndex = new Map<number, string>();
  planItems.forEach((_, index) => {
    const row = planDemandRows[index];
    if (!row) return;
    demandIdByItemIndex.set(index, row.id);
    const claimId = (row.payload as { placement_claim_id?: string } | null)?.placement_claim_id;
    if (claimId) claimIdByItemIndex.set(index, claimId);
  });

  const items: SupplyDemandItem[] = planItems.map((item, index) => ({
    demandId: demandIdByItemIndex.get(index) ?? `manual_${planRow.id}_${index}`,
    knowledgeId: item.knowledge_id,
    kind: item.kind,
    difficultyBand: item.difficulty_band ?? null,
    count: item.count,
    routePreference: item.route_preference as SupplyDemandItem['routePreference'],
    ...(claimIdByItemIndex.get(index) ? { placementClaimId: claimIdByItemIndex.get(index) } : {}),
  }));

  console.log(`计划 ${planRow.id} → ${items.length} 需求项:`);
  for (const item of items) {
    console.log(
      `  - ${item.knowledgeId} ×${item.count} kind=${item.kind} band=${item.difficultyBand ?? '-'} routes=[${item.routePreference.join(' → ')}]`,
    );
  }
  if (args.dryRun) {
    console.log('--dry-run：不执行。');
    return;
  }

  // ── 3. 原地执行（生产 deps；幂等键 = plan_event_id） ────────────────────
  const result = await executeSupplyPlan(
    {
      db,
      planEventId: planRow.id,
      items,
      ctx: { taskRunId: `supply_execute_manual_${planRow.id}` },
    },
    buildSupplyExecutorDeps(db),
  );
  if (result.status === 'already_executed') {
    console.log(`该计划已执行过（事件 ${result.priorEventId}）——幂等短路，未重复执行。`);
    return;
  }
  console.log(`执行完成（事件 ${result.eventId}）：`);
  for (const item of result.results) {
    const routes = item.routes
      .map((r) => `${r.route}:${r.status}${r.skipped ? `(${r.skipped})` : ''} +${r.acquired}`)
      .join(' ');
    console.log(
      `  - ${item.knowledgeId} → ${routes}${item.skipped ? ` [item skipped: ${item.skipped}]` : ''}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('supply:execute failed:', err);
    process.exit(1);
  });
