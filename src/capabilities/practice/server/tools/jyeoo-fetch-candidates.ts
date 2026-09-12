// YUK-986 (Supply-Agent/1) — `jyeoo_fetch_candidates` DomainTool（effect:'read'）。
//
// 供给 agent 化（YUK-985 epic）的 jyeoo fetch 面：bounded subprocess 跑 jyeoo-rs grade
// 路线，返回【自包含候选】——图片已 staged（R2 + source_asset，origin='jyeoo_staged'）、
// markdown URL 已改写为内部资产 URL、extraction_hash = loom canonical hash（THE dedup
// key）。本工具不写 question；提交走 `store_sourced_question`（dedup/verify 链权威判定
// 在那侧，agent 只传候选与 knowledge_ids）。
//
// effect 判 'read' 的理由：唯一的持久写是 staged 图片资产——那是对后续 commit 的
// 可恢复 fetch 缓存（未提交由 reaper 回收），不是 learner/domain 数据；question 写入
// 只发生在 store_sourced_question（effect:'write'）。costClass 'local'（无 LLM），但
// producer 内容是付费账号资源——治理经 jyeoo-budget 日租约（本工具 pre-flight 读取并把
// session_max 裁进余额），不走 LLM 预算。
//
// Canary：每次运行（含失败）写 action='experimental:jyeoo_fetch' 事件——这同时是预算
// 账本（jyeoo-budget 按当日 success 事件的 counts.fetched 求和）与漏斗观测面
// （requested → fetched → validated → filtered → candidates → 下游 commit/verify）。

import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod';
import { SourcedQuestion } from '@/core/schema/sourcing';
import { FigureRef, StructuredQuestion } from '@/core/schema/structured_question';
import { writeEvent } from '@/kernel/events';
import type { DomainTool } from '@/kernel/tools/types';
import { JYEOO_FETCH_CANARY_ACTION } from '../question-supply/jyeoo-budget';
import {
  JYEOO_GRADES,
  type JyeooFetchCandidatesResult,
  runJyeooFetchCandidates,
} from '../question-supply/jyeoo-candidates';

const inputSchema = z.object({
  /** 年级：10 高一 / 11 高二 / 12 高三（producer --grade）。 */
  grade: z.union([z.literal(10), z.literal(11), z.literal(12)]),
  /** producer 学科 id（默认 math2——当前唯一注册 producer 学科）。 */
  subject: z.string().trim().min(1).default('math2'),
  /** 发现侧列表页数（免费）。默认 2。 */
  pages: z.number().int().min(1).max(10).default(2),
  /** 发现侧试卷上限（免费）。默认 2。 */
  max_papers: z.number().int().min(1).max(20).default(2),
  /** 本次内容拉取上限（付费预算口）；服务端再裁到当日预算余额内。默认 10。 */
  session_max: z.number().int().min(1).max(40).default(10),
  /** 可选 kind pin：不匹配题在入库前丢弃（如 'choice'）。 */
  kind: z.string().trim().min(1).optional(),
  /** 可选难度带 post-filter（grade 路线无 --dg；near≈3、below≤2、above=4、stretch≥5）。 */
  difficulty_band: z.enum(['below', 'near', 'above', 'stretch']).optional(),
});

const candidateSchema = z.object({
  candidate_id: z.string(),
  question: SourcedQuestion,
  extraction_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  knowledge_hints: z.array(z.string()),
  source_id: z.string().nullable(),
  figures: z.array(FigureRef).nullable(),
  image_refs: z.array(z.string()).nullable(),
  structured: StructuredQuestion.nullable(),
  staged_asset_ids: z.array(z.string()),
});

const countsSchema = z.object({
  requested: z.number().int(),
  fetched: z.number().int(),
  validated: z.number().int(),
  invalid: z.number().int(),
  filtered_url: z.number().int(),
  filtered_kind: z.number().int(),
  filtered_band: z.number().int(),
  filtered_image: z.number().int(),
  deduped_exact: z.number().int(),
  near_dup_in_batch: z.number().int(),
  candidates: z.number().int(),
});

const budgetSchema = z.object({
  daily_budget: z.number().int(),
  remaining_before: z.number().int(),
  remaining_after: z.number().int(),
});

const droppedSchema = z.object({
  source_url: z.string().nullable(),
  source_id: z.string().nullable(),
  reason: z.enum([
    'invalid',
    'filtered_url',
    'filtered_kind',
    'filtered_band',
    'filtered_image',
    'duplicate_exact',
    'near_dup_in_batch',
  ]),
});

const outputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    run_id: z.string(),
    candidates: z.array(candidateSchema),
    dropped: z.array(droppedSchema),
    counts: countsSchema,
    budget: budgetSchema,
  }),
  z.object({ status: z.literal('budget_exhausted'), budget: budgetSchema }),
  z.object({
    status: z.literal('failed'),
    failure_class: z.enum([
      'auth',
      'vip',
      'network',
      'timeout',
      'parse',
      'args',
      'spawn',
      'unknown',
    ]),
    detail: z.string(),
    retryable: z.boolean(),
    counts: countsSchema,
    budget: budgetSchema,
  }),
]);

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

