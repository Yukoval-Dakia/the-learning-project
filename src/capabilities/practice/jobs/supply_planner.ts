// YUK-987 (985/E2) — supply_planner：供给需求层的 planner cron agent。
//
// 链路位置（照 spec）：
//   原始信号读面 → LLM 产出 SupplyPlanV1 → 确定性机器门（supply-plan-gate.ts）
//   → 门过：run 事件（accepted）+ 逐项 demand 事件（manual 留痕，E3 executor 未落地）
//   → 门拒（≤2 轮有界重生成后仍不过）：run 事件（rejected），当晚零需求事件
//   → 扫描器安全网：question_supply_nightly 照常 06:00 派发缺口，planner 失败/空
//     计划不影响它；本 job 与 DAG 无硬边（设计使然，安全网不被 planner 拖死）。
//   → shadow 对比：同 job 内跑 discoverSupplyTargets（只读确定性扫描），planner
//     需求 vs 扫描器目标同窗口对比事件，供 YUK-698 Phase D shadow planner 分析。
//
// 读面原则：喂给 LLM 的是原始信号（知识树 + 每 KC 可用/草稿题数 + 掌握信号 +
// 待处理 placement claim + jyeoo 预算余量），**不喂扫描器结论**——planner 需求
// 必须独立形成，shadow 对比才有信号价值。
//
// 运行留痕：runAgentTask 自动写 ai_task_runs + cost ledger（#71 语义：SDK 上报
// 正成本照记，未上报则 pricebook 估计）；本 job 的 run 事件额外汇总 task_run_ids
// 与 cost_micro_usd 供日聚合。所有事件 ingest_at=now 显式退出 mem0 事实层
// （inventory shadow 同款，ops 账本不是学习者事实）。

import { createId } from '@paralleldrive/cuid2';
import { eq, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { SupplyPlanItemV1T, SupplyPlanV1T } from '@/core/schema/supply_plan';
import type { Db } from '@/db/client';
import { knowledge, mastery_state, placement_starter_claim, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { enqueueSupplyDispatchJob } from '@/kernel/supply-dispatch';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolName,
  toMcpAllowedToolName,
} from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { jyeooBudgetRemaining } from '../server/question-supply/jyeoo-budget';
import {
  checkSupplyPlanKnowledgeIds,
  checkSupplyPlanStructure,
  parseSupplyPlanOutput,
} from '../server/question-supply/supply-plan-gate';
import { discoverSupplyTargets } from '../server/question-supply/target-discovery';

// planner 只挂只读知识图谱面（下钻核实节点）；与 QUIZ_GEN_READ_TOOLS 同集但独立
// 声明——共享 allowlist 矩阵扩张需显式决策（quiz_gen.ts 同款注释）。
const SUPPLY_PLANNER_READ_TOOLS = [
  'query_knowledge',
  'get_subject_graph_overview',
  'expand_knowledge_subgraph',
  'find_knowledge_paths',
] as const satisfies readonly DomainToolName[];

// 照 QUIZ_PLAN_MAX_ATTEMPTS（quiz_gen_plan.ts）：规划至多 2 轮，仍不过 fail closed。
const SUPPLY_PLAN_MAX_ATTEMPTS = 2;

// 非终态 placement claim（schema.ts placement_starter_claim 注释同集）：
// 这些 claim 是已声明未满足的供给需求，透传给 planner 并回填到 demand 事件。
const PLANNER_OPEN_CLAIM_STATUSES = [
  'pending_dispatch',
  'queued',
  'running',
  'verifying',
  'retry_scheduled',
] as const;

// 喂给 prompt 的前缘节点上限（树长大后的摘要闸；今日 12 节点远不及）。
const PLANNER_FRONTIER_CAP = 200;

// planner 的宿主科目 profile：跨科目规划以 math 为宿主（今日唯一科目）。
const PLANNER_HOST_SUBJECT = 'math';

// planner 的“当晚”日期按 Asia/Shanghai 历日（cron 05:50 CST = UTC 前一日 21:50，
// toISOString 会偏到前一天）。
const PLANNER_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// runAgentTask 返回的最小结构面（照 quiz_gen.ts TaskTextResult 注释同款）。
interface TaskTextResult {
  text: string;
  task_run_id?: string;
  cost_usd?: number | null;
}

type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  opts: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer>;
    allowedTools?: string[];
    subjectProfile: SubjectProfile;
  },
) => Promise<TaskTextResult>;

