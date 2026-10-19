// YUK-1468 — `submit_question` DomainTool（统一题目提交闸）。
//
// 泛化自 YUK-986 `store_sourced_question`：同一入库闸现在接两类输入：
//
//   A) 统一草稿提交：`draft_ref`（qdraft1:<block>:<version>）—— v2 草稿文档
//      （或经入口适配的 legacy StructuredQuestion 块）→ 契约四层 →
//      publishQuestionGroup（唯一 revision writer）。编辑已发布题时组 =
//      doc.base.question_id / block.imported_question_id，新 revision 叠加在
//      原组上；发布前绝不先覆盖已发布投影。
//      来源：generated / adapted / owner_material / photo_ingest /
//      jyeoo_fetch / sourcing_web / manual —— 非 fetch 来源用
//      canonicalQuestionContentHash（prompt/reference/choices/rubric）做可复现
//      指纹，不含 source 与知识点，绝不伪造 extraction_hash。
//
//   B) 供给候选提交：`candidate`（jyeoo_fetch / sourcing_web 产出）—— 原有
//      提交链逐字保留：KC 活体 → foreign-host → exact-dup → near-dup →
//      insertSourcedDraft + 同事务 publish + source_verify outbox。
//
// 响应统一为 admitted / withheld / conflict / pending + 逐 unit 原因：
//   - withheld：发布了但未准入（verify lane 待跑），或草稿有未决项未发布；
//   - pending：异步 op（source_verify 派发）挂起；
//   - conflict：CAS / 去重 claim / request_id 复用；
//   - admitted：判分准入决定的 admitted 分支。提交本身没有裁决，不把新题
//     标成 admitted；question_admission_run 在双解通过后用同一决定标 admitted。
//
// 幂等：request_id 必填；同 id 同内容返回同回执，同 id 不同内容冲突拒绝。

import { createHash } from 'node:crypto';
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

// capability→questions 边数守恒：统一写口 facade（@/server/questions/submit-question）
// 是本文件对 questions/* 的唯一 import 边；capability 内部消费方（edit-question
// 工具、proposal-appliers、store-sourced-question shim）走本文件的下行
// re-export，不经 facade 重复计数。
import {
  type SubmitResult,
  canonicalJson,
  claimSubmitRequestId,
  insertSourcedDraft,
  publishQuestionGroupFromRow,
  submitDraftQuestion,
  writeSubmitReceiptEvent,
} from '@/server/questions/submit-question';

export type {
  EditQuestionInputT,
  EditQuestionResult,
  SubmitResult,
} from '@/server/questions/submit-question';
export {
  EditQuestionInput,
  insertSourcedDraft,
  probeDraftEdit,
  publishQuestionGroupFromRow,
  saveDraftEdit,
  submitDraftQuestion,
  validateDraftEdit,
} from '@/server/questions/submit-question';

import { resolveSubjectProfile } from '@/subjects/profile';
import { embedQuestionTextForIngest } from '../../jobs/embed_backfill';
import { SupplyTraceV1 } from '../question-supply/evidence-demand';
import {
  claimHttpSourceDuplicate,
  findVectorNearDuplicate,
  vectorNearHoldMetadata,
} from '../question-supply/ingest-dedup';
import { cleanupStagedAssets } from '../question-supply/jyeoo-candidates';
import { JYEOO_SOURCE_HOST } from '../question-supply/jyeoo-supply-config';
import {
  DEDUP_OVERLAP_THRESHOLD,
  matchesWhitelist,
  maxNgramOverlap,
} from '../question-supply/sourced-dedup';
import { mergeExactQuestionDuplicateKnowledgeIds } from '../quiz/content-fingerprint';

const SOURCED_CREATED_BY_BY_ROUTE = {
  jyeoo_fetch: AgentRef.parse({ by: 'system', task_kind: 'JyeooFetch' }),
  sourcing_web: AgentRef.parse({ by: 'system', task_kind: 'SourcingTask' }),
} as const;

// 旧 handler 同款 pool 上界（source_verify checkDedup 的 LIMIT 先例）。
const NEAR_DUP_POOL_LIMIT = 100;

