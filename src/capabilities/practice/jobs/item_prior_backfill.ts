// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 冷启先验 backfill。
//
// 结构上仿 goal_scope_propose_nightly.ts：候选选择（无 item_calibration 硬轨 row
// 的题）→ 逐题跑 ItemPriorTask（单次结构化输出）→ parse → applyItemPrior 写 row。
//
// 幂等：applyItemPrior 用 onConflictDoNothing（item_calibration_question_unique），
// 已有 row 的题在候选 SELECT 阶段就被 anti-join 排除，双层兜底。出题 + 录入(OCR)
// 两条路径产生的新题都被同一 job 兜住——无需每条创建路径埋 hook。
//
// 失败语义：单题的 LLM/parse 失败只跳过该题（catch + 计数），不炸整个 job——
// 一道坏题不该阻断其余题的标定，下轮 job 再重试它（候选 SELECT 仍命中）。
// 候选 SELECT（pre-LLM DB read）的 throw 照常传播 → pg-boss 重试。

import { inArray, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { aggregateItemPriorRepDrafts } from '@/core/item-prior-reps';
import type { ItemPriorDraftT } from '@/core/schema/item_prior';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { parseItemPriorLlasaOutput, parseItemPriorOutput } from '@/server/ai/item-prior';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { resolveSubjectProfileForKnowledgeIds } from '../server/knowledge-runtime';
import {
  type PracticeTaskCallCtx,
  type PracticeTaskRunFn,
  makePracticeTaskRunFn,
} from '../server/task-runtime';

// YUK-376 — 冷启锚方法开关：'feature'（默认，ItemPriorTask feature→b，source=
// 'llm_prior'）| 'llasa'（ItemPriorLlasaTask 学生模拟反推 b，source=
// 'llm_prior_llasa'）。opt-in——默认路径（含输入形状）零变更。
export type ItemPriorMethod = 'feature' | 'llasa';

type DepsOverride = {
  runTaskFn?: PracticeTaskRunFn;
  /** 每轮最多标定多少题（防一次 job 打爆 LLM 预算）。default 25。 */
  maxPerRun?: number;
  /**
   * 先验方法选择。默认 'feature'；'llasa' 走 LLaSA 学生模拟反推 b。
   * 运行时也可经 job data { method: 'llasa' } 触发（pg-boss send 携带）。
   */
  method?: ItemPriorMethod;
  /**
   * YUK-1034 — feature 路径每题重复采样次数。默认 1（单次调用，行为不变）；
   * >1 时同题连跑 N 次 ItemPriorTask，b_logit/confidence 取 median 聚合
   * （src/core/item-prior-reps.ts），单个失败 rep 丢弃、全败才跳过该题
   * （沿用单题失败语义）。仅对 method='feature' 生效——llasa 忽略并 warn。
   * 运行时也可经 job data { reps: 3 } 触发。normalize：非正整数回退 1，
   * 上限 MAX_REPS（付费路径乘数，防 job data 手滑）。
   */
  reps?: number;
};

export interface ItemPriorBackfillResult {
  /** 本轮挑出的待标定题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功写入 calibration row 的题数。 */
  calibrated: number;
  /** 单题 LLM/parse 失败被跳过的题数（不阻断其余题）。 */
  skipped_failed: number;
}

const DEFAULT_MAX_PER_RUN = 25;

// YUK-1034 — reps 默认 1（行为不变）；上限防 opt-in job data 把付费乘数打爆
// （reps 把每题 LLM 成本 ×N，9 已远超实用值 3）。
const MAX_REPS = 9;

function normalizeReps(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return 1;
  if (raw > MAX_REPS) {
    console.warn('[item_prior_backfill] reps clamped', { requested: raw, max: MAX_REPS });
    return MAX_REPS;
  }
  return raw;
}

/**
 * YUK-1034 — feature→b 采样器：reps=1 退化为单次调用（与原路径逐字节等价，
 * 输入形状/hash 不变）；reps>1 连跑 N 次，逐 rep catch 丢弃失败（LLM/parse
 * 错只记 warn 不炸题），成功 drafts 走 median 聚合。全部失败 →
 * aggregateItemPriorRepDrafts throw → 外层按单题失败跳过（不写 row）。
 */
async function sampleFeaturePriorDraft(
  runTaskFn: PracticeTaskRunFn,
  input: unknown,
  ctx: PracticeTaskCallCtx,
  reps: number,
): Promise<ItemPriorDraftT> {
  if (reps <= 1) {
    const runResult = await runTaskFn('ItemPriorTask', input, ctx);
    return parseItemPriorOutput(runResult.text);
  }
  const drafts: ItemPriorDraftT[] = [];
  for (let r = 0; r < reps; r++) {
    try {
      const runResult = await runTaskFn('ItemPriorTask', input, ctx);
      drafts.push(parseItemPriorOutput(runResult.text));
    } catch (repErr) {
      console.warn('[item_prior_backfill] rep dropped from median', { rep: r, err: repErr });
    }
  }
  return aggregateItemPriorRepDrafts(drafts, reps).draft;
}

/**
 * Backfill cold-start difficulty anchors for questions that have no hard-track
 * `item_calibration` row yet. Picks at most `maxPerRun` candidates per run.
 */
export async function runItemPriorBackfill(
  db: Db,
  deps: DepsOverride = {},
): Promise<ItemPriorBackfillResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const method: ItemPriorMethod = deps.method ?? 'feature';
  const reps = normalizeReps(deps.reps);
  if (method === 'llasa' && reps > 1) {
    // YUK-1034 — reps 只挂在 feature 路径；llasa+reps 不静默吞掉，warn 留痕。
    console.warn('[item_prior_backfill] reps>1 ignored for method=llasa', { reps });
  }
  const result: ItemPriorBackfillResult = { considered: 0, calibrated: 0, skipped_failed: 0 };

  // PRE-LLM read OUTSIDE any per-task swallow: a throw here is a legit retryable
  // DB fault (pg-boss retries). Anti-join: questions with no hard-track
  // item_calibration row. NOT EXISTS keeps it index-friendly + idempotent.
  // reference_md/choices_md 只在 llasa 方法下进 LLM 输入（feature 输入保持原状）；
  // 一并 SELECT 避免按方法分两条查询（两列读取成本可忽略）。
  const candidates = await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM item_calibration ic
        WHERE ic.question_id = ${question.id} AND ic.track = 'hard'
      )`,
    )
    .limit(maxPerRun);

  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  const runTaskFn = deps.runTaskFn ?? makePracticeTaskRunFn(db);

  // Resolve knowledge names once for the union of all candidate knowledge ids.
  const allKnowledgeIds = Array.from(new Set(candidates.flatMap((c) => c.knowledge_ids ?? [])));
  const nameById = new Map<string, string>();
  if (allKnowledgeIds.length > 0) {
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, allKnowledgeIds));
    for (const r of rows) nameById.set(r.id, r.name);
  }

  for (const c of candidates) {
    try {
      const knowledgeContext = (c.knowledge_ids ?? [])
        .map((id) => ({ name: nameById.get(id) }))
        .filter((kc): kc is { name: string } => typeof kc.name === 'string');
      // Resolve the subject profile for the prompt rendering (cause taxonomy /
      // language style). Falls back to default profile when unlabeled.
      const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, c.knowledge_ids ?? []);
      // YUK-376 — llasa 输入带 reference_md/choices_md（模拟学生作答需要选项、
      // 判对错需要参考答案）；feature 输入保持原有三个字段，输入 hash 不变。
      const input =
        method === 'llasa'
          ? {
              prompt_md: c.prompt_md,
              kind: c.kind,
              knowledge_context: knowledgeContext,
              reference_md: c.reference_md,
              choices_md: c.choices_md,
            }
          : {
              prompt_md: c.prompt_md,
              kind: c.kind,
              knowledge_context: knowledgeContext,
            };
      // YUK-1034 — feature 路径经 sampleFeaturePriorDraft：reps=1 单次调用
      // （原语义），reps>1 N 次采样 median 聚合；llasa 保持单次调用不动。
      const draft =
        method === 'llasa'
          ? parseItemPriorLlasaOutput(
              (await runTaskFn('ItemPriorLlasaTask', input, { subjectProfile })).text,
            ).prior
          : await sampleFeaturePriorDraft(runTaskFn, input, { subjectProfile }, reps);
      await applyItemPrior(db, {
        questionId: c.id,
        draft,
        source: method === 'llasa' ? 'llm_prior_llasa' : 'llm_prior',
      });
      result.calibrated++;
    } catch (err) {
      // One bad question must not block the rest. Logged + counted; the next run
      // re-picks it (the candidate SELECT still matches — no row was written).
      console.error('[item_prior_backfill] question calibration failed', { questionId: c.id, err });
      result.skipped_failed++;
    }
  }

  return result;
}

export function buildItemPriorBackfillHandler(
  db: Db,
): (jobs: Job<{ method?: ItemPriorMethod; reps?: number }>[]) => Promise<JobYieldOutput> {
  return async (jobs) => {
    try {
      // YUK-376 — opt-in：pg-boss send('item_prior_backfill', { method: 'llasa' })
      // 触发 LLaSA 学生模拟路径（写 source='llm_prior_llasa'）；缺省/未知值恒回
      // 'feature'，cron 与既有 send 调用零变更。
      const requested = jobs[0]?.data?.method;
      const method: ItemPriorMethod = requested === 'llasa' ? 'llasa' : 'feature';
      // YUK-1034 — opt-in { reps: 3 }：feature 路径同题 N 次采样 median 聚合；
      // 缺省/非法值恒回 1（单次调用，行为不变）。
      const reps = normalizeReps(jobs[0]?.data?.reps);
      const result = await runItemPriorBackfill(db, { method, reps });
      console.log('[item_prior_backfill] result', result);
      // YUK-779 — the counters already existed; nothing acted on them. An empty
      // candidate set early-returns with considered:0 → level `idle`; a 限流风暴
      // fails every question → calibrated:0 → level `stalled` (loud + job output).
      // Invariant holds: considered === calibrated + skipped_failed.
      return reportJobYield('item_prior_backfill', {
        attempted: result.considered,
        succeeded: result.calibrated,
        failed: result.skipped_failed,
      });
    } catch (err) {
      console.error('[item_prior_backfill] failed', err);
      throw err;
    }
  };
}