type BuildMcpServerFn = typeof buildMcpServerFromRegistry;

export interface SupplyPlannerDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  now?: () => Date;
  /** phase-2 入队口（默认 enqueueSupplyDispatchJob；db 测试注入 fake 断言载荷）。 */
  enqueueSupplyExecute?: (data: Record<string, unknown>) => Promise<string | null>;
}

export interface SupplyPlannerResult {
  outcome: 'accepted' | 'rejected';
  planItems: number;
  demandEvents: number;
  scannerTargets: number;
  shadowOverlap: number;
  attempts: number;
  rejections: string[][];
  planEventId: string;
  /** phase-2 供给执行入队结果（null = 入队失败已日志；undefined = 无 accepted plan）。 */
  executeJobId: string | null | undefined;
  shadowEventId: string | null;
}

// ── 原始信号读面 ────────────────────────────────────────────────────────────

interface KnowledgeRow {
  id: string;
  name: string;
  domain: string | null;
  parentId: string | null;
}

interface FrontierEntry {
  id: string;
  name: string;
  subject_id: string;
  theta: number | null;
  evidence_count: number;
  available_questions: number;
  draft_questions: number;
}

/**
 * 活知识节点 + 有效科目解析。子节点 domain=null（schema 注释），科目沿 parent
 * 链走到带 domain 的祖先（jyeoo-hint-match.ts 同款 getEffectiveDomain 语义）；
 * 断链节点返回 null 科目（仍算活节点，机检认 id，只是不进前缘列表）。
 */
async function loadLiveKnowledge(db: Db): Promise<{
  rows: KnowledgeRow[];
  subjectById: Map<string, string | null>;
}> {
  const raw = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parentId: knowledge.parent_id,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  const byId = new Map(raw.map((row) => [row.id, row]));
  const subjectCache = new Map<string, string | null>();
  const resolveSubject = (id: string, seen: Set<string>): string | null => {
    if (subjectCache.has(id)) return subjectCache.get(id) ?? null;
    if (seen.has(id)) return null; // 环防御
    seen.add(id);
    const row = byId.get(id);
    let subject: string | null = null;
    if (row) {
      subject = row.domain ?? (row.parentId ? resolveSubject(row.parentId, seen) : null);
    }
    subjectCache.set(id, subject);
    return subject;
  };
  const subjectById = new Map<string, string | null>();
  for (const row of raw) {
    subjectById.set(row.id, resolveSubject(row.id, new Set()));
  }
  return { rows: raw, subjectById };
}

/** 每 KC 题数：available = draft_status 非 'draft'（含 NULL），draft = 'draft'。 */
async function loadPoolCounts(db: Db): Promise<Map<string, { available: number; draft: number }>> {
  const rows = await db
    .select({ knowledgeIds: question.knowledge_ids, draftStatus: question.draft_status })
    .from(question);
  const counts = new Map<string, { available: number; draft: number }>();
  for (const row of rows) {
    const kcIds = Array.isArray(row.knowledgeIds) ? (row.knowledgeIds as string[]) : [];
    for (const kcId of kcIds) {
      const entry = counts.get(kcId) ?? { available: 0, draft: 0 };
      if (row.draftStatus === 'draft') {
        entry.draft += 1;
      } else {
        entry.available += 1;
      }
      counts.set(kcId, entry);
    }
  }
  return counts;
}

async function loadMasterySignals(
  db: Db,
): Promise<Map<string, { theta: number | null; evidenceCount: number }>> {
  const rows = await db
    .select({
      subjectId: mastery_state.subject_id,
      thetaHat: mastery_state.theta_hat,
      evidenceCount: mastery_state.evidence_count,
    })
    .from(mastery_state)
    .where(eq(mastery_state.subject_kind, 'knowledge'));
  return new Map(
    rows.map((row) => [row.subjectId, { theta: row.thetaHat, evidenceCount: row.evidenceCount }]),
  );
}

interface PendingClaim {
  claimId: string;
  subjectId: string;
  knowledgeId: string;
}