// FigureRef.last_reassigned_at 是 z.coerce.date —— 工具的 draft-07 mount
// schema 里不可表达。wire 面收 ISO 字符串；内部解析换回共享 FigureRef
//（coerce 兼容 ISO string / Date / epoch），bridge 的首层 parse 与 execute /
// compat seam 的二次 parse 往返不互锁。
const CandidateFigureWire = FigureRef.extend({
  last_reassigned_at: z.iso.datetime().optional(),
});

const candidateInputSchema = z.object({
  candidate_id: z.string().min(1),
  question: SourcedQuestion,
  extraction_hash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'extraction_hash 必须是 sha256:<64hex>（fetch 工具产出）'),
  knowledge_hints: z.array(z.string()).default([]),
  source_id: z.string().nullable().default(null),
  figures: z.array(CandidateFigureWire).nullable().default(null),
  image_refs: z.array(z.string()).nullable().default(null),
  structured: StructuredQuestion.nullable().default(null),
  staged_asset_ids: z.array(z.string()).default([]),
});

const candidateParsedSchema = candidateInputSchema.extend({
  figures: z.array(FigureRef).nullable().default(null),
});

const draftInputSchema = z.object({
  draft_ref: z.string().min(1),
  expected_draft_version: z.number().int().min(0).optional(),
  expected_revision: z.string().min(1).nullable().optional(),
});

const inputSchema = z
  .object({
    /** 幂等键（必填）：同 id 同内容返回同回执，不同内容冲突拒绝。 */
    request_id: z.string().min(1),
    /** A) 统一草稿提交。 */
    draft: draftInputSchema.optional(),
    /** B) 供给候选提交（jyeoo_fetch / sourcing_web 路由参数化）。 */
    source_route: z.enum(['jyeoo_fetch', 'sourcing_web']).default('jyeoo_fetch'),
    candidate: candidateInputSchema.optional(),
    knowledge_ids: z.array(z.string().min(1)).optional(),
    attribution_state: z.enum(['matched', 'coarse']).default('matched'),
    subject_id: z.string().trim().min(1).optional(),
    supply_trace: SupplyTraceV1.optional(),
    demand_id: z.string().min(1).optional(),
    availability: z.enum(['general_pool', 'container_only']).optional(),
  })
  .strict();

// 执行侧 schema（从不编 JSON Schema）：candidate.figures 回到共享 FigureRef。
const parsedInputSchema = inputSchema.extend({
  candidate: candidateParsedSchema.optional(),
});

const unitOutcomeSchema = z.object({
  unit_id: z.string(),
  status: z.enum(['admitted', 'withheld', 'pending', 'skipped']),
  reason: z.string().optional(),
});

const issueSchema = z.object({
  code: z.string(),
  detail: z.string(),
  part_id: z.string().optional(),
  unit_id: z.string().optional(),
});

const outputSchema = z.object({
  status: z.enum(['admitted', 'withheld', 'conflict', 'pending']),
  question_id: z.string().optional(),
  group_id: z.string().optional(),
  revision_id: z.string().optional(),
  revision_ref: z.string().optional(),
  revision_ordinal: z.number().optional(),
  publish_status: z.string().optional(),
  published: z.boolean().optional(),
  per_unit: z.array(unitOutcomeSchema).optional(),
  verify_enqueued: z.boolean().optional(),
  issues: z.array(issueSchema).optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  existing_question_id: z.string().nullable().optional(),
  current_draft_ref: z.string().optional(),
  current_draft_version: z.number().optional(),
  current_revision_ref: z.string().nullable().optional(),
  request_id: z.string().optional(),
  replayed: z.boolean().optional(),
  difficulty_evidence: z.unknown().optional(),
});

type ParsedInput = z.infer<typeof parsedInputSchema>;
// execute 的实际输入契约 = parsedInputSchema 的输入侧：wire parse 产物（ISO
// string）与直连调用方已解析的 Date 都收，z.coerce.date 归一。
type ExecInput = z.input<typeof parsedInputSchema>;
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

export interface SubmitQuestionDeps {
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
  /** 缺省用夜间回填同一条 embed 缝。失败则向量腿弃权，网址判重仍生效。 */
  embedIngestText?: (q: {
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
  }) => Promise<number[]>;
}

export type StoreSourcedQuestionDeps = SubmitQuestionDeps;

