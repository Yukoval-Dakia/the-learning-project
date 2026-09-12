// YUK-986 (Supply-Agent/1) — `store_sourced_question` DomainTool（effect:'write'）。
//
// 供给 agent 化的统一 COMMIT seam：jyeoo（本票）、web 搜寻与生成候选（YUK-988/E3）
// 都经本工具入库。agent 决定【提交什么、挂哪些知识节点】；本工具强制执行【能不能进池】：
//
//   - knowledge_ids 活体校验（任何 archived/不存在 ⇒ rejected:dead_knowledge_node，
//     与 sourcing 的 live-id 约束一致——死节点不得挂新材料）；
//   - exact-dup = canonical hash 权威判定：mergeExact 预检（命中 ⇒ rejected:duplicate_exact
//     + 目标 KC 并入既有行，YUK-720 cross-KC merge），insertSourcedDraft 的 ON CONFLICT
//     兜并发 race；
//   - near-dup = KC-scoped active+draft 池 n-gram ≥ 0.7 ⇒ rejected:near_dup（旧
//     jyeoo_fetch pre-persist prefilter 原语义，移到 commit 因为只有此时才有 KC）；
//   - 入库 = insertSourcedDraft（draft_status='draft' 硬闸）+ figures/image_refs/
//     structured 链接（attached_to_index / structured.id 从 candidate 占位重写为题 id）
//     + 图片题 judge_kind_override='multimodal_direct'（继承旧 handler——选择支会短路
//     图片 auto-route，必须显式路由）；
//   - verify 链 = writeVerifyDispatchIntent（同事务）+ dispatchPendingVerifyIntents
//     （事务后；失败留 durable intent 由 recovery 捡起，不翻转 commit 结果）。
//
// 拒绝是软结果（rejected:* 返回有效 Output），agent 不得对被拒候选烧预算重试；
// 未预期错误抛出（MCP bridge 按硬失败处理）。

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SendOptions } from 'pg-boss';
import { z } from 'zod';
import { AgentRef } from '@/core/schema/business';
import { SourcedQuestion } from '@/core/schema/sourcing';
import { FigureRef, StructuredQuestion } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/server/boss/verify-dispatch-outbox';
import { insertSourcedDraft } from '@/server/questions/sourced-draft-insert';
import { resolveSubjectProfile } from '@/subjects/profile';
import { SupplyTraceV1 } from '../question-supply/evidence-demand';
import { cleanupStagedAssets } from '../question-supply/jyeoo-candidates';
import { JYEOO_SOURCE_HOST } from '../question-supply/jyeoo-supply-config';
import {
  DEDUP_OVERLAP_THRESHOLD,
  matchesWhitelist,
  maxNgramOverlap,
} from '../question-supply/sourced-dedup';
import { mergeExactQuestionDuplicateKnowledgeIds } from '../quiz/content-fingerprint';

// 与旧 handler 一致：system ref（确定性管线，无 LLM run）。task_kind 按来源路由参数化
// （YUK-988/E3）：jyeoo_fetch='JyeooFetch'（E1 语义不变）；sourcing_web='SourcingTask'
// （web 候选由 SourcingTask 产出，沿用旧 sourcing job 的 created_by 语义）。
const SOURCED_CREATED_BY_BY_ROUTE = {
  jyeoo_fetch: AgentRef.parse({ by: 'system', task_kind: 'JyeooFetch' }),
  sourcing_web: AgentRef.parse({ by: 'system', task_kind: 'SourcingTask' }),
} as const;

// YUK-988 (Supply-Agent/3) — commit seam 按来源路由参数化（E3 接入 web 候选）：
//   - jyeoo_fetch：foreign-host 闸 = www.jyeoo.com（producer 异常/篡改防线，E1 语义）；
//   - sourcing_web：无固定 host——web 候选来自任意白名单站点，接地靠
//     metadata.web_sourced.whitelist_match（insertSourcedDraft 用 profile whitelist 计算，
//     旧 sourcing job 同款语义）；verify 链同为 source_verify（tier-2）。
const COMMIT_ROUTE_CONFIG = {
  jyeoo_fetch: { expectedHost: JYEOO_SOURCE_HOST, mergeActorRef: 'jyeoo_fetch' },
  sourcing_web: { expectedHost: null, mergeActorRef: 'sourcing' },
} as const;

// 旧 handler 同款 pool 上界（source_verify checkDedup 的 LIMIT 先例）。
const NEAR_DUP_POOL_LIMIT = 100;

