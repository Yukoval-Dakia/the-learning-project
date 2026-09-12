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
import {
  type SupplyDemandItem,
  buildSupplyExecutorDeps,
  executeSupplyPlan,
} from '@/capabilities/practice/public';
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
  payload: unknown;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── 1. 计划事件定位（accepted = payload.plan 非空） ──────────────────────
  let planRow: PlanEventRow | undefined;
  if (args.plan) {
    const rows = await db
      .select({ id: event.id, payload: event.payload })
      .from(event)
      .where(eq(event.id, args.plan));
    planRow = rows[0];
    if (!planRow) {
      console.error(`计划事件不存在: ${args.plan}`);
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

  const payload = planRow.payload as { plan?: { items?: unknown[] } | null };
  const planItems = payload?.plan?.items ?? [];
  if (planItems.length === 0) {
    console.error(`计划事件 ${planRow.id} 不是 accepted（无 plan.items）`);
    process.exit(1);
  }

  // ── 2. plan items → 需求项（planner phase-2 同映射；demand_id 用事件行回查） ──
  const demandRows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(and(eq(event.action, 'experimental:supply_planner_demand'), eq(event.outcome, 'manual')))
    .orderBy(event.created_at);
  const demandIdByItemIndex = new Map<number, string>();
  for (const row of demandRows) {
    const p = row.payload as { plan_event_id?: string; item?: { knowledge_id?: string } };
    if (p?.plan_event_id === planRow.id && p.item?.knowledge_id) {
      // 以 knowledge_id 对位（planner 逐项写 demand 事件，项序与 plan.items 一致）。
      const idx = planItems.findIndex(
        (it) => (it as { knowledge_id?: string }).knowledge_id === p.item?.knowledge_id,
      );
      if (idx >= 0 && !demandIdByItemIndex.has(idx)) demandIdByItemIndex.set(idx, row.id);
    }
  }

  const items: SupplyDemandItem[] = planItems.map((raw, index) => {
    const item = raw as {
      knowledge_id: string;
      kind: string;
      difficulty_band?: string | null;
      count: number;
      route_preference: string[];
      placement_claim_id?: string;
    };
    return {
      demandId: demandIdByItemIndex.get(index) ?? `manual_${planRow.id}_${index}`,
      knowledgeId: item.knowledge_id,
      kind: item.kind,
      difficultyBand: item.difficulty_band ?? null,
      count: item.count,
      routePreference: item.route_preference as SupplyDemandItem['routePreference'],
      ...(item.placement_claim_id ? { placementClaimId: item.placement_claim_id } : {}),
    };
  });

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
