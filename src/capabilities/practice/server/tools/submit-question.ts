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
import { parseDraftRef } from '@/core/question-draft-ref';
import { AgentRef } from '@/core/schema/business';
import {
  DifficultyEvidence,
  buildProducerDifficultyEvidence,
  explainDifficultyEvidence,
} from '@/core/schema/difficulty-evidence';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import { QuestionDraftDocument, type QuestionDraftDocumentT } from '@/core/schema/question-draft';
import { SourcedQuestion, type SourcedQuestionT } from '@/core/schema/sourcing';
import { FigureRef, StructuredQuestion } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '../verify-dispatch-outbox';
// capability→questions 边数守恒：统一写口 facade（@/server/questions/submit-question）
// 是本文件对 questions/* 的唯一 import 边；capability 内部消费方（edit-question
// 工具、proposal-appliers、store-sourced-question shim）走本文件的下行
// re-export，不经 facade 重复计数。
import {
  type DeclaredGroupDomainOutcome,
  type SubmitResult,
  canonicalJson,
  claimSubmitRequestId,
  insertSourcedDraft,
  persistDeclaredQuestionGroup,
  publishQuestionGroupFromRow,
  sanitizeSourcedMarkup,
  submitDraftQuestion,
  writeSubmitReceiptEvent,
} from '@/server/questions/submit-question';

export type {
  EditQuestionInputT,
  EditQuestionResult,
  SubmitResult,
} from '@/server/questions/submit-question';
// YUK-1568 S3（R1 F2）—— source_verify 需要与写口同一套 revision→flat
// 投影原语（冻结 revision → verify 输入）：复用本文件对 seam 模块已登记
// 的 import 边做 capability 内再出口，不新增 capability→questions 债。
export {
  EditQuestionInput,
  deriveKind,
  draftCanonicalIdentity,
  insertSourcedDraft,
  probeDraftEdit,
  publishQuestionGroupFromRow,
  revisionToDraftDocument,
  saveDraftEdit,
  submitDraftQuestion,
  validateDraftEdit,
} from '@/server/questions/submit-question';