const candidateInputSchema = z.object({
  candidate_id: z.string().min(1),
  question: SourcedQuestion,
  extraction_hash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'extraction_hash 必须是 sha256:<64hex>（fetch 工具产出）'),
  knowledge_hints: z.array(z.string()).default([]),
  source_id: z.string().nullable().default(null),
  figures: z.array(FigureRef).nullable().default(null),
  image_refs: z.array(z.string()).nullable().default(null),
  structured: StructuredQuestion.nullable().default(null),
  staged_asset_ids: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  /** 来源路由（YUK-988/E3 参数化）：决定 host 防线、created_by/mergeActorRef 与元数据键。 */
  source_route: z.enum(['jyeoo_fetch', 'sourcing_web']).default('jyeoo_fetch'),
  /** jyeoo_fetch_candidates / web_fetch_candidates 产出的候选（原样传递；extraction_hash 是 dedup key）。 */
  candidate: candidateInputSchema,
  /** 目标知识节点（≥1，全部必须活）；服务端校验，不信任调用方。 */
  knowledge_ids: z.array(z.string().min(1)).min(1),
  /** 归属质量：matched = hint/推理命中具体节点；coarse = 兜底挂科目根（树长大后重归因）。 */
  attribution_state: z.enum(['matched', 'coarse']).default('matched'),
  /** loom subject id（whitelist_match 判定的 profile 来源，如 'math'）。 */
  subject_id: z.string().trim().min(1).default('math'),
  supply_trace: SupplyTraceV1.optional(),
  /** 需求台账关联（YUK-698 EvidenceDemand；E2 接上 planner 后传入）。 */
  demand_id: z.string().min(1).optional(),
});

const outputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('inserted'),
    question_id: z.string(),
    verify_enqueued: z.boolean(),
    difficulty_evidence: z.unknown(),
  }),
  z.object({
    status: z.literal('rejected'),
    reason: z.enum(['dead_knowledge_node', 'duplicate_exact', 'near_dup', 'foreign_host']),
    detail: z.string(),
    existing_question_id: z.string().nullable(),
  }),
]);

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

type EnqueueSourceVerifyFn = (questionIds: string[], options?: SendOptions) => Promise<void>;

async function defaultEnqueueSourceVerify(
  questionIds: string[],
  options?: SendOptions,
): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds }, options);
}

export interface StoreSourcedQuestionDeps {
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
}