function toOutput(result: JyeooFetchCandidatesResult): Output {
  if (result.status === 'budget_exhausted') {
    return {
      status: 'budget_exhausted',
      budget: {
        daily_budget: result.budget.dailyBudget,
        remaining_before: result.budget.remainingBefore,
        remaining_after: result.budget.remainingAfter,
      },
    };
  }
  if (result.status === 'failed') {
    return {
      status: 'failed',
      failure_class: result.failureClass,
      detail: result.detail,
      retryable: result.retryable,
      counts: result.counts,
      budget: {
        daily_budget: result.budget.dailyBudget,
        remaining_before: result.budget.remainingBefore,
        remaining_after: result.budget.remainingAfter,
      },
    };
  }
  return {
    status: 'ok',
    run_id: result.runId,
    candidates: result.candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      question: candidate.question,
      extraction_hash: candidate.extractionHash,
      knowledge_hints: candidate.knowledgeHints,
      source_id: candidate.sourceId,
      figures: candidate.figures,
      image_refs: candidate.imageRefs,
      structured: candidate.structured,
      staged_asset_ids: candidate.stagedAssetIds,
    })),
    dropped: result.dropped.map((drop) => ({
      source_url: drop.sourceUrl,
      source_id: drop.sourceId,
      reason: drop.reason,
    })),
    counts: result.counts,
    budget: {
      daily_budget: result.budget.dailyBudget,
      remaining_before: result.budget.remainingBefore,
      remaining_after: result.budget.remainingAfter,
    },
  };
}

export const jyeooFetchCandidatesTool: DomainTool<Input, Output> = {
  name: 'jyeoo_fetch_candidates',
  description:
    '从 jyeoo-rs（菁优网题库，付费账号日预算 40 题）按年级/学科抓取真实考题候选。' +
    '返回自包含候选（图片已本地化、含 dedup hash），不写库；提交入库须调 store_sourced_question。' +
    'budget_exhausted 时当日勿再调用；failed 按 retryable 决定是否重试。',
  effect: 'read',
  inputSchema,
  outputSchema,
  costClass: 'local',
  // 无 safeHandoff：staged 资产 + canary 事件是 db 写，registry 只允许 idempotent read 远程
  // handoff——本工具固定 in-process 执行（E1 也无远程调用方）。
  mirrorEvent: 'when_causal',
  async execute(ctx, input) {
    const result = await runJyeooFetchCandidates({
      db: ctx.db,
      input: {
        grade: input.grade,
        subject: input.subject,
        pages: input.pages,
        maxPapers: input.max_papers,
        sessionMax: input.session_max,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.difficulty_band ? { difficultyBand: input.difficulty_band } : {}),
      },
      // resolveR2 缺省走 candidates 模块的内部默认（practice 内 r2 访问单主）。
    });

    // Canary 事件 = 预算账本 + 漏斗观测。失败于事件写入不得翻转工具结果（事件丢失可接受，
    // 预算硬闸在 producer）；包 try/catch 与旧 handler 一致。
    try {
      await writeEvent(ctx.db, {
        id: createId(),
        session_id: ctx.sessionId ?? null,
        actor_kind: 'agent',
        actor_ref: 'jyeoo_fetch',
        action: JYEOO_FETCH_CANARY_ACTION,
        subject_kind: 'query',
        subject_id: result.status === 'ok' ? result.runId : `jyeoo_candidates_${createId()}`,
        outcome: result.status === 'failed' ? 'failure' : 'success',
        payload: {
          route: 'grade',
          ...input,
          tool: 'jyeoo_fetch_candidates',
          task_run_id: ctx.taskRunId,
          ...(result.status === 'ok'
            ? {
                candidate_ids: result.candidates.map((candidate) => candidate.candidateId),
                counts: result.counts,
                budget: result.budget,
              }
            : result.status === 'failed'
              ? {
                  failure_class: result.failureClass,
                  failure_detail: result.detail,
                  counts: result.counts,
                  budget: result.budget,
                }
              : { budget: result.budget }),
        },
        caused_by_event_id: ctx.causedByEventId ?? null,
        task_run_id: ctx.taskRunId,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    } catch (eventErr) {
      console.error('[jyeoo_fetch_candidates] canary event write failed; result stands:', eventErr);
    }

    return toOutput(result);
  },
  summarize(input, output) {
    if (output.status === 'budget_exhausted') {
      return `jyeoo 预算已尽（日 ${output.budget.daily_budget}）`;
    }
    if (output.status === 'failed') {
      return `jyeoo 抓取失败 · ${output.failure_class}${output.retryable ? ' · 可重试' : ''}`;
    }
    return `jyeoo 候选 ${output.counts.candidates} · 抓 ${output.counts.fetched} · 预算余 ${output.budget.remaining_after} · g${input.grade}/${input.subject}`;
  },
};