async function loadPendingClaims(db: Db): Promise<PendingClaim[]> {
  const rows = await db
    .select({
      claimId: placement_starter_claim.id,
      subjectId: placement_starter_claim.subject_id,
      knowledgeId: placement_starter_claim.knowledge_id,
      status: placement_starter_claim.status,
    })
    .from(placement_starter_claim);
  return rows
    .filter((row) => (PLANNER_OPEN_CLAIM_STATUSES as readonly string[]).includes(row.status))
    .map((row) => ({
      claimId: row.claimId,
      subjectId: row.subjectId,
      knowledgeId: row.knowledgeId,
    }));
}

function subjectDisplayName(subjectId: string): string {
  try {
    return resolveSubjectProfile(subjectId).displayName;
  } catch {
    return subjectId;
  }
}

// ── shadow 对比 ─────────────────────────────────────────────────────────────

function kcSetComparison(
  plannerKcs: ReadonlySet<string>,
  scannerKcs: ReadonlySet<string>,
): { overlap: string[]; plannerOnly: string[]; scannerOnly: string[] } {
  const overlap = [...plannerKcs].filter((kc) => scannerKcs.has(kc)).sort();
  const plannerOnly = [...plannerKcs].filter((kc) => !scannerKcs.has(kc)).sort();
  const scannerOnly = [...scannerKcs].filter((kc) => !plannerKcs.has(kc)).sort();
  return { overlap, plannerOnly, scannerOnly };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

export async function runSupplyPlanner(
  db: Db,
  deps: SupplyPlannerDeps = {},
): Promise<SupplyPlannerResult> {
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const now = deps.now?.() ?? new Date();

  // ── 1. 原始信号装配 ──────────────────────────────────────────────────────
  const [{ rows: knowledgeRows, subjectById }, poolCounts, mastery, pendingClaims, jyeooRemaining] =
    await Promise.all([
      loadLiveKnowledge(db),
      loadPoolCounts(db),
      loadMasterySignals(db),
      loadPendingClaims(db),
      jyeooBudgetRemaining(db, now),
    ]);

  const liveKnowledgeIds = new Set(knowledgeRows.map((row) => row.id));
  const frontier: FrontierEntry[] = knowledgeRows
    .filter((row) => row.parentId !== null) // 非根节点才是可规划格子
    .map((row) => {
      const counts = poolCounts.get(row.id) ?? { available: 0, draft: 0 };
      const signal = mastery.get(row.id);
      return {
        id: row.id,
        name: row.name,
        subject_id: subjectById.get(row.id) ?? 'unknown',
        theta: signal?.theta ?? null,
        evidence_count: signal?.evidenceCount ?? 0,
        available_questions: counts.available,
        draft_questions: counts.draft,
      };
    })
    .sort(
      (a, b) =>
        a.available_questions - b.available_questions ||
        a.evidence_count - b.evidence_count ||
        a.id.localeCompare(b.id),
    )
    .slice(0, PLANNER_FRONTIER_CAP);

  const subjectIds = [...new Set(frontier.map((entry) => entry.subject_id))].sort();
  const subjects = subjectIds.map((subjectId) => ({
    id: subjectId,
    display_name: subjectDisplayName(subjectId),
    knowledge_nodes: knowledgeRows.filter((row) => subjectById.get(row.id) === subjectId).length,
    frontier: frontier.filter((entry) => entry.subject_id === subjectId),
  }));

  const plannerInput: Record<string, unknown> = {
    date: PLANNER_DATE_FORMATTER.format(now),
    subjects,
    pending_placement_claims: pendingClaims.map((claim) => ({
      claim_id: claim.claimId,
      subject_id: claim.subjectId,
      knowledge_id: claim.knowledgeId,
    })),
    jyeoo_budget_remaining: jyeooRemaining,
  };

  // ── 2. LLM 规划 + 机器门（≤2 轮有界重生成） ──────────────────────────────
  const subjectProfile = resolveSubjectProfile(PLANNER_HOST_SUBJECT);
  const toolContextTaskRunId = `supply_planner_tool_${createId()}`;
  const mcpServers: Record<string, SdkMcpServer> = {
    [DOMAIN_TOOL_MCP_SERVER_NAME]: buildMcpServer({
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        callerActor: { kind: 'agent', ref: 'supply_planner' },
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames: SUPPLY_PLANNER_READ_TOOLS,
      taskKind: 'SupplyPlanTask',
    }),
  };
  const allowedTools = SUPPLY_PLANNER_READ_TOOLS.map((name) => toMcpAllowedToolName(name));

  let plan: SupplyPlanV1T | null = null;
  const planRejections: string[][] = [];
  const taskRunIds: string[] = [];
  let costUsdTotal = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= SUPPLY_PLAN_MAX_ATTEMPTS; attempt += 1) {
    const previousRejection = planRejections.flat().join('; ') || undefined;
    const attemptInput = previousRejection
      ? { ...plannerInput, previous_rejection: previousRejection }
      : plannerInput;
    attempts = attempt;
    const runResult = await run('SupplyPlanTask', attemptInput, {
      db,
      mcpServers,
      allowedTools,
      subjectProfile,
    });
    if (runResult.task_run_id) taskRunIds.push(runResult.task_run_id);
    costUsdTotal += runResult.cost_usd ?? 0;

    const parsed = parseSupplyPlanOutput(runResult.text);
    if (!parsed.ok) {
      planRejections.push(parsed.reasons);
      continue;
    }
    const reasons = [
      ...checkSupplyPlanStructure(parsed.plan, { jyeooBudgetRemaining: jyeooRemaining }),
      ...checkSupplyPlanKnowledgeIds(parsed.plan, liveKnowledgeIds),
    ];
    if (reasons.length === 0) {
      plan = parsed.plan;
      break;
    }
    planRejections.push(reasons);
  }

  // ── 3. run 事件（accepted / rejected）+ demand 留痕 ──────────────────────
  const claimByKnowledgeId = new Map<string, string>();
  for (const claim of pendingClaims) {
    if (!claimByKnowledgeId.has(claim.knowledgeId)) {
      claimByKnowledgeId.set(claim.knowledgeId, claim.claimId);
    }
  }

  const planEventId = `supply_planner_${createId()}`;
  const acceptedPlan: SupplyPlanV1T | null = plan;
  await writeEvent(db, {
    id: planEventId,
    actor_kind: 'agent',
    actor_ref: 'supply_planner',
    action: 'experimental:supply_planner',
    subject_kind: 'subject',
    subject_id: PLANNER_HOST_SUBJECT,
    outcome: acceptedPlan !== null ? 'accepted' : 'rejected',
    payload: {
      version: 1,
      date: plannerInput.date,
      plan: acceptedPlan,
      rejections: planRejections,
      attempts,
      task_run_ids: taskRunIds,
      jyeoo_budget_remaining: jyeooRemaining,
      pending_claim_ids: pendingClaims.map((claim) => claim.claimId),
      frontier_size: frontier.length,
    },
    cost_micro_usd: costUsdTotal > 0 ? Math.round(costUsdTotal * 1_000_000) : null,
    ingest_at: now,
    created_at: now,
  });

  let demandEvents = 0;
  const demandEventIds: string[] = [];
  if (acceptedPlan !== null) {
    for (const item of acceptedPlan.items) {
      const claimId = claimByKnowledgeId.get(item.knowledge_id);
      const demandEventId = `supply_planner_demand_${createId()}`;
      demandEventIds.push(demandEventId);
      await writeEvent(db, {
        id: demandEventId,
        actor_kind: 'agent',
        actor_ref: 'supply_planner',
        action: 'experimental:supply_planner_demand',
        subject_kind: 'knowledge',
        subject_id: item.knowledge_id,
        // 逐项留痕；E3 起由确定性 executor 消费（supply_execute 队列），
        // 完成链路见 experimental:supply_executor 事件。
        outcome: 'manual',
        payload: {
          version: 1,
          plan_event_id: planEventId,
          item,
          ...(claimId ? { placement_claim_id: claimId } : {}),
        },
        ingest_at: now,
        created_at: now,
      });
      demandEvents += 1;
    }
  }

  // ── 3.5 phase-2：accepted plan → 确定性 executor（当晚计划当晚执行） ────────
  // 入队而非内联：规划（LLM）与执行（工具链）各自独立 DLQ 重试语义；executor 幂等键
  // = plan_event_id，重投只吃 duplicate_exact 软拒。enqueue 失败不翻转 planner 结果
  // （plan 事件已写、扫描器安全网仍在）——日志给出手动重跑命令后继续。
  let executeEnqueued: string | null | undefined;
  if (acceptedPlan !== null && demandEventIds.length > 0) {
    const executePayload: Record<string, unknown> = {
      plan_event_id: planEventId,
      items: acceptedPlan.items.map((item, index) => ({
        demand_id: demandEventIds[index],
        knowledge_id: item.knowledge_id,
        kind: item.kind,
        difficulty_band: item.difficulty_band ?? null,
        count: item.count,
        route_preference: item.route_preference,
        ...(claimByKnowledgeId.has(item.knowledge_id)
          ? {
              placement_claim_id: claimByKnowledgeId.get(item.knowledge_id),
            }
          : {}),
      })),
    };
    const enqueueExecute =
      deps.enqueueSupplyExecute ??
      ((data: Record<string, unknown>) => enqueueSupplyDispatchJob('supply_execute', data));
    try {
      // 一次内联重试捱瞬时 boss 抖动；二次仍败 → 持久失败事件 + 手动重跑指令（Oracle P1-6）。
      executeEnqueued =
        (await enqueueExecute(executePayload)) ?? (await enqueueExecute(executePayload));
    } catch (enqueueError) {
      executeEnqueued = null;
      console.error(
        `[supply_planner] phase-2 enqueue failed twice (plan stands; scanner safety net unaffected; manual rerun: pnpm supply:execute --plan ${planEventId}):`,
        enqueueError,
      );
    }
    if (executeEnqueued === null) {
      await writeEvent(db, {
        id: `supply_planner_execute_${createId()}`,
        actor_kind: 'agent',
        actor_ref: 'supply_planner',
        action: 'experimental:supply_planner_execute',
        subject_kind: 'subject',
        subject_id: PLANNER_HOST_SUBJECT,
        outcome: 'failure',
        payload: { version: 1, plan_event_id: planEventId, reason: 'enqueue_failed' },
        ingest_at: now,
        created_at: now,
      });
    }
  }

  // ── 4. shadow 对比（planner 需求 vs 扫描器目标，同窗口） ──────────────────
  // discoverSupplyTargets 是只读确定性扫描（零 LLM）；每晚多跑一次的读成本可接受，
  // 换来同窗口精确对比（planner 不读扫描器结论，需求独立形成）。
  let shadowEventId: string | null = null;
  let scannerTargetCount = 0;
  let shadowOverlap = 0;
  try {
    const scannerTargets = await discoverSupplyTargets(db);
    scannerTargetCount = scannerTargets.length;
    const acceptedItems = acceptedPlan?.items ?? [];
    const plannerKcs = new Set(acceptedItems.map((item: SupplyPlanItemV1T) => item.knowledge_id));
    const scannerKcs = new Set(scannerTargets.flatMap((target) => target.knowledgeIds));
    const comparison = kcSetComparison(plannerKcs, scannerKcs);
    shadowOverlap = comparison.overlap.length;
    shadowEventId = `supply_planner_shadow_${createId()}`;
    await writeEvent(db, {
      id: shadowEventId,
      actor_kind: 'system',
      actor_ref: 'supply_planner_shadow',
      action: 'experimental:supply_planner_shadow',
      subject_kind: 'subject',
      subject_id: PLANNER_HOST_SUBJECT,
      outcome: 'success',
      payload: {
        version: 1,
        date: plannerInput.date,
        planner_outcome: acceptedPlan !== null ? 'accepted' : 'rejected',
        planner_item_count: acceptedItems.length,
        scanner_target_count: scannerTargets.length,
        ...comparison,
      },
      ingest_at: now,
      created_at: now,
    });
  } catch (shadowError) {
    // shadow 失败不翻转 planner 结果（观测面不是正确性路径）。
    console.warn(
      '[supply_planner] shadow comparison failed (planner result unaffected):',
      shadowError,
    );
  }

  return {
    outcome: acceptedPlan !== null ? 'accepted' : 'rejected',
    planItems: acceptedPlan?.items.length ?? 0,
    demandEvents,
    scannerTargets: scannerTargetCount,
    shadowOverlap,
    attempts,
    rejections: planRejections,
    planEventId,
    executeJobId: executeEnqueued,
    shadowEventId,
  };
}

export function buildSupplyPlannerHandler(
  db: Db,
  deps: SupplyPlannerDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runSupplyPlanner(db, deps);
      console.log('[supply_planner] result', result);
    } catch (err) {
      // LLM/DB 故障冒泡 → pg-boss DLQ 重试（llm 队列统一配方）；机器门拒绝是
      // 正常产出（rejected 事件已写），不走这里。
      console.error('[supply_planner] failed', err);
      throw err;
    }
  };
}