/** Pull active+draft prompts sharing ANY target KC for the near-dup gate（并集、newest-first）。 */
async function fetchNearDupPool(
  db: Db,
  knowledgeIds: string[],
): Promise<Array<{ id: string; prompt_md: string }>> {
  const predicates = knowledgeIds.map(
    (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  return (
    db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      // knowledge_ids ≥1（schema 边界）→ predicates 非空；单条件时 drizzle 的 or() 原样返回。
      .where(or(...predicates))
      .orderBy(desc(question.created_at))
      .limit(NEAR_DUP_POOL_LIMIT)
  );
}

/**
 * Commit 执行核（依赖可注入——db 测试直接调它；DomainTool.execute 走默认依赖）。
 * 返回软拒绝或插入结果；未预期异常抛出。
 */
export async function executeStoreSourcedQuestion(
  ctx: Pick<ToolContext, 'db' | 'sessionId' | 'taskRunId' | 'causedByEventId'>,
  input: Input,
  deps: StoreSourcedQuestionDeps = {},
): Promise<Output> {
  const { db } = ctx;
  const { candidate } = input;
  const enqueueSourceVerify = deps.enqueueSourceVerify ?? defaultEnqueueSourceVerify;
  const canonicalHash = candidate.extraction_hash.slice('sha256:'.length);
  const now = new Date();

  // ── 1. knowledge 活体校验（全部目标节点必须存在且未归档） ──────────────────
  const liveRows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, input.knowledge_ids), isNull(knowledge.archived_at)));
  const liveIds = new Set(liveRows.map((row) => row.id));
  const dead = input.knowledge_ids.filter((id) => !liveIds.has(id));
  if (dead.length > 0) {
    return {
      status: 'rejected',
      reason: 'dead_knowledge_node',
      detail: `knowledge ids 不存在或已归档: ${dead.join(', ')}`,
      existing_question_id: null,
    };
  }

  // ── 2. foreign-host 防线（belt：fetch 侧已过滤；commit 不信任调用方再查一次） ──
  // source_verify 以持久化 extract 为准、从不 refetch——foreign URL 会绕过 tier-2 接地。
  // 仅 jyeoo_fetch 有固定 host；sourcing_web 的接地是 whitelist_match（旧 sourcing 同款）。
  const routeConfig = COMMIT_ROUTE_CONFIG[input.source_route];
  if (routeConfig.expectedHost !== null) {
    try {
      if (
        new URL(candidate.question.source_url).hostname.toLowerCase() !== routeConfig.expectedHost
      ) {
        return {
          status: 'rejected',
          reason: 'foreign_host',
          detail: `source_url host 非 ${routeConfig.expectedHost}（producer 异常或调用方篡改）`,
          existing_question_id: null,
        };
      }
    } catch {
      return {
        status: 'rejected',
        reason: 'foreign_host',
        detail: 'source_url 不可解析',
        existing_question_id: null,
      };
    }
  }

  // ── 3. exact-dup 预检（YUK-720 cross-KC merge：命中则目标 KC 并入既有行） ────
  const merged = await db.transaction((tx) =>
    mergeExactQuestionDuplicateKnowledgeIds(tx, {
      canonicalContentHash: canonicalHash,
      knowledgeIds: input.knowledge_ids,
      actorRef: routeConfig.mergeActorRef,
      taskRunId: ctx.taskRunId,
      now,
    }),
  );
  if (merged?.disposition === 'merged') {
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    return {
      status: 'rejected',
      reason: 'duplicate_exact',
      detail: `canonical hash 命中既有题 ${merged.id}；目标 KC 已并入`,
      existing_question_id: merged.id,
    };
  }

  // ── 4. near-dup（KC-scoped active+draft 池；图片题跳过文本 n-gram） ─────────
  const hasImages = (candidate.image_refs?.length ?? 0) > 0;
  if (!hasImages) {
    const pool = await fetchNearDupPool(db, input.knowledge_ids);
    const overlap = maxNgramOverlap(
      candidate.question.prompt_md,
      pool.map((row) => row.prompt_md),
    );
    if (overlap >= DEDUP_OVERLAP_THRESHOLD) {
      await cleanupStagedForRejected(db, candidate.staged_asset_ids);
      return {
        status: 'rejected',
        reason: 'near_dup',
        detail: `n-gram overlap ${overlap.toFixed(3)} ≥ ${DEDUP_OVERLAP_THRESHOLD}（KC 池 ${pool.length} 题）`,
        existing_question_id: null,
      };
    }
  }

  // ── 5. insert + 图片链接 + verify intent（单事务） ──────────────────────────
  const questionId = createId();
  const whitelist = (resolveSubjectProfile(input.subject_id).sourceWhitelist ?? []) as string[];
  // 路由专属元数据键：jyeoo → jyeoo:{id,candidate_id}（E1 连续）；web → sourcing:{candidate_id}
  // （web 的 url/title/fetched_at/whitelist_match 由 insertSourcedDraft 写入 metadata.web_sourced）。
  const routeMetadata =
    input.source_route === 'jyeoo_fetch'
      ? { jyeoo: { id: candidate.source_id, candidate_id: candidate.candidate_id } }
      : { sourcing: { candidate_id: candidate.candidate_id } };
  const metadataExtras = {
    prompt_image_refs: candidate.image_refs ?? [],
    knowledge_hints: candidate.knowledge_hints,
    attribution_state: input.attribution_state,
    ...routeMetadata,
    ...(input.demand_id ? { demand_id: input.demand_id } : {}),
  };

  let persisted: Awaited<ReturnType<typeof insertSourcedDraft>>;
  try {
    persisted = await db.transaction(async (tx) => {
      const inserted = await insertSourcedDraft(tx, {
        id: questionId,
        q: candidate.question,
        knowledgeIds: input.knowledge_ids,
        sourceRoute: input.source_route,
        createdBy: SOURCED_CREATED_BY_BY_ROUTE[input.source_route],
        whitelistMatch: matchesWhitelist(candidate.question.source_url, whitelist),
        fetchedAt: now.toISOString(),
        canonicalContentHash: canonicalHash,
        supplyTrace: input.supply_trace,
        mergeActorRef: routeConfig.mergeActorRef,
        taskRunId: ctx.taskRunId,
        now,
      });
      if (inserted.status === 'raced_merged') return inserted;

      if (hasImages && candidate.figures && candidate.image_refs && candidate.structured) {
        await tx
          .update(question)
          .set({
            judge_kind_override: 'multimodal_direct',
            figures: candidate.figures.map((figure) => ({
              ...figure,
              attached_to_index: questionId,
            })),
            image_refs: candidate.image_refs,
            structured: { ...candidate.structured, id: questionId },
            metadata: sql`${question.metadata} || ${JSON.stringify(metadataExtras)}::jsonb`,
            updated_at: now,
          })
          .where(eq(question.id, questionId));
      } else {
        await tx
          .update(question)
          .set({
            metadata: sql`${question.metadata} || ${JSON.stringify(metadataExtras)}::jsonb`,
            updated_at: now,
          })
          .where(eq(question.id, questionId));
      }
      await writeVerifyDispatchIntent(tx, {
        questionId,
        verifier: 'source_verify',
        supplyTrace: inserted.supplyTrace,
        createdAt: now,
      });
      return inserted;
    });
  } catch (err) {
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    throw err;
  }

  if (persisted.status === 'raced_merged') {
    // 并发 race：另一插入赢了 canonical hash——本候选的 staged 资产成为孤儿，即时回收。
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    return {
      status: 'rejected',
      reason: 'duplicate_exact',
      detail: `并发 canonical race，${persisted.existingId} 获胜并吸收目标 KC`,
      existing_question_id: persisted.existingId,
    };
  }

  // ── 6. verify 链派发（事务后；失败留 durable intent，不翻转 commit） ─────────
  const dispatchResult = await dispatchPendingVerifyIntents(db, {
    questionIds: [questionId],
    enqueue: async (verifier, ids, options) => {
      if (verifier !== 'source_verify') {
        throw new Error(`store_sourced_question outbox received unexpected verifier '${verifier}'`);
      }
      await enqueueSourceVerify(ids, options);
    },
  });
  const verifyEnqueued = dispatchResult.failed === 0;
  if (!verifyEnqueued) {
    console.error(
      '[store_sourced_question] source_verify enqueue failed; durable intent left for recovery:',
      questionId,
    );
  }

  // ── 7. canary 事件（commit 侧观测面；失败不翻转结果） ────────────────────────
  try {
    await writeEvent(db, {
      id: createId(),
      session_id: ctx.sessionId ?? null,
      actor_kind: 'agent',
      actor_ref: 'store_sourced_question',
      action: 'experimental:store_sourced_question',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        candidate_id: candidate.candidate_id,
        source_id: candidate.source_id,
        source_route: input.source_route,
        knowledge_ids: input.knowledge_ids,
        attribution_state: input.attribution_state,
        verify_enqueued: verifyEnqueued,
        difficulty_evidence: persisted.difficultyEvidence,
        ...(input.demand_id ? { demand_id: input.demand_id } : {}),
        ...(input.supply_trace ? { supply_trace: input.supply_trace } : {}),
      },
      caused_by_event_id: ctx.causedByEventId ?? null,
      task_run_id: ctx.taskRunId,
      cost_micro_usd: null,
      created_at: now,
    });
  } catch (eventErr) {
    console.error('[store_sourced_question] canary event write failed; commit stands:', eventErr);
  }

  return {
    status: 'inserted',
    question_id: questionId,
    verify_enqueued: verifyEnqueued,
    difficulty_evidence: persisted.difficultyEvidence,
  };
}