async function fetchNearDupPool(
  db: Db,
  knowledgeIds: string[],
): Promise<Array<{ id: string; prompt_md: string }>> {
  const predicates = knowledgeIds.map(
    (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  return db
    .select({ id: question.id, prompt_md: question.prompt_md })
    .from(question)
    .where(or(...predicates))
    .orderBy(desc(question.created_at))
    .limit(NEAR_DUP_POOL_LIMIT);
}

const COMMIT_ROUTE_CONFIG = {
  jyeoo_fetch: { expectedHost: JYEOO_SOURCE_HOST, mergeActorRef: 'jyeoo_fetch' },
  sourcing_web: { expectedHost: null, mergeActorRef: 'sourcing' },
} as const;

/** B) 供给候选路径（原 store_sourced_question 语义逐字保留）。
 * request_id 幂等同 draft 路径：锁内 claim；同 id 同内容重放回执，不同内容冲突。 */
async function executeCandidateSubmit(
  ctx: Pick<ToolContext, 'db' | 'sessionId' | 'taskRunId' | 'causedByEventId'> & {
    callerActor?: ToolContext['callerActor'];
  },
  input: ParsedInput & { candidate: NonNullable<ParsedInput['candidate']> },
  deps: SubmitQuestionDeps,
): Promise<Output> {
  const { db } = ctx;
  const { candidate } = input;
  const requestId = input.request_id;
  const fingerprint = `sha256:${createHash('sha256')
    .update(
      canonicalJson({
        candidate: input.candidate,
        knowledge_ids: input.knowledge_ids,
        subject_id: input.subject_id,
        source_route: input.source_route,
        availability: input.availability,
      }),
    )
    .digest('hex')}`;
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
    return claimSubmitRequestId(tx, requestId, fingerprint);
  });
  if (claim.status === 'replay') {
    return { ...(claim.receipt as Output), replayed: true } as Output;
  }
  if (claim.status === 'reused') {
    return {
      status: 'conflict',
      reason: 'request_id_reused',
      detail: `request_id '${requestId}' was used with different content`,
      request_id: requestId,
    };
  }
  const result = await runCandidateSubmit(ctx, input, deps);
  // 回执落库：subject=产出的 question（withheld/conflict 无产出 → 候选占位）。
  await db.transaction((tx) =>
    writeSubmitReceiptEvent(
      tx,
      {
        kind: 'question',
        id:
          'question_id' in result && result.question_id != null
            ? result.question_id
            : `candidate:${candidate.candidate_id}`,
      },
      requestId,
      fingerprint,
      result as SubmitResult,
      {
        actorRef: ctx.callerActor?.ref ?? 'agent:submit_question',
        actorKind: 'agent',
        sessionId: ctx.sessionId ?? null,
        taskRunId: ctx.taskRunId,
        causedByEventId: ctx.causedByEventId ?? null,
      },
      new Date(),
    ),
  );
  return result;
}

