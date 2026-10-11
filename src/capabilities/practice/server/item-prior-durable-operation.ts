// YUK-1355: extracted item_prior_backfill operation, consumed by the retained
// pg-boss handler. The unregistered DBOS candidate only consumes the read functions.
// Provider errors do not prove that no paid effect occurred. Retained catch/skip
// behavior stays here; durable dispatch needs a separate safe claim/receipt owner.

import { inArray, sql } from 'drizzle-orm';
import { aggregateItemPriorRepDrafts } from '@/core/item-prior-reps';
import type { ItemPriorDraftT } from '@/core/schema/item_prior';

import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { parseItemPriorLlasaOutput, parseItemPriorOutput } from '@/server/ai/item-prior';
import { applyItemPrior } from '@/server/mastery/item-calibration';
import { resolveSubjectProfileForKnowledgeIds } from './knowledge-runtime';
import {
  type PracticeTaskCallCtx,
  type PracticeTaskRunFn,
  makePracticeTaskRunFn,
} from './task-runtime';

// YUK-376 — 冷启锚方法开关：'feature'（默认，ItemPriorTask feature→b，source=
// 'llm_prior'）| 'llasa'（ItemPriorLlasaTask 学生模拟反推 b，source=
// 'llm_prior_llasa'）。opt-in——默认路径（含输入形状）零变更。
export type ItemPriorMethod = 'feature' | 'llasa';

export type ItemPriorCandidateFrozen = Pick<
  typeof question.$inferSelect,
  'id' | 'kind' | 'prompt_md' | 'reference_md' | 'choices_md' | 'knowledge_ids'
>;

/** Normalized execution parameters; the retained handler owns job data parsing. */
export interface ItemPriorExecutionParams {
  method: ItemPriorMethod;
  reps: number;
}

export interface ItemPriorBackfillResult {
  /** 本轮挑出的待标定题数（capped by maxPerRun）。 */
  considered: number;
  /** 成功写入 calibration row 的题数。 */
  calibrated: number;
  /** 单题 LLM/parse 失败被跳过的题数（不阻断其余题）。 */
  skipped_failed: number;
}

export const DEFAULT_MAX_PER_RUN = 25;

// YUK-1034 — reps 生产默认 3（owner 2026-09-24 拍板启用；median SD 0.361→
// 0.173，≈+$0.0004/题）。上限防 job data 把付费乘数打爆（reps 把每题 LLM
// 成本 ×N，9 已远超实用值 3）。
export const DEFAULT_REPS = 3;
export const MAX_REPS = 9;

export function normalizeReps(raw: unknown): number {
  // 缺失/非正整数 → 生产默认（nightly cron 不带 job data → 3 reps）；
  // 显式 1 是合法 opt-out（落在下方范围分支返回）。
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return DEFAULT_REPS;
  if (raw > MAX_REPS) {
    console.warn('[item_prior_backfill] reps clamped', { requested: raw, max: MAX_REPS });
    return MAX_REPS;
  }
  return raw;
}

export function normalizeMethod(raw: unknown): ItemPriorMethod {
  return raw === 'llasa' ? 'llasa' : 'feature';
}

/** Pre-LLM read; errors propagate. Preserve the original unordered, capped query. */
export async function selectItemPriorCandidates(
  db: Db | Tx,
  maxPerRun: number,
): Promise<ItemPriorCandidateFrozen[]> {
  return db
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
}

/** 为候选并集一次性解析 knowledge 名（原 union 读，逐字节不变）。 */
export async function resolveItemPriorKnowledgeNames(
  db: Db | Tx,
  candidates: readonly ItemPriorCandidateFrozen[],
): Promise<Map<string, string>> {
  const allKnowledgeIds = Array.from(new Set(candidates.flatMap((c) => c.knowledge_ids ?? [])));
  const nameById = new Map<string, string>();
  if (allKnowledgeIds.length > 0) {
    const rows = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, allKnowledgeIds));
    for (const r of rows) nameById.set(r.id, r.name);
  }
  return nameById;
}