/** 被拒/落选候选的 staged 资产即时回收（reaper 是兜底；能拿到 r2 才清，清不动留给 reaper）。 */
async function cleanupStagedForRejected(db: Db, stagedAssetIds: string[]): Promise<void> {
  if (stagedAssetIds.length === 0) return;
  try {
    const assets = await db
      .select()
      .from(source_asset)
      .where(inArray(source_asset.id, stagedAssetIds));
    await cleanupStagedAssets(db, assets);
  } catch (err) {
    console.warn('[store_sourced_question] staged asset cleanup deferred to reaper:', err);
  }
}

export const storeSourcedQuestionTool: DomainTool<Input, Output> = {
  name: 'store_sourced_question',
  description:
    '把一道来源候选题（jyeoo_fetch_candidates 产出）提交进题池草稿层。' +
    '服务端强制 dedup（exact+near）与知识节点活体校验；成功即挂 source_verify 链（过闸才转 active）。' +
    'rejected 候选不要重试；知识归属用 knowledge_ids + attribution_state 声明。',
  effect: 'write',
  inputSchema,
  outputSchema,
  costClass: 'local',
  // 无 safeHandoff：题面写库 + verify 链必须 in-process（registry 规则：safeHandoff 仅限
  // idempotent read）。
  mirrorEvent: 'when_causal',
  async execute(ctx, input) {
    return executeStoreSourcedQuestion(ctx, input);
  },
  summarize(_input, output) {
    if (output.status === 'inserted') {
      return `入库草稿 ${output.question_id} · verify ${output.verify_enqueued ? '已派发' : '待恢复'}`;
    }
    return `拒绝 · ${output.reason}`;
  },
};