async function runCandidateSubmit(
  ctx: Pick<ToolContext, 'db' | 'sessionId' | 'taskRunId' | 'causedByEventId'>,
  input: ParsedInput & { candidate: NonNullable<ParsedInput['candidate']> },
  deps: SubmitQuestionDeps,
): Promise<Output> {
  const { db } = ctx;
  const { candidate } = input;
  const knowledgeIds = input.knowledge_ids ?? [];
  if (knowledgeIds.length === 0) {
    return {
      status: 'withheld',
      reason: 'missing_knowledge_ids',
      detail: 'candidate path requires knowledge_ids (≥1, all live)',
      request_id: input.request_id,
    };
  }
  if (input.subject_id == null) {
    return {
      status: 'withheld',
      reason: 'missing_subject_id',
      detail: 'candidate path requires subject_id (source whitelist resolution)',
      request_id: input.request_id,
    };
  }
  const enqueueSourceVerify = deps.enqueueSourceVerify ?? defaultEnqueueSourceVerify;
  const canonicalHash = candidate.extraction_hash.slice('sha256:'.length);
  const now = new Date();

  const liveRows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)));
  const liveIds = new Set(liveRows.map((row) => row.id));
  const dead = knowledgeIds.filter((id) => !liveIds.has(id));
  if (dead.length > 0) {
    return {
      status: 'withheld',
      reason: 'dead_knowledge_node',
      detail: `knowledge ids 不存在或已归档: ${dead.join(', ')}`,
      request_id: input.request_id,
    };
  }

  const routeConfig = COMMIT_ROUTE_CONFIG[input.source_route];
  if (routeConfig.expectedHost !== null) {
    try {
      if (
        new URL(candidate.question.source_url).hostname.toLowerCase() !== routeConfig.expectedHost
      ) {
        return {
          status: 'withheld',
          reason: 'foreign_host',
          detail: `source_url host 非 ${routeConfig.expectedHost}（producer 异常或调用方篡改）`,
          request_id: input.request_id,
        };
      }
    } catch {
      return {
        status: 'withheld',
        reason: 'foreign_host',
        detail: 'source_url 不可解析',
        request_id: input.request_id,
      };
    }
  }

  const merged = await db.transaction((tx) =>
    mergeExactQuestionDuplicateKnowledgeIds(tx, {
      canonicalContentHash: canonicalHash,
      knowledgeIds,
      actorRef: routeConfig.mergeActorRef,
      taskRunId: ctx.taskRunId,
      now,
    }),
  );
  if (merged?.disposition === 'merged') {
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    return {
      status: 'conflict',
      reason: 'duplicate_exact',
      detail: `canonical hash 命中既有题 ${merged.id}；目标 KC 已并入`,
      existing_question_id: merged.id,
      request_id: input.request_id,
    };
  }

  const sourceClaim = {
    sourceUrl: candidate.question.source_url,
    knowledgeIds,
    actorRef: routeConfig.mergeActorRef,
    taskRunId: ctx.taskRunId,
    now,
  };
  const claimedSource = await db.transaction((tx) => claimHttpSourceDuplicate(tx, sourceClaim));
  if (claimedSource != null) {
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    return {
      status: 'conflict',
      reason: 'duplicate_source',
      detail: `同一来源网址命中既有题 ${claimedSource.existingQuestionId}；目标 KC 已并入`,
      existing_question_id: claimedSource.existingQuestionId,
      request_id: input.request_id,
    };
  }

  const hasImages = (candidate.image_refs?.length ?? 0) > 0;
  if (!hasImages) {
    const pool = await fetchNearDupPool(db, knowledgeIds);
    const overlap = maxNgramOverlap(
      candidate.question.prompt_md,
      pool.map((row) => row.prompt_md),
    );
    if (overlap >= DEDUP_OVERLAP_THRESHOLD) {
      await cleanupStagedForRejected(db, candidate.staged_asset_ids);
      return {
        status: 'conflict',
        reason: 'near_dup',
        detail: `n-gram overlap ${overlap.toFixed(3)} ≥ ${DEDUP_OVERLAP_THRESHOLD}（KC 池 ${pool.length} 题）`,
        request_id: input.request_id,
      };
    }
  }

  let vectorNear: { id: string; similarity: number } | null = null;
  try {
    const questionText = {
      prompt_md: candidate.question.prompt_md,
      reference_md: candidate.question.reference_md,
      choices_md: candidate.question.choices_md ?? null,
    };
    const vector = await (
      deps.embedIngestText ??
      ((q: typeof questionText) =>
        embedQuestionTextForIngest(q, {
          db,
          caller: ctx.taskRunId ? 'worker' : 'api',
          deadlineAt: new Date(Date.now() + 20_000),
        }))
    )(questionText);
    vectorNear = await findVectorNearDuplicate(db, vector);
  } catch (err) {
    console.error('[submit_question] vector near-dup abstained:', err);
  }

  const questionId = createId();
  const whitelist = (resolveSubjectProfile(input.subject_id).sourceWhitelist ?? []) as string[];
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
    ...(vectorNear != null ? vectorNearHoldMetadata(vectorNear) : {}),
  };

  let persisted:
    | Awaited<ReturnType<typeof insertSourcedDraft>>
    | { status: 'source_duplicate'; existingId: string };
  try {
    persisted = await db.transaction(async (tx) => {
      const racedSource = await claimHttpSourceDuplicate(tx, sourceClaim);
      if (racedSource != null) {
        return { status: 'source_duplicate' as const, existingId: racedSource.existingQuestionId };
      }
      const inserted = await insertSourcedDraft(tx, {
        id: questionId,
        q: candidate.question,
        knowledgeIds,
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
      await publishQuestionGroupFromRow(tx, {
        rootId: questionId,
        actorRef: `submit-question:${input.source_route}:enrich`,
        now,
      });
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

  if (persisted.status === 'source_duplicate') {
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    return {
      status: 'conflict',
      reason: 'duplicate_source',
      detail: `同一来源网址命中既有题 ${persisted.existingId}；目标 KC 已并入`,
      existing_question_id: persisted.existingId,
      request_id: input.request_id,
    };
  }

  if (persisted.status === 'raced_merged') {
    await cleanupStagedForRejected(db, candidate.staged_asset_ids);
    return {
      status: 'conflict',
      reason: 'duplicate_exact',
      detail: `并发 canonical race，${persisted.existingId} 获胜并吸收目标 KC`,
      existing_question_id: persisted.existingId,
      request_id: input.request_id,
    };
  }

  const dispatchResult = await dispatchPendingVerifyIntents(db, {
    questionIds: [questionId],
    enqueue: async (verifier, ids, options) => {
      if (verifier !== 'source_verify') {
        throw new Error(`submit_question outbox received unexpected verifier '${verifier}'`);
      }
      await enqueueSourceVerify(ids, options);
    },
  });
  const verifyEnqueued = dispatchResult.failed === 0;
  if (!verifyEnqueued) {
    console.error(
      '[submit_question] source_verify enqueue failed; durable intent left for recovery:',
      questionId,
    );
  }

  try {
    await writeEvent(db, {
      id: createId(),
      session_id: ctx.sessionId ?? null,
      actor_kind: 'agent',
      actor_ref: 'submit_question',
      action: 'experimental:submit_question',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        candidate_id: candidate.candidate_id,
        source_id: candidate.source_id,
        source_route: input.source_route,
        knowledge_ids: knowledgeIds,
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
    console.error('[submit_question] canary event write failed; commit stands:', eventErr);
  }

  return {
    status: 'pending',
    question_id: questionId,
    verify_enqueued: verifyEnqueued,
    difficulty_evidence: persisted.difficultyEvidence,
    request_id: input.request_id,
  };
}

/** 被拒/落选候选的 staged 资产即时回收。 */
async function cleanupStagedForRejected(db: Db, stagedAssetIds: string[]): Promise<void> {
  if (stagedAssetIds.length === 0) return;
  try {
    const assets = await db
      .select()
      .from(source_asset)
      .where(inArray(source_asset.id, stagedAssetIds));
    await cleanupStagedAssets(db, assets);
  } catch (err) {
    console.warn('[submit_question] staged asset cleanup deferred to reaper:', err);
  }
}

/**
 * 内部候选路径执行入口（protected 调用方 plan-executor / db 测试的
 * compat seam：签名保持旧 executeStoreSourcedQuestion 形状，request_id 由
 * candidate_id+extraction_hash 确定性合成）。工具面只有 submit_question。
 */
export async function executeStoreSourcedQuestion(
  ctx: Pick<ToolContext, 'db' | 'sessionId' | 'taskRunId' | 'causedByEventId'>,
  legacyInput: {
    source_route: 'jyeoo_fetch' | 'sourcing_web';
    candidate: z.infer<typeof candidateParsedSchema>;
    knowledge_ids: string[];
    attribution_state?: 'matched' | 'coarse';
    subject_id: string;
    supply_trace?: z.infer<typeof SupplyTraceV1>;
    demand_id?: string;
  },
  deps: StoreSourcedQuestionDeps = {},
): Promise<
  | {
      status: 'inserted';
      question_id: string;
      verify_enqueued: boolean;
      difficulty_evidence: unknown;
    }
  | {
      status: 'rejected';
      reason:
        | 'dead_knowledge_node'
        | 'duplicate_exact'
        | 'duplicate_source'
        | 'near_dup'
        | 'foreign_host';
      detail: string;
      existing_question_id: string | null;
    }
> {
  const parsed = parsedInputSchema.parse({
    // 幂等 key = 候选指纹 + 请求内容指纹（KC 集合/归属不同 ⇒ 不同 id，
    // 避免同 id 异内容误判 request_id_reused）。
    request_id: `legacy-${legacyInput.candidate.candidate_id}-${legacyInput.candidate.extraction_hash.slice(7, 23)}-${createHash(
      'sha256',
    )
      .update(canonicalJson(legacyInput))
      .digest('hex')
      .slice(0, 12)}`,
    source_route: legacyInput.source_route,
    candidate: legacyInput.candidate,
    knowledge_ids: legacyInput.knowledge_ids,
    attribution_state: legacyInput.attribution_state ?? 'matched',
    subject_id: legacyInput.subject_id,
    supply_trace: legacyInput.supply_trace,
    demand_id: legacyInput.demand_id,
  });
  const candidate = parsed.candidate;
  if (candidate == null) {
    return {
      status: 'rejected',
      reason: 'duplicate_exact',
      detail: 'candidate is required on the compat path',
      existing_question_id: null,
    };
  }
  const out = await executeCandidateSubmit(ctx, { ...parsed, candidate }, deps);
  if (out.status === 'pending' && out.question_id != null) {
    return {
      status: 'inserted',
      question_id: out.question_id,
      verify_enqueued: out.verify_enqueued ?? false,
      difficulty_evidence: out.difficulty_evidence,
    };
  }
  return {
    status: 'rejected',
    reason: (out.reason ?? 'duplicate_exact') as
      | 'dead_knowledge_node'
      | 'duplicate_exact'
      | 'duplicate_source'
      | 'near_dup'
      | 'foreign_host',
    detail: out.detail ?? out.reason ?? '',
    existing_question_id: out.existing_question_id ?? null,
  };
}

async function execute(ctx: ToolContext, raw: ExecInput): Promise<Output> {
  const input = parsedInputSchema.parse(raw);
  const hasDraft = input.draft != null;
  const hasCandidate = input.candidate != null;
  if (hasDraft === hasCandidate) {
    return {
      status: 'conflict',
      reason: 'invalid_request',
      detail: 'exactly one of draft or candidate is required',
      request_id: input.request_id,
    };
  }
  if (input.draft != null) {
    const draft = input.draft;
    const result: SubmitResult = await submitDraftQuestion(
      ctx.db,
      {
        draft_ref: draft.draft_ref,
        ...(draft.expected_draft_version !== undefined
          ? { expected_draft_version: draft.expected_draft_version }
          : {}),
        ...(draft.expected_revision !== undefined
          ? { expected_revision: draft.expected_revision }
          : {}),
        request_id: input.request_id,
        ...(input.knowledge_ids != null ? { knowledge_ids: input.knowledge_ids } : {}),
        ...(input.availability != null ? { availability: input.availability } : {}),
      },
      {
        actorRef: ctx.callerActor.ref,
        actorKind: 'agent',
        sessionId: ctx.sessionId ?? null,
        taskRunId: ctx.taskRunId,
        causedByEventId: ctx.causedByEventId ?? null,
      },
    );
    return result as Output;
  }
  if (input.candidate == null) {
    return {
      status: 'conflict',
      reason: 'invalid_request',
      detail: 'exactly one of draft or candidate is required',
      request_id: input.request_id,
    };
  }
  const candidate = input.candidate;
  return executeCandidateSubmit(ctx, { ...input, candidate }, {});
}

export const submitQuestionTool: DomainTool<ExecInput, Output> = {
  name: 'submit_question',
  description:
    '统一题目提交闸。draft_ref 提交 v2 草稿文档（或 legacy 适配块）→ 契约四层 → publishQuestionGroup 单一发布 seam；编辑已发布题叠加新 revision 不覆盖原版。来源 generated/adapted/owner_material/photo_ingest/jyeoo_fetch/sourcing_web/manual — 非 fetch 来源用可复现内容指纹，绝不伪造 extraction_hash。也可提交 jyeoo_fetch/sourcing_web 候选（原 store_sourced_question 语义：dedup/KC 活体/verify outbox）。返回 admitted/withheld/conflict/pending + 逐 unit 判分准入原因。request_id 必填幂等；conflict 不重试原请求。',
  effect: 'write',
  inputSchema,
  outputSchema,
  costClass: 'local',
  mirrorEvent: 'when_causal',
  execute,
  summarize(input, output) {
    const target =
      input.draft != null ? input.draft.draft_ref : (input.candidate?.candidate_id ?? '?');
    return `submit_question ${target} → ${output.status}`;
  },
};