import { resolveSubjectProfile } from '@/subjects/profile';
import { embedQuestionTextForIngest, questionEmbedStamp } from '../../jobs/embed_backfill';
import {
  SupplyTraceV1,
  withSupplyTraceDifficultyEvidence,
} from '../question-supply/evidence-demand';
import {
  claimHttpSourceDuplicate,
  findVectorNearDuplicate,
  vectorNearHoldMetadata,
  visibleSourceNeighbor,
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

/** YUK-1557 — a web-sourced row keeps the AI run that actually produced it. */
function sourcedCreatedBy(
  route: keyof typeof SOURCED_CREATED_BY_BY_ROUTE,
  logTaskRunId: string | undefined,
) {
  if (route === 'sourcing_web' && logTaskRunId) {
    return AgentRef.parse({
      by: 'ai',
      task_kind: 'SourcingTask',
      task_run_id: logTaskRunId,
    });
  }
  return SOURCED_CREATED_BY_BY_ROUTE[route];
}

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

type CandidateSubmitContext = Pick<
  ToolContext,
  'db' | 'sessionId' | 'taskRunId' | 'logTaskRunId' | 'causedByEventId'
> & {
  callerActor?: ToolContext['callerActor'];
};

function candidateSubmitFingerprint(input: ParsedInput): string {
  return `sha256:${createHash('sha256')
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
}

/** B) 供给候选路径（原 store_sourced_question 语义逐字保留）。
 * request_id 幂等同 draft 路径：锁内 claim；同 id 同内容重放回执，不同内容冲突。 */
async function executeCandidateSubmit(
  ctx: CandidateSubmitContext,
  input: ParsedInput & { candidate: NonNullable<ParsedInput['candidate']> },
  deps: SubmitQuestionDeps,
): Promise<Output> {
  const { db } = ctx;
  const { candidate } = input;
  const requestId = input.request_id;
  const fingerprint = candidateSubmitFingerprint(input);
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
  // Declared first publication already committed this receipt atomically. Recheck
  // under the same request lock so a concurrent preflight failure cannot overwrite it.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
    const settled = await claimSubmitRequestId(tx, requestId, fingerprint);
    if (settled.status === 'replay') return settled.receipt as Output;
    if (settled.status === 'reused') {
      return {
        status: 'conflict',
        reason: 'request_id_reused',
        detail: `request_id '${requestId}' was used with different content`,
        request_id: requestId,
      };
    }
    await writeSubmitReceiptEvent(
      tx,
      {
        kind: 'question',
        id: result.question_id ?? `candidate:${candidate.candidate_id}`,
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
    );
    return result;
  });
}

async function runCandidateSubmit(
  ctx: CandidateSubmitContext,
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
    onTerminal: 'defer' as const,
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
  let ingestVector: number[] | null = null;
  const questionText = {
    prompt_md: candidate.question.prompt_md,
    reference_md: candidate.question.reference_md,
    choices_md: candidate.question.choices_md ?? null,
  };
  try {
    ingestVector = await (
      deps.embedIngestText ??
      ((q: typeof questionText) =>
        embedQuestionTextForIngest(q, {
          db,
          caller: ctx.taskRunId ? 'worker' : 'api',
          deadlineAt: new Date(Date.now() + 20_000),
        }))
    )(questionText);
    vectorNear = await findVectorNearDuplicate(db, ingestVector);
  } catch (err) {
    ingestVector = null;
    console.error('[submit_question] vector near-dup abstained:', err);
  }

  // YUK-1568 S3 — 携带 typed 声明（parts/units）的候选走统一草稿链
  // （saveDraftEdit → submitDraftQuestion），不再 flat insert + row publish；
  // 上面的 KC 活体/host/exact/source-URL/near/vector 判重原样先跑。
  // 未声明候选照旧旧 flat 路径（insertSourcedDraft 的 live 无声明 caller）。
  const declaredParts = candidate.question.parts;
  if (declaredParts != null && declaredParts.length > 0) {
    return runDeclaredCandidateSubmit(ctx, input, {
      knowledgeIds,
      canonicalHash,
      vectorNear,
      ingestVector,
      questionText,
      now,
    });
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
  };

  let persisted:
    | Awaited<ReturnType<typeof insertSourcedDraft>>
    | { status: 'source_duplicate'; existingId: string };
  try {
    persisted = await db.transaction(async (tx) => {
      const racedSource = await claimHttpSourceDuplicate(tx, {
        ...sourceClaim,
        onTerminal: 'release',
      });
      if (racedSource != null) {
        return { status: 'source_duplicate' as const, existingId: racedSource.existingQuestionId };
      }
      const inserted = await insertSourcedDraft(tx, {
        id: questionId,
        q: candidate.question,
        knowledgeIds,
        sourceRoute: input.source_route,
        createdBy: sourcedCreatedBy(input.source_route, ctx.logTaskRunId),
        whitelistMatch: matchesWhitelist(candidate.question.source_url, whitelist),
        fetchedAt: now.toISOString(),
        canonicalContentHash: canonicalHash,
        supplyTrace: input.supply_trace,
        mergeActorRef: routeConfig.mergeActorRef,
        taskRunId: ctx.taskRunId,
        now,
      });
      if (inserted.status === 'raced_merged') return inserted;

      const hold =
        vectorNear != null && (await visibleSourceNeighbor(tx, vectorNear.id))
          ? vectorNearHoldMetadata(vectorNear)
          : null;
      const metadataJson = JSON.stringify({ ...metadataExtras, ...(hold ?? {}) });

      const [storedText] = await tx
        .select({
          prompt_md: question.prompt_md,
          reference_md: question.reference_md,
          choices_md: question.choices_md,
        })
        .from(question)
        .where(eq(question.id, questionId));
      const embedStamp =
        ingestVector != null &&
        storedText != null &&
        storedText.prompt_md === questionText.prompt_md &&
        (storedText.reference_md ?? null) === questionText.reference_md &&
        JSON.stringify(storedText.choices_md ?? null) === JSON.stringify(questionText.choices_md)
          ? questionEmbedStamp(
              {
                prompt_md: storedText.prompt_md,
                reference_md: storedText.reference_md,
                choices_md: storedText.choices_md ?? null,
              },
              ingestVector,
            )
          : null;

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
            metadata: sql`${question.metadata} || ${metadataJson}::jsonb`,
            updated_at: now,
            ...(embedStamp ?? {}),
          })
          .where(eq(question.id, questionId));
      } else {
        await tx
          .update(question)
          .set({
            metadata: sql`${question.metadata} || ${metadataJson}::jsonb`,
            updated_at: now,
            ...(embedStamp ?? {}),
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
        difficulty_reason: explainDifficultyEvidence(
          DifficultyEvidence.parse(persisted.difficultyEvidence),
        ),
        ...(input.demand_id ? { demand_id: input.demand_id } : {}),
        ...(input.supply_trace ? { supply_trace: input.supply_trace } : {}),
      },
      caused_by_event_id: ctx.causedByEventId ?? null,
      task_run_id: ctx.logTaskRunId ?? ctx.taskRunId,
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

// ── YUK-1568 S3：已声明候选 → 统一草稿链（producer→candidate→draft→submit→revision） ──
//
// 携带 parts/units 声明的候选不再经 insertSourcedDraft flat insert +
// publishQuestionGroupFromRow，而是：
//   candidate.question.parts → v2 草稿文档 → saveDraftEdit（草稿创建）
//   → submitDraftQuestion（单一发布 seam；同一事务铸 revision + 写行 +
//     durable source_verify intent）。
// KC 活体 / host / exact hash / source-URL / near-dup / vector 判重在
// runCandidateSubmit 里与旧路径同序位先跑；本函数只管声明文档的建存与提交。
// 首发事务：caller claim → bind/save → root+真实子行 → typed publish →
// verify intent + 域/候选回执，一次 commit；之后才 drain。向量输入戳和可观测
// canary 在 commit 后 best-effort；失败不重放已提交的业务。

/** 声明 → v2 草稿文档。内容文本过 ingest markup 清洗（与旧 flat 入库同口径；
 *  确定性、不改语义）；答案键（accepted/equivalent_forms）同口径清洗——旧
 *  flat 路径的 reference_md 本就经此清洗后才作判分输入。producer 声明的
 *  结构/槽位/id/answer_shape/blank_order 逐字保留，不重铸不推断。 */
function declaredCandidateDocument(
  q: SourcedQuestionT,
  sourceRoute: 'jyeoo_fetch' | 'sourcing_web',
  knowledgeIds: string[],
): { document: QuestionDraftDocumentT; markupSanitized: boolean } {
  let markupSanitized = false;
  const clean = (text: string): string => {
    const next = sanitizeSourcedMarkup(text);
    if (next !== text) markupSanitized = true;
    return next;
  };
  const parts = (q.parts ?? []).map((part) => ({
    ...part,
    prompt_md: clean(part.prompt_md),
    ...(part.explanation_md != null ? { explanation_md: clean(part.explanation_md) } : {}),
    units: part.units.map((unit) => ({
      ...unit,
      ...(unit.reference_md != null ? { reference_md: clean(unit.reference_md) } : {}),
      ...(unit.key?.kind === 'blank'
        ? {
            key:
              unit.key.key.kind === 'text'
                ? {
                    ...unit.key,
                    key: { ...unit.key.key, accepted: unit.key.key.accepted.map(clean) },
                  }
                : unit.key.key.equivalent_forms != null
                  ? {
                      ...unit.key,
                      key: {
                        ...unit.key.key,
                        equivalent_forms: unit.key.key.equivalent_forms.map(clean),
                      },
                    }
                  : unit.key,
          }
        : {}),
      response_spec:
        unit.response_spec.kind === 'select'
          ? {
              ...unit.response_spec,
              items: unit.response_spec.items.map((item) => ({
                ...item,
                ...(item.label_md != null ? { label_md: clean(item.label_md) } : {}),
              })),
              ...(unit.response_spec.text != null ? { text: clean(unit.response_spec.text) } : {}),
            }
          : unit.response_spec,
      ...(unit.rubric != null
        ? {
            rubric: {
              ...unit.rubric,
              ...(unit.rubric.guidance_md != null
                ? { guidance_md: clean(unit.rubric.guidance_md) }
                : {}),
              criteria: unit.rubric.criteria.map((criterion) => ({
                ...criterion,
                ...(criterion.statement_md != null
                  ? { statement_md: clean(criterion.statement_md) }
                  : {}),
              })),
            },
          }
        : {}),
    })),
  }));
  const document = QuestionDraftDocument.parse({
    schema_version: 2,
    parts,
    materials: [],
    knowledge_ids: knowledgeIds,
    metadata: {},
    source: { kind: sourceRoute, ref: q.source_url, note: q.source_title },
  });
  return { document, markupSanitized };
}

interface DeclaredCandidateRun {
  knowledgeIds: string[];
  canonicalHash: string;
  vectorNear: { id: string; similarity: number } | null;
  ingestVector: number[] | null;
  /** 实际送 embed 的 flat 文本（向量输入身份；R1 F4：只允许它与 stored
   *  投影一致时才复用向量戳，否则保持未嵌入交给 nightly backfill）。 */
  questionText: { prompt_md: string; reference_md: string; choices_md: string[] | null };
  now: Date;
}

/**
 * 已声明候选的 typed commit。来源核验走共享 seam 的 durable intent（source
 * 声明在文档里 kind=jyeoo_fetch/sourcing_web → submit 内嵌写
 * verify_dispatch_intent + 提交后 dispatch）；web_sourced provenance、flat
 * dedup 指纹、路由 created_by/difficulty 经 `sourced` 系统注入与发布同事务
 * 落行——source_verify 的确定性来源核对依赖 web_sourced.extract。
 */
function declaredCandidateOutcome(
  outcome: DeclaredGroupDomainOutcome,
  requestId: string,
  difficultyEvidence: unknown,
): Output {
  if (outcome.status === 'declaration_failed') {
    return {
      status: 'conflict',
      reason: 'invalid_declaration',
      detail: 'declared identity binding failed',
      issues: outcome.issues,
      request_id: requestId,
    };
  }
  const save = outcome.save;
  if (outcome.status === 'save_failed' || (save.status !== 'saved' && save.status !== 'noop')) {
    if (save.status === 'conflict') {
      return {
        status: 'conflict',
        reason: save.reason,
        detail: save.detail,
        request_id: requestId,
      };
    }
    if (save.status === 'rejected') {
      return {
        status: 'conflict',
        reason: 'invalid_declaration',
        detail: save.reason,
        issues: save.issues,
        request_id: requestId,
      };
    }
    return {
      status: 'conflict',
      reason: 'invalid_request',
      detail: `unexpected draft save status '${save.status}'`,
      request_id: requestId,
    };
  }
  const submit = outcome.submit;
  if (submit.status === 'conflict') {
    return {
      status: 'conflict',
      reason: submit.reason,
      detail: submit.detail,
      ...(submit.existing_question_id != null
        ? { existing_question_id: submit.existing_question_id }
        : {}),
      request_id: requestId,
    };
  }
  if ('published' in submit) {
    return {
      status: 'withheld',
      reason: 'draft_unpublishable',
      detail: submit.detail,
      issues: submit.issues,
      current_draft_ref: save.draft_ref,
      current_draft_version: save.draft_version,
      request_id: requestId,
    };
  }
  return {
    status: 'pending',
    question_id: submit.question_id,
    verify_enqueued: submit.verify_enqueued === true,
    difficulty_evidence: difficultyEvidence,
    request_id: requestId,
  };
}

async function runDeclaredCandidateSubmit(
  ctx: CandidateSubmitContext,
  input: ParsedInput & { candidate: NonNullable<ParsedInput['candidate']> },
  run: DeclaredCandidateRun,
): Promise<Output> {
  const { db } = ctx;
  const { candidate } = input;
  const q = candidate.question;
  const requestId = input.request_id;
  const { knowledgeIds, canonicalHash, vectorNear, ingestVector, questionText, now } = run;
  const routeConfig = COMMIT_ROUTE_CONFIG[input.source_route];

  // typed 路径本片不承载图片/figure 资产绑定（图片候选仍在旧 flat 写口）；
  // 声明+资产同现是 producer/调用方组合错误——显式冲突，不静默丢声明或资产。
  if (
    (candidate.image_refs?.length ?? 0) > 0 ||
    candidate.figures != null ||
    candidate.structured != null ||
    candidate.staged_asset_ids.length > 0
  ) {
    return {
      status: 'conflict',
      reason: 'invalid_request',
      detail:
        'declared parts with staged image/figure assets are not supported by the typed candidate submit',
      request_id: requestId,
    };
  }

  const whitelist = (resolveSubjectProfile(input.subject_id).sourceWhitelist ?? []) as string[];
  const webSourced: WebSourcedProvenanceT = {
    url: q.source_url,
    title: q.source_title,
    fetched_at: now.toISOString(),
    whitelist_match: matchesWhitelist(q.source_url, whitelist),
    ...(q.extraction_hash ? { extraction_hash: q.extraction_hash } : {}),
    extract: q.extract,
  };
  const declaredEvidence =
    q.difficulty_evidence ?? buildProducerDifficultyEvidence(q.difficulty, input.source_route, now);
  const difficultyEvidence = DifficultyEvidence.parse({
    ...declaredEvidence,
    observed_at: declaredEvidence.observed_at ?? now.toISOString(),
    source_route: declaredEvidence.source_route ?? input.source_route,
  });
  const supplyTrace = input.supply_trace
    ? withSupplyTraceDifficultyEvidence(input.supply_trace, difficultyEvidence)
    : undefined;

  // 向量近重 hold（与旧 flat 链同款：hit 存在且邻居仍可见 → 记 hold 待
  // source_verify 复核；可见性谓词同 ingest-dedup 的 visibleSourceRow）。
  const hold =
    vectorNear != null && (await visibleSourceNeighbor(db, vectorNear.id))
      ? vectorNearHoldMetadata(vectorNear)
      : null;

  const { document, markupSanitized } = declaredCandidateDocument(
    q,
    input.source_route,
    knowledgeIds,
  );

  const committed = await persistDeclaredQuestionGroup(db, {
    document,
    idNamespace: `yuk1568-candidate:${requestId}`,
    saveRequestId: `${requestId}:save`,
    submitRequestId: `${requestId}:submit`,
    ...(input.availability != null ? { availability: input.availability } : {}),
    sourced: {
      canonical_content_hash: canonicalHash,
      created_by: sourcedCreatedBy(input.source_route, ctx.logTaskRunId),
      difficulty: q.difficulty,
      metadata: {
        web_sourced: webSourced,
        source_ref_kind: 'url',
        difficulty_evidence: difficultyEvidence,
        prompt_image_refs: candidate.image_refs ?? [],
        knowledge_hints: candidate.knowledge_hints,
        attribution_state: input.attribution_state,
        ...(input.source_route === 'jyeoo_fetch'
          ? { jyeoo: { id: candidate.source_id, candidate_id: candidate.candidate_id } }
          : { sourcing: { candidate_id: candidate.candidate_id } }),
        ...(input.demand_id ? { demand_id: input.demand_id } : {}),
        ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
        ...(hold ?? {}),
        ...(markupSanitized ? { sourced_markup_sanitized: true } : {}),
      },
      ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
      // YUK-1568 S3（R1 F3）—— 一页一题 URL 终态 claim 移入 seam 的新组
      // INSERT 事务（与旧 flat persist tx 同锁域）；独立小事务会把 advisory
      // xact lock 在真实插入前放掉，并发同页候选双双漏过。
      source_claim: { source_url: q.source_url, actor_ref: routeConfig.mergeActorRef },
    },
    ctx: {
      actorRef: routeConfig.mergeActorRef,
      actorKind: 'agent',
      sessionId: ctx.sessionId ?? null,
      taskRunId: ctx.taskRunId,
      causedByEventId: ctx.causedByEventId ?? null,
      now,
    },
    caller: {
      requestId,
      fingerprint: candidateSubmitFingerprint(input),
      receipt: (outcome) => {
        const receipt = declaredCandidateOutcome(outcome, requestId, difficultyEvidence);
        return {
          subject: {
            kind: 'question',
            id: receipt.question_id ?? `candidate:${candidate.candidate_id}`,
          },
          receipt: receipt as SubmitResult,
          ctx: {
            actorRef: ctx.callerActor?.ref ?? 'agent:submit_question',
            actorKind: 'agent',
            sessionId: ctx.sessionId ?? null,
            taskRunId: ctx.taskRunId,
            causedByEventId: ctx.causedByEventId ?? null,
            now,
          },
        };
      },
    },
  });
  if (committed.status === 'replayed') return committed.receipt as Output;
  if (committed.status === 'request_id_reused') {
    return {
      status: 'conflict',
      reason: 'request_id_reused',
      detail: committed.detail,
      request_id: requestId,
    };
  }
  if (committed.status === 'submit_rolled_back') {
    return {
      status: 'conflict',
      reason: committed.submit.reason,
      detail: committed.submit.detail,
      request_id: requestId,
    };
  }
  const candidateResult = declaredCandidateOutcome(committed, requestId, difficultyEvidence);
  if (committed.status !== 'completed') return candidateResult;
  const { save, submit } = committed;
  if (submit.status === 'conflict' || 'published' in submit) return candidateResult;
  if (save.status !== 'saved' && save.status !== 'noop') return candidateResult;
  const questionId = submit.question_id;

  // 向量戳投影更新（best-effort，独立事务）：ingestVector 绑定的是 fetch 时
  // 实际送 embed 的 flat 文本（questionText）。只在行内投影与【该向量真实
  // 输入】逐字段一致时才复用——typed 投影常不等于 flat 文本（如 select 的
  // reference 投影成选项字母），错位把旧向量盖到新 hash 会污染
  // near-dup/similar_to 且 backfill 不纠正（embed_content_hash 已"有效"）。
  // 不一致保持未嵌入（abstain），nightly embed_backfill 会按行内文本重算；
  // 写时再以同内容 CAS 防读写间并发编辑。
  if (ingestVector != null) {
    try {
      const [stored] = await db
        .select({
          prompt_md: question.prompt_md,
          reference_md: question.reference_md,
          choices_md: question.choices_md,
          contentHash: question.canonical_content_hash,
        })
        .from(question)
        .where(eq(question.id, questionId))
        .limit(1);
      const embedInputMatchesStored =
        stored != null &&
        stored.prompt_md === questionText.prompt_md &&
        (stored.reference_md ?? null) === questionText.reference_md &&
        JSON.stringify(stored.choices_md ?? null) === JSON.stringify(questionText.choices_md);
      const stamp = embedInputMatchesStored
        ? questionEmbedStamp(
            {
              prompt_md: stored.prompt_md,
              reference_md: stored.reference_md,
              choices_md: stored.choices_md ?? null,
            },
            ingestVector,
          )
        : null;
      if (stamp != null && stored != null) {
        // 同内容 CAS：canonical_content_hash 是仓库既有的内容身份原语（非
        // 受管内容列）——读写间任何内容编辑都会变 hash，谓词不匹配 ⇒ 零行
        // 更新，戳不落。
        await db
          .update(question)
          .set({
            embedding: stamp.embedding,
            embed_model: stamp.embed_model,
            embed_version: stamp.embed_version,
            embed_content_hash: stamp.embed_content_hash,
            updated_at: now,
          })
          .where(
            and(
              eq(question.id, questionId),
              sql`${question.canonical_content_hash} IS NOT DISTINCT FROM ${stored.contentHash}`,
            ),
          );
      }
    } catch (err) {
      console.warn('[submit_question] declared-path embed stamp skipped:', err);
    }
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
        verify_enqueued: submit.verify_enqueued === true,
        difficulty_evidence: difficultyEvidence,
        difficulty_reason: explainDifficultyEvidence(difficultyEvidence),
        draft_block_id: parseDraftRef(save.draft_ref)?.blockId ?? save.draft_ref,
        ...(input.demand_id ? { demand_id: input.demand_id } : {}),
        ...(input.supply_trace ? { supply_trace: input.supply_trace } : {}),
      },
      caused_by_event_id: ctx.causedByEventId ?? null,
      task_run_id: ctx.logTaskRunId ?? ctx.taskRunId,
      cost_micro_usd: null,
      created_at: now,
    });
  } catch (eventErr) {
    console.error('[submit_question] canary event write failed; commit stands:', eventErr);
  }

  return candidateResult;
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
  ctx: CandidateSubmitContext,
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
  // reason 的运行时值如实透传（typed 声明路径可能产生 draft_unpublishable /
  // invalid_declaration / *_cas 等五元组之外的拒绝码；该 as 既有放宽先例
  // ——'request_id_reused'/'missing_subject_id' 一直这样流过）。真实 reason
  // 同时进 detail，供 tally/轨迹辨认。
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
    '统一题目提交闸。draft_ref 提交 v2 草稿文档（或 legacy 适配块）→ 契约四层 → publishQuestionGroup 单一发布 seam；编辑已发布题叠加新 revision 不覆盖原版。来源 generated/adapted/owner_material/photo_ingest/jyeoo_fetch/sourcing_web/manual — 非 fetch 来源用可复现内容指纹，绝不伪造 extraction_hash。也可提交 jyeoo_fetch/sourcing_web 候选（原 store_sourced_question 语义：dedup/KC 活体/verify outbox）；带 typed parts/units 声明的候选改走统一草稿链 共享save/submit原子事务（未声明照旧 flat 路径）。返回 admitted/withheld/conflict/pending + 逐 unit 判分准入原因。request_id 必填幂等；conflict 不重试原请求。',
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