/**
 * YUK-1034 — feature→b 采样器：reps=1 退化为单次调用（与原路径逐字节等价，
 * 输入形状/hash 不变）；reps>1 连跑 N 次，逐 rep catch 丢弃失败（LLM/parse
 * 错只记 warn 不炸题），成功 drafts 走 median 聚合。全部失败 →
 * aggregateItemPriorRepDrafts throw → 调用方按单题失败处理。
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
 * 单题付费执行（本 family 的唯一付费入口）。语义与原文件循环体逐条对应：
 * knowledge context 组装、subject profile 解析、YUK-376 双方法输入形状
 * （llasa 带 reference_md/choices_md；feature 三字段不变）、YUK-1034 reps 采样。
 * 返回待写 draft 与 source。throw 不区分 provider 未调用、已付费或结果未知；
 * retained caller 继续 catch+skip，durable candidate 不调用本函数。
 */
export async function calibrateItemPriorQuestion(
  db: Db | Tx,
  runTaskFn: PracticeTaskRunFn,
  candidate: ItemPriorCandidateFrozen,
  nameById: ReadonlyMap<string, string>,
  params: ItemPriorExecutionParams,
): Promise<{ draft: ItemPriorDraftT; source: string }> {
  const knowledgeContext = (candidate.knowledge_ids ?? [])
    .map((id) => ({ name: nameById.get(id) }))
    .filter((kc): kc is { name: string } => typeof kc.name === 'string');
  // Resolve the subject profile for the prompt rendering (cause taxonomy /
  // language style). Falls back to default profile when unlabeled.
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(
    db,
    candidate.knowledge_ids ?? [],
  );
  // YUK-376 — llasa 输入带 reference_md/choices_md（模拟学生作答需要选项、
  // 判对错需要参考答案）；feature 输入保持原有三个字段，输入 hash 不变。
  const input =
    params.method === 'llasa'
      ? {
          prompt_md: candidate.prompt_md,
          kind: candidate.kind,
          knowledge_context: knowledgeContext,
          reference_md: candidate.reference_md,
          choices_md: candidate.choices_md,
        }
      : {
          prompt_md: candidate.prompt_md,
          kind: candidate.kind,
          knowledge_context: knowledgeContext,
        };
  // YUK-1034 — feature 路径经 sampleFeaturePriorDraft：reps=1 单次调用
  // （原语义），reps>1 N 次采样 median 聚合；llasa 保持单次调用不动。
  const draft =
    params.method === 'llasa'
      ? parseItemPriorLlasaOutput(
          (await runTaskFn('ItemPriorLlasaTask', input, { subjectProfile })).text,
        ).prior
      : await sampleFeaturePriorDraft(runTaskFn, input, { subjectProfile }, params.reps);
  return { draft, source: params.method === 'llasa' ? 'llm_prior_llasa' : 'llm_prior' };
}

/**
 * Retained domain write: applyItemPrior uses onConflictDoNothing(question_id).
 * A hard row alone does not bind a paid attempt, DAG member or submitted draft.
 */
export async function commitItemPriorCalibration(
  db: Db | Tx,
  candidate: ItemPriorCandidateFrozen,
  draft: ItemPriorDraftT,
  source: string,
): Promise<void> {
  await applyItemPrior(db, { questionId: candidate.id, draft, source });
}

/**
 * 原组合（pg-boss 路径语义保持）：候选 SELECT（throw 冒泡）→ union 读
 * knowledge 名 → 循环 per-question try/catch（单题失败跳过不阻断）→ 计数返回。
 */
export async function runItemPriorBackfillOperation(
  db: Db,
  deps: {
    method: ItemPriorMethod;
    reps: number;
    maxPerRun?: number;
    runTaskFn?: PracticeTaskRunFn;
  },
): Promise<ItemPriorBackfillResult> {
  const maxPerRun = deps.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const result: ItemPriorBackfillResult = { considered: 0, calibrated: 0, skipped_failed: 0 };

  const candidates = await selectItemPriorCandidates(db, maxPerRun);
  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  const runTaskFn = deps.runTaskFn ?? makePracticeTaskRunFn(db);
  const nameById = await resolveItemPriorKnowledgeNames(db, candidates);

  for (const c of candidates) {
    try {
      const { draft, source } = await calibrateItemPriorQuestion(db, runTaskFn, c, nameById, {
        method: deps.method,
        reps: deps.reps,
      });
      await commitItemPriorCalibration(db, c, draft, source);
      result.calibrated++;
    } catch (err) {
      // One bad question must not block the rest. Logged + counted; the next run
      // re-picks it (the candidate SELECT still matches — no row was written).
      console.error('[item_prior_backfill] question calibration failed', {
        questionId: c.id,
        err,
      });
      result.skipped_failed++;
    }
  }

  return result;
}
