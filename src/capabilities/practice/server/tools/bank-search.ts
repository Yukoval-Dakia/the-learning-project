// ADR-0072 D1/D2/D6 — search_bank 检索引擎（工具壳在 search-bank.ts）。
//
// 职责（提案 §6）：在真实题库上找候选。结构化硬过滤（SQL 谓词）+ Postgres FTS
// （simple 词典 + CJK 逐字切分；今天没有 tsvector 列，LIGHT 不加迁移，查询时
// 表达式计算 —— D6：数万行暴力可接受）与暴力 pgvector 向量召回并行，RRF 融合。
// 返回版本化 ref（bank-ref.ts）+ 显式 scope + cursor；候选池 = 通道命中并集 ∩
// 硬过滤，不冒充语义匹配总数。不做教学效用排序（agent 的活）。
//
// 向量查询与池中向量走同一 embedding seam（matcher §190 铁律同款）：默认
// embedText（DashScope text-embedding-v4@1024 + provider attempt 记账），测试
// 注入确定性 fake。embed 失败 → 通道记 unavailable，FTS 照常（诚实降级）。
//
// 教学决策、批改、learner state 一概不碰（硬边界 1/2）。

import { createHash } from 'node:crypto';
import { type SQL, and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { deriveSourceTier } from '@/core/schema/provenance';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import {
  item_calibration,
  knowledge,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { embedText } from '@/server/ai/embed';
import { canonicalKindToPersistedForms } from '@/subjects/question-kind';
import { EvidenceDemandV1 } from '../question-supply/evidence-demand';
import { MATCHER_COSINE_MAX_DISTANCE } from '../quiz/matcher';
import { encodeBankRef, readBankServableParts, resolveBankRefs } from './bank-ref';

/** 每个召回通道的截断上限（OOM 保护；命中即 retrieval_truncated=true）。 */
export const BANK_SEARCH_CHANNEL_CAP = 200;

/** RRF 常数（标准 k=60；rank 从 1 计）。 */
export const BANK_SEARCH_RRF_K = 60;

// YUK-1448 — 难度硬过滤。两条基准互斥，绝不混量：
//   - 'authored'   → question.difficulty（作者难度，1–5 整数，NOT NULL）。
//   - 'calibrated' → item_calibration(track='hard') 的 effectiveB（COALESCE(b_calib,
//     b_anchor, b)，logit 尺度）。**校准未知（无 row / effectiveB NULL）的题一律排除**，
//     绝不退回作者难度冒充校准值（「校准未知不混为作者难度」）。
export const BankDifficultyFilterSchema = z
  .object({
    basis: z.enum(['authored', 'calibrated']),
    /** [lo, hi] 闭区间；authored 尺度 1–5，calibrated 尺度 logit b。 */
    range: z.tuple([z.number().finite(), z.number().finite()]),
  })
  .strict()
  .superRefine((filter, ctx) => {
    const [lo, hi] = filter.range;
    if (lo > hi) {
      ctx.addIssue({ code: 'custom', message: 'difficulty.range must satisfy lo <= hi' });
    }
    if (filter.basis === 'authored' && (lo < 1 || hi > 5)) {
      ctx.addIssue({
        code: 'custom',
        message: 'authored difficulty range must stay within the 1-5 integer scale',
      });
    }
  });
export type BankDifficultyFilter = z.infer<typeof BankDifficultyFilterSchema>;

/** YUK-1448 — similar_to：以某道题的同版内容向量为向量通道查询向量。 */
export const BankSimilarToSchema = z
  .object({
    /** 当前版本 bank ref（锚必须是 current revision——存量向量反映工作副本当前内容）。 */
    question_ref: z.string().min(1),
    aspect: z.literal('content'),
  })
  .strict();
export type BankSimilarTo = z.infer<typeof BankSimilarToSchema>;

export const BankSearchScopeSchema = z
  .object({
    subject: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    within_refs: z.array(z.string().min(1)).max(200).optional(),
    /** 知识点硬过滤：按真实（live、未归档）科目 KC 解析；未知/已归档 id 显式报错。 */
    knowledge_ids: z.array(z.string().min(1)).min(1).max(50).optional(),
    /** 'any'（默认，题含任一 KC）| 'all'（题含全部 KC）。仅在 knowledge_ids 存在时生效。 */
    knowledge_mode: z.enum(['any', 'all']).optional(),
    difficulty: BankDifficultyFilterSchema.optional(),
    /** 学习者侧调用方自带的「已见过」ref 列表；按 question 身份（group root）跨所有
     * revision 排除。bank 永不查 learner state——排除名单只来自本输入。 */
    exclude_refs: z.array(z.string().min(1)).min(1).max(200).optional(),
    similar_to: BankSimilarToSchema.optional(),
    draft_state: z.enum(['all', 'active', 'draft']),
    admission_state: z.enum(['any', 'admitted', 'withheld']),
  })
  .strict();
export type BankSearchScope = z.infer<typeof BankSearchScopeSchema>;

// A gap describes the unsatisfied combination, not a claim that each filter is absent.
export const BankUnsatisfiedConstraintsSchema = z.object({
  query: z.string(),
  scope: BankSearchScopeSchema,
  requested_count: z.number().int().positive(),
  retrieved_count: z.number().int().nonnegative(),
  reason: z.literal('insufficient_retrieved_candidates'),
});
export const BankGapRequestSchema = z.object({
  target_contract: z.literal('EvidenceDemandV1'),
  status: z.literal('needs_agent_context_and_filing_tool'),
  claim: EvidenceDemandV1.shape.claim.pick({ kind: true, statement: true }).extend({
    kind: z.literal('content_coverage'),
  }),
  inventory_goal: EvidenceDemandV1.shape.inventory_goal.pick({ eligible_count: true }),
  causes: EvidenceDemandV1.shape.causes,
  constraints: BankUnsatisfiedConstraintsSchema,
  required_context: z.array(z.string()),
});

/** 两种调用形态互斥（提案 §6）：新检索（query + scope）或续页（cursor 只续同一次检索）。 */
export type BankSearchRequest =
  | { form: 'new'; query: string; scope: BankSearchScope; limit: number }
  | { form: 'cursor'; cursor: string };

export interface BankSearchDeps {
  /** 查询向量 seam；缺省走 embedText + provider attempt 记账（与本夜 backfill 同源）。 */
  embedFn?: (text: string) => Promise<number[]>;
}

export interface BankSearchMatchEvidence {
  channel: 'fts' | 'vector';
  /** prompt_md 原文前缀（定位摘录；截断以 … 标记，绝不改写原文）。 */
  excerpt: string;
}

export interface BankSearchHit {
  /** 版本化内容引用（当前 revision）；未发布 draft 为 null + missing 说明。 */
  ref: string | null;
  kind: 'question' | 'group';
  /** 可变工作副本指针（write_quiz 等既有消费方用；不是版本身份）。 */
  question_id: string;
  group_id: string;
  title: string;
  draft_status: string | null;
  admission: { state: 'admitted' | 'withheld'; withheld_reason: string | null } | null;
  availability: 'general_pool' | 'container_only' | null;
  suspended: boolean;
  source: string;
  automatically_servable_part_ids: string[];
  source_tier: { tier: number; name: string };
  difficulty: number;
  knowledge_ids: string[];
  match_evidence: BankSearchMatchEvidence[];
  missing: string[];
}

export interface BankSearchCoverage {
  /** Retrieval quantity only; semantic requirements remain unverified. */
  verdict: 'enough' | 'sparse' | 'none';
  unsatisfied_constraints: Array<z.infer<typeof BankUnsatisfiedConstraintsSchema>>;
  gap_request: z.infer<typeof BankGapRequestSchema> | null;
  /** 融合候选池的实际数量（有限池，不是语义匹配总数）。 */
  candidate_pool_size: number;
  /** 任一通道命中截断上限（翻完本池 ≠ 搜索全库穷尽）。 */
  retrieval_truncated: boolean;
  page_has_more: boolean;
  next_cursor: string | null;
  unavailable_channels: Array<'fts' | 'vector'>;
  /** true ⇔ 本页穷尽候选池且无通道截断/不可用。 */
  complete: boolean;
}

export interface BankSearchOutput {
  scope_applied: {
    subject?: { profile: string; knowledge_id_count: number };
    kind?: { canonical: string; persisted_forms: string[] };
    source?: string;
    within_refs?: string[];
    knowledge?: { ids: string[]; mode: 'any' | 'all'; resolved_count: number };
    difficulty?: {
      basis: 'authored' | 'calibrated';
      range: [number, number];
      scale: 'authored_1_5' | 'calibrated_logit_b';
    };
    exclude_refs?: { refs: string[]; excluded_question_ids: number };
    similar_to?: { question_ref: string; aspect: 'content'; vector_available: boolean };
    draft_state: BankSearchScope['draft_state'];
    admission_state: BankSearchScope['admission_state'];
  };
  requirements: {
    enforced: string[];
    not_verified: string[];
  };
  hits: BankSearchHit[];
  coverage: BankSearchCoverage;
}

// ── cursor（只续同一次检索；新条件必须新查询）──────────────────────────────

const BankSearchCursorSchema = z
  .object({
    v: z.literal(2),
    q: z.string().trim().min(1).max(400),
    scope: BankSearchScopeSchema,
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    f: z.string().regex(/^[a-f0-9]{16}$/),
    pool: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            channels: z
              .array(z.enum(['fts', 'vector']))
              .min(1)
              .max(2),
          })
          .strict(),
      )
      .max(BANK_SEARCH_CHANNEL_CAP * 2),
    snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.number().int().positive(),
    retrieval_truncated: z.boolean(),
    unavailable_channels: z.array(z.enum(['fts', 'vector'])).max(2),
  })
  .strict();
type BankSearchCursor = z.infer<typeof BankSearchCursorSchema>;

export function bankSearchFingerprint(
  query: string,
  scope: BankSearchScope,
  limit: number,
): string {
  const canonical = JSON.stringify({ q: query, scope, limit });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function encodeBankSearchCursor(cursor: Omit<BankSearchCursor, 'f'>): string {
  const f = bankSearchFingerprint(cursor.q, cursor.scope, cursor.limit);
  return Buffer.from(JSON.stringify({ ...cursor, f }), 'utf8').toString('base64url');
}

export function decodeBankSearchCursor(raw: string): BankSearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor is not a valid bank-search cursor');
  }
  const result = BankSearchCursorSchema.safeParse(parsed);
  if (!result.success) throw new Error('cursor is not a valid bank-search cursor');
  const c = result.data;
  if (c.expires_at <= Date.now()) throw new Error('bank-search cursor expired; start a new search');
  if (new Set(c.pool.map((hit) => hit.id)).size !== c.pool.length) {
    throw new Error('cursor is not a valid bank-search cursor');
  }
  if (c.f !== bankSearchFingerprint(c.q, c.scope, c.limit)) {
    throw new Error(
      'cursor fingerprint mismatch — start a new search instead of mixing a cursor with changed conditions',
    );
  }
  return c;
}

// ── RRF 融合（内部排序）───────────────────────────────────────

export interface RrfChannelHit {
  id: string;
  /** 0-based 通道内名次。 */
  rank: number;
}

export interface RrfFused {
  id: string;
  score: number;
  /** 命中该 id 的通道名（输入顺序）。 */
  channels: string[];
}

export function rrfFuse(
  channels: Array<{ name: string; hits: RrfChannelHit[] }>,
  k = BANK_SEARCH_RRF_K,
): RrfFused[] {
  const byId = new Map<string, RrfFused>();
  for (const channel of channels) {
    for (const hit of channel.hits) {
      const contribution = 1 / (k + hit.rank + 1);
      const existing = byId.get(hit.id);
      if (existing) {
        existing.score += contribution;
        if (!existing.channels.includes(channel.name)) existing.channels.push(channel.name);
      } else {
        byId.set(hit.id, { id: hit.id, score: contribution, channels: [channel.name] });
      }
    }
  }
  return [...byId.values()].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1,
  );
}

// ── CJK 切分（FTS simple 词典对中文无分词，逐字切开后按字 AND 匹配）───────

export const CJK_FTS_SPLIT = '([一-鿿])';

/** 逐字切分的替换文本（反斜杠 + 1 + 空格）。作为绑定参数传入——避免模板字面量里
 * 的 legacy 八进制转义陷阱（cooked 值会变 undefined）。 */
const CJK_FTS_REPLACEMENT = '\\1 ';

/** FTS 文档表达式：prompt + reference + choices 的 JSON 文本，统一逐字切分。 */
function ftsDocumentExpr(): SQL {
  const doc = sql`concat_ws(' ', ${question.prompt_md}, ${question.reference_md}, ${question.choices_md}::text)`;
  return sql`regexp_replace(${doc}, ${CJK_FTS_SPLIT}, ${CJK_FTS_REPLACEMENT}, 'g')`;
}

function ftsQueryExpr(queryText: string): SQL {
  return sql`plainto_tsquery('simple', regexp_replace(${queryText}, ${CJK_FTS_SPLIT}, ${CJK_FTS_REPLACEMENT}, 'g'))`;
}

// ── 硬过滤（SQL 谓词；全部确定性）─────────────────────────────────────────

interface ResolvedScope {
  scope: BankSearchScope;
  subjectKnowledgeIds?: string[];
  kindForms?: string[];
  withinRevisionIds?: string[];
  /** 去重后的 KC 硬过滤集（已验证全部为 live KC）。 */
  knowledgeFilterIds?: string[];
  /** KC 过滤语义：缺省 'any'。仅在 knowledgeFilterIds 存在时读。 */
  knowledgeFilterMode: 'any' | 'all';
  /** exclude_refs 解析出的 question 身份（group root id）集合。 */
  excludedQuestionIds?: string[];
  /** similar_to 锚的 question 身份（group root id）。 */
  similarToGroupId?: string;
}

async function resolveScope(db: Db | Tx, scope: BankSearchScope): Promise<ResolvedScope> {
  const resolved: ResolvedScope = { scope, knowledgeFilterMode: scope.knowledge_mode ?? 'any' };
  if (scope.subject !== undefined) {
    resolved.subjectKnowledgeIds = await resolveSubjectKnowledgeIds(db, scope.subject);
  }
  if (scope.kind !== undefined) {
    resolved.kindForms = canonicalKindToPersistedForms(scope.kind);
  }
  if (scope.within_refs !== undefined) {
    const refs = await resolveBankRefs(db, scope.within_refs);
    resolved.withinRevisionIds = refs.map((ref) => {
      if (ref.status !== 'ok') throw new Error(`within_refs: ${ref.raw}: ${ref.status}`);
      if (ref.lifecycle?.current_revision_id !== ref.revision.revision_id) {
        throw new Error(
          `within_refs: ${ref.raw}: superseded; search indexes only current revisions, read_bank can read this exact version`,
        );
      }
      return ref.revision.revision_id;
    });
  }
  if (scope.knowledge_ids !== undefined) {
    // 解析为真实科目 KC：去重后逐 id 校验 live（未归档）。未知/已归档 id 显式报错，
    // 绝不静默丢弃（静默丢弃 = 有效范围被窄化而调用方不知情）。
    const requested = [...new Set(scope.knowledge_ids)];
    const liveRows = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, requested), isNull(knowledge.archived_at)));
    const live = new Set(liveRows.map((row) => row.id));
    const unknown = requested.filter((id) => !live.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `knowledge_ids: not live knowledge components (unknown or archived): ${unknown.join(', ')}`,
      );
    }
    resolved.knowledgeFilterIds = requested;
  }
  if (scope.exclude_refs !== undefined) {
    // 跨所有 revision 按 question 身份（revision.group_id = group root）排除。任意
    // revision 的 ref 都接受（superseded 也指向同一身份）；解不动/摘要不符/已撤回
    // 显式报错——排除名单自身必须可信，否则「排除」变成静默放行。
    const refs = await resolveBankRefs(db, scope.exclude_refs);
    const ids = new Set<string>();
    for (const ref of refs) {
      if (ref.status !== 'ok') {
        throw new Error(`exclude_refs: ${ref.raw}: ${ref.status} (${ref.detail})`);
      }
      ids.add(ref.revision.group_id);
    }
    resolved.excludedQuestionIds = [...ids];
  }
  if (scope.similar_to !== undefined) {
    const [ref] = await resolveBankRefs(db, [scope.similar_to.question_ref]);
    if (ref == null) {
      throw new Error(`similar_to: ${scope.similar_to.question_ref}: unresolvable`);
    }
    if (ref.status !== 'ok') {
      throw new Error(
        `similar_to: ${scope.similar_to.question_ref}: ${ref.status} (${ref.detail})`,
      );
    }
    if (ref.lifecycle?.current_revision_id !== ref.revision.revision_id) {
      throw new Error(
        `similar_to: ${scope.similar_to.question_ref}: superseded; the stored content vector reflects the current revision — pass the current ref or read_bank the exact version`,
      );
    }
    resolved.similarToGroupId = ref.revision.group_id;
  }
  return resolved;
}

function buildFilters(resolved: ResolvedScope): SQL[] {
  const { scope } = resolved;
  const filters: SQL[] = [
    // 顶层行（组根本身）；part 行经组读取，不单独成候选。
    sql`(${question.parent_question_id} IS NULL)`,
    // 固定窗口诊断题不经题库面外泄。
    sql`(${question.source} <> ${INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE})`,
    // 死行与软删墓碑（listQuestions 同款标记族）。
    sql`((${question.metadata} -> 'dismissed_at') IS NULL)`,
    sql`((${question.metadata} -> 'archived_at') IS NULL)`,
  ];
  if (scope.draft_state === 'active') {
    filters.push(notDraftPredicate(question.draft_status));
  } else if (scope.draft_state === 'draft') {
    filters.push(eq(question.draft_status, 'draft'));
  }
  const lc = question_group_lifecycle;
  if (scope.admission_state === 'admitted') {
    filters.push(
      sql`(${lc.group_id} IS NOT NULL AND ${lc.scoring_admission_state} = 'admitted' AND ${lc.withdrawn} = false AND ${lc.suspended} = false)`,
    );
  } else if (scope.admission_state === 'withheld') {
    filters.push(
      sql`(${lc.group_id} IS NOT NULL AND ${lc.scoring_admission_state} = 'withheld' AND ${lc.withdrawn} = false)`,
    );
  } else {
    // 'any'：只排除已撤回（archive 已由 metadata 墓碑排除，此处兜底）。
    filters.push(sql`(${lc.withdrawn} IS NULL OR ${lc.withdrawn} = false)`);
  }
  if (resolved.subjectKnowledgeIds !== undefined) {
    if (resolved.subjectKnowledgeIds.length === 0) {
      filters.push(sql`false`);
    } else {
      const containers = resolved.subjectKnowledgeIds.map(
        (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
      );
      filters.push(sql`(${sql.join(containers, sql` OR `)})`);
    }
  }
  if (resolved.kindForms !== undefined) {
    if (resolved.kindForms.length === 0) {
      filters.push(sql`false`);
    } else {
      filters.push(
        sql`(${question.kind} IN (${sql.join(
          resolved.kindForms.map((f) => sql`${f}`),
          sql`, `,
        )}))`,
      );
    }
  }
  if (resolved.withinRevisionIds !== undefined) {
    filters.push(
      resolved.withinRevisionIds.length === 0
        ? sql`false`
        : inArray(lc.current_revision_id, resolved.withinRevisionIds),
    );
  }
  if (scope.source !== undefined) {
    filters.push(sql`(${question.source} = ${scope.source})`);
  }
  if (resolved.knowledgeFilterIds !== undefined) {
    // any = 题含任一 KC（逐 id 容器 OR）；all = 题含全部 KC（单容器包含检查）。
    if (resolved.knowledgeFilterIds.length === 0) {
      filters.push(sql`false`);
    } else if (resolved.knowledgeFilterMode === 'all') {
      filters.push(
        sql`(${question.knowledge_ids} @> ${JSON.stringify(resolved.knowledgeFilterIds)}::jsonb)`,
      );
    } else {
      const containers = resolved.knowledgeFilterIds.map(
        (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
      );
      filters.push(sql`(${sql.join(containers, sql` OR `)})`);
    }
  }
  if (scope.difficulty !== undefined) {
    const [lo, hi] = scope.difficulty.range;
    if (scope.difficulty.basis === 'authored') {
      // 作者难度 1–5 整数（NOT NULL）；闭区间。
      filters.push(sql`(${question.difficulty} BETWEEN ${lo} AND ${hi})`);
    } else {
      // 校准难度：item_calibration(track='hard') 的 effectiveB（logit 尺度）。
      // 无 row / effectiveB NULL（校准未知）的题被 EXISTS 天然排除——绝不退回作者难度。
      filters.push(
        sql`EXISTS (SELECT 1 FROM ${item_calibration} ic WHERE ic.question_id = ${question.id} AND ic.track = 'hard' AND COALESCE(ic.b_calib, ic.b_anchor, ic.b) BETWEEN ${lo} AND ${hi})`,
      );
    }
  }
  if (resolved.excludedQuestionIds !== undefined) {
    // 排除在通道层生效（不占召回配额）：被排除身份根本不进候选池。
    filters.push(
      resolved.excludedQuestionIds.length === 0
        ? sql`true`
        : sql`(${question.id} NOT IN (${sql.join(
            resolved.excludedQuestionIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`,
    );
  }
  return filters;
}

// ── 主入口 ────────────────────────────────────────────────────────────────

function preview(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 在真实题库上执行一次 search_bank 检索。纯读；查询嵌入经 deps.embedFn
 * （缺省 DashScope embedText + provider attempt 记账）。
 */
export async function runSearchBank(
  db: Db,
  request: BankSearchRequest,
  deps: BankSearchDeps = {},
): Promise<BankSearchOutput> {
  // Provider attempts write operational receipts, so finish them outside the
  // read-only bank snapshot. Resuming a cursor never embeds again. A similar_to
  // search reuses the anchor question's stored content vector instead of
  // embedding the query text, so no provider call is made either way.
  let embedded: { vector: number[] } | { error: unknown } | undefined;
  if (request.form === 'new' && request.scope.similar_to === undefined) {
    const embedFn =
      deps.embedFn ??
      ((text: string) =>
        embedText(text, {
          db,
          caller: 'api',
          deadlineAt: new Date(Date.now() + 20_000),
        }));
    try {
      embedded = { vector: await embedFn(request.query.trim()) };
    } catch (error) {
      embedded = { error };
    }
  }
  return db.transaction(
    (tx) =>
      runSearchBankInSnapshot(tx, request, {
        embedFn: async () => {
          if (embedded === undefined) throw new Error('cursor continuation must not embed');
          if ('error' in embedded) throw embedded.error;
          return embedded.vector;
        },
      }),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

async function runSearchBankInSnapshot(
  db: Db | Tx,
  request: BankSearchRequest,
  deps: Required<BankSearchDeps>,
): Promise<BankSearchOutput> {
  let offset = 0;
  let cursor: BankSearchCursor | undefined;
  let limit: number;
  let scope: BankSearchScope;
  let effectiveQuery: string;
  if (request.form === 'cursor') {
    const c = decodeBankSearchCursor(request.cursor);
    cursor = c;
    effectiveQuery = c.q;
    scope = c.scope;
    limit = c.limit;
    offset = c.offset;
  } else {
    effectiveQuery = request.query.trim();
    scope = request.scope;
    limit = request.limit;
  }

  const resolved = await resolveScope(db, scope);
  const filters = buildFilters(resolved);
  const where = and(...filters);

  let fused: RrfFused[];
  let unavailable: BankSearchCoverage['unavailable_channels'];
  let retrievalTruncated: boolean;
  if (cursor) {
    // Resume the original bounded pool. New rows/ranks never replace earlier results,
    // and pagination makes no additional embedding/provider call.
    fused = cursor.pool.map((hit) => ({ ...hit, score: 0 }));
    unavailable = cursor.unavailable_channels;
    retrievalTruncated = cursor.retrieval_truncated;
  } else {
    // ── 通道 A：Postgres FTS（simple + CJK 逐字切分）──
    const tsvec = sql`to_tsvector('simple', ${ftsDocumentExpr()})`;
    const tsq = ftsQueryExpr(effectiveQuery);
    const ftsRowsPromise = db
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        created_at: question.created_at,
        rank: sql<number>`ts_rank(${tsvec}, ${tsq})`,
      })
      .from(question)
      .leftJoin(question_group_lifecycle, eq(question_group_lifecycle.group_id, question.id))
      .where(and(where, sql`${tsvec} @@ ${tsq}`))
      .orderBy(desc(sql`ts_rank(${tsvec}, ${tsq})`), desc(question.created_at), desc(question.id))
      .limit(BANK_SEARCH_CHANNEL_CAP + 1);

    // ── 通道 B：暴力 pgvector cosine（embed 失败 → 通道不可用，不阻塞 FTS）──
    // similar_to（YUK-1448）：不嵌查询文本，改用锚题的同版内容向量（快照内读回）。
    // 锚无向量（从未嵌入/被编辑失效等待回填）→ 通道不可用，FTS 照常——诚实降级，
    // 绝不退回查询文本向量冒充内容相似。锚题自身仍是合法候选（距离 0 最相似；
    // 调用方可用 exclude_refs 显式排除）。
    let anchorVector: number[] | null = null;
    if (resolved.similarToGroupId !== undefined) {
      const [anchorRow] = await db
        .select({ embedding: question.embedding })
        .from(question)
        .where(eq(question.id, resolved.similarToGroupId))
        .limit(1);
      anchorVector = anchorRow?.embedding ?? null;
    }
    const vectorPromise: Promise<{ vector: number[] | null; error?: string }> =
      resolved.similarToGroupId !== undefined
        ? anchorVector != null
          ? Promise.resolve({ vector: anchorVector })
          : Promise.resolve({
              vector: null,
              error:
                'similar_to anchor question has no content vector (never embedded or invalidated by a content edit; awaiting embed_backfill)',
            })
        : deps
            .embedFn(effectiveQuery)
            .then((vector) => ({ vector }))
            .catch((err: unknown) => ({
              vector: null,
              error: err instanceof Error ? err.message : String(err),
            }));

    const [ftsAll, vectorResult] = await Promise.all([ftsRowsPromise, vectorPromise]);

    const ftsTruncated = ftsAll.length > BANK_SEARCH_CHANNEL_CAP;
    const ftsRows = ftsAll.slice(0, BANK_SEARCH_CHANNEL_CAP);
    unavailable = [];

    const channels: Array<{ name: string; hits: RrfChannelHit[] }> = [
      { name: 'fts', hits: ftsRows.map((r, i) => ({ id: r.id, rank: i })) },
    ];

    let vectorTruncated = false;
    let vectorRows: Array<{ id: string; created_at: Date }> = [];
    if (vectorResult.vector != null) {
      const distanceExpr = sql<number>`(${question.embedding} <=> ${toSqlVector(vectorResult.vector)}::vector)`;
      const vecAll = await db
        .select({ id: question.id, created_at: question.created_at })
        .from(question)
        .leftJoin(question_group_lifecycle, eq(question_group_lifecycle.group_id, question.id))
        .where(
          and(
            where,
            sql`${question.embedding} IS NOT NULL`,
            sql`${distanceExpr} <= ${MATCHER_COSINE_MAX_DISTANCE}`,
          ),
        )
        .orderBy(sql`${distanceExpr} ASC`)
        .limit(BANK_SEARCH_CHANNEL_CAP + 1);
      vectorTruncated = vecAll.length > BANK_SEARCH_CHANNEL_CAP;
      vectorRows = vecAll.slice(0, BANK_SEARCH_CHANNEL_CAP);
      channels.push({ name: 'vector', hits: vectorRows.map((r, i) => ({ id: r.id, rank: i })) });
    } else {
      unavailable.push('vector');
    }

    retrievalTruncated = ftsTruncated || vectorTruncated;
    fused = rrfFuse(channels);
  }

  // Revalidate the complete bounded pool before slicing. A changed/withdrawn card
  // expires the cursor explicitly; immutable refs are never silently replaced.
  const servableParts = await readBankServableParts(
    db,
    fused.map((hit) => hit.id),
  );
  if (scope.admission_state === 'admitted') {
    fused = fused.filter((hit) => (servableParts.get(hit.id)?.length ?? 0) > 0);
  }
  const pageIds = fused.map((hit) => hit.id);

  const hits: BankSearchHit[] = [];
  if (pageIds.length > 0) {
    const cardRows = await db
      .select({
        id: question.id,
        kind: question.kind,
        prompt_md: question.prompt_md,
        source: question.source,
        source_ref: question.source_ref,
        metadata: question.metadata,
        difficulty: question.difficulty,
        knowledge_ids: question.knowledge_ids,
        draft_status: question.draft_status,
        created_at: question.created_at,
        lc_state: question_group_lifecycle.scoring_admission_state,
        lc_withheld_reason: question_group_lifecycle.scoring_admission_withheld_reason,
        lc_availability: question_group_lifecycle.availability,
        lc_suspended: question_group_lifecycle.suspended,
        lc_withdrawn: question_group_lifecycle.withdrawn,
        lc_current_revision_id: question_group_lifecycle.current_revision_id,
      })
      .from(question)
      .leftJoin(question_group_lifecycle, eq(question_group_lifecycle.group_id, question.id))
      .where(and(where, inArray(question.id, pageIds)));
    const cardById = new Map(cardRows.map((r) => [r.id, r]));

    // 当前 revision digest → 版本化 ref。
    const currentRevisionIds = [
      ...new Set(
        cardRows.map((r) => r.lc_current_revision_id).filter((id): id is string => id != null),
      ),
    ];
    const revisionDigestById = new Map<string, { revision_id: string; digest: string }>();
    if (currentRevisionIds.length > 0) {
      const revRows = await db
        .select({
          revision_id: question_revision.revision_id,
          digest: question_revision.integrity_digest,
        })
        .from(question_revision)
        .where(inArray(question_revision.revision_id, currentRevisionIds));
      for (const r of revRows) revisionDigestById.set(r.revision_id, r);
    }

    // 组成员数（live part 行）→ question/group 卡片 kind。
    const childRows = await db
      .select({ parent: question.parent_question_id, n: sql<number>`count(*)::int` })
      .from(question)
      .where(
        and(
          inArray(question.parent_question_id, pageIds),
          sql`((${question.metadata} -> 'archived_at') IS NULL)`,
          sql`((${question.metadata} -> 'dismissed_at') IS NULL)`,
        ),
      )
      .groupBy(question.parent_question_id);
    const childCount = new Map(childRows.map((r) => [r.parent as string, r.n]));

    for (const fusedHit of fused) {
      const row = cardById.get(fusedHit.id);
      if (row == null) continue; // 翻页窗口内被删——如实跳过
      const currentRevision =
        row.lc_current_revision_id != null
          ? revisionDigestById.get(row.lc_current_revision_id)
          : undefined;
      const missing: string[] = [];
      if (currentRevision == null) missing.push('no_published_revision');
      const evidence: BankSearchMatchEvidence[] = fusedHit.channels.map((channel) => ({
        channel: channel as BankSearchMatchEvidence['channel'],
        excerpt: preview(row.prompt_md, 160),
      }));
      const { tier, name } = deriveSourceTier({ source: row.source, metadata: row.metadata });
      hits.push({
        ref:
          currentRevision != null
            ? encodeBankRef(currentRevision.revision_id, currentRevision.digest)
            : null,
        kind: (childCount.get(row.id) ?? 0) > 0 ? 'group' : 'question',
        question_id: row.id,
        group_id: row.id,
        title: preview(row.prompt_md, 80),
        draft_status: row.draft_status,
        admission:
          row.lc_state != null
            ? {
                state: row.lc_state as 'admitted' | 'withheld',
                withheld_reason: row.lc_withheld_reason ?? null,
              }
            : null,
        availability: (row.lc_availability as BankSearchHit['availability']) ?? null,
        suspended: row.lc_suspended === true,
        source: row.source,
        automatically_servable_part_ids: servableParts.get(row.id) ?? [],
        source_tier: { tier, name },
        difficulty: row.difficulty,
        knowledge_ids: row.knowledge_ids ?? [],
        match_evidence: evidence,
        missing,
      });
    }
  }

  const snapshotHash = createHash('sha256').update(JSON.stringify(hits)).digest('hex');
  if (cursor && snapshotHash !== cursor.snapshot_hash) {
    throw new Error('bank-search cursor expired: candidate snapshot changed; start a new search');
  }
  const confirmedPoolSize = hits.length;
  const pageHits = hits.slice(offset, offset + limit);
  const hasMore = offset + pageHits.length < confirmedPoolSize;
  const hitIds = new Set(hits.map((hit) => hit.question_id));
  const nextCursor = hasMore
    ? encodeBankSearchCursor({
        v: 2,
        q: effectiveQuery,
        scope,
        limit,
        offset: offset + limit,
        pool: fused
          .filter((hit) => hitIds.has(hit.id))
          .map(({ id, channels }) => ({
            id,
            channels: channels as Array<'fts' | 'vector'>,
          })),
        snapshot_hash: snapshotHash,
        expires_at: cursor?.expires_at ?? Date.now() + 15 * 60_000,
        retrieval_truncated: retrievalTruncated,
        unavailable_channels: unavailable,
      })
    : null;

  const enforced: string[] = [];
  if (resolved.subjectKnowledgeIds !== undefined) {
    enforced.push(
      `subject=${scope.subject} (resolved to ${resolved.subjectKnowledgeIds.length} knowledge ids)`,
    );
  }
  if (resolved.kindForms !== undefined) {
    enforced.push(`kind=${scope.kind} (persisted forms: ${resolved.kindForms.join(', ')})`);
  }
  if (scope.source !== undefined) enforced.push(`source=${scope.source}`);
  if (scope.within_refs !== undefined)
    enforced.push('within_refs (exact current revisions only; empty means empty scope)');
  if (resolved.knowledgeFilterIds !== undefined) {
    enforced.push(
      `knowledge_ids (${resolved.knowledgeFilterIds.length} live KCs) mode=${resolved.knowledgeFilterMode}`,
    );
  }
  if (scope.difficulty !== undefined) {
    enforced.push(
      scope.difficulty.basis === 'authored'
        ? `difficulty basis=authored range=[${scope.difficulty.range[0]}, ${scope.difficulty.range[1]}] (1-5 integer scale)`
        : `difficulty basis=calibrated range=[${scope.difficulty.range[0]}, ${scope.difficulty.range[1]}] (logit b; questions with unknown calibration are excluded, never mixed with authored difficulty)`,
    );
  }
  if (resolved.excludedQuestionIds !== undefined) {
    enforced.push(
      `exclude_refs (${resolved.excludedQuestionIds.length} question identities excluded across all revisions; learner-side supplied)`,
    );
  }
  if (scope.similar_to !== undefined) {
    enforced.push(
      unavailable.includes('vector')
        ? 'similar_to declared but the anchor content vector is unavailable (vector channel degraded to FTS-only)'
        : `similar_to=${scope.similar_to.question_ref} aspect=content (anchor's same-version content vector reused as the vector-channel query)`,
    );
  }
  enforced.push(`draft_state=${scope.draft_state}`);
  enforced.push(`admission_state=${scope.admission_state}`);
  enforced.push('top-level questions only (composite parts read via their group)');

  const verdict =
    confirmedPoolSize === 0 ? 'none' : confirmedPoolSize < limit ? 'sparse' : 'enough';
  const unsatisfied = {
    query: effectiveQuery,
    scope,
    requested_count: limit,
    retrieved_count: confirmedPoolSize,
    reason: 'insufficient_retrieved_candidates' as const,
  };
  const gapRequest =
    verdict === 'enough'
      ? null
      : BankGapRequestSchema.parse({
          target_contract: 'EvidenceDemandV1',
          status: 'needs_agent_context_and_filing_tool',
          claim: { kind: 'content_coverage', statement: effectiveQuery },
          inventory_goal: { eligible_count: limit },
          causes: [{ kind: 'coverage_gap' }],
          constraints: unsatisfied,
          required_context: [
            'demand_id',
            'policy_version',
            'subject_id',
            'claim.knowledge_ids',
            'evidence',
            'task',
            'difficulty',
            'inventory_goal.horizon_days',
            'control',
          ],
        });

  return {
    scope_applied: {
      subject:
        resolved.subjectKnowledgeIds !== undefined
          ? {
              profile: scope.subject as string,
              knowledge_id_count: resolved.subjectKnowledgeIds.length,
            }
          : undefined,
      kind:
        resolved.kindForms !== undefined
          ? { canonical: scope.kind as string, persisted_forms: resolved.kindForms }
          : undefined,
      source: scope.source,
      within_refs: scope.within_refs,
      knowledge:
        resolved.knowledgeFilterIds !== undefined
          ? {
              ids: resolved.knowledgeFilterIds,
              mode: resolved.knowledgeFilterMode,
              resolved_count: resolved.knowledgeFilterIds.length,
            }
          : undefined,
      difficulty:
        scope.difficulty !== undefined
          ? {
              basis: scope.difficulty.basis,
              range: scope.difficulty.range,
              scale: scope.difficulty.basis === 'authored' ? 'authored_1_5' : 'calibrated_logit_b',
            }
          : undefined,
      exclude_refs:
        resolved.excludedQuestionIds !== undefined
          ? {
              refs: scope.exclude_refs ?? [],
              excluded_question_ids: resolved.excludedQuestionIds.length,
            }
          : undefined,
      similar_to:
        scope.similar_to !== undefined
          ? {
              question_ref: scope.similar_to.question_ref,
              aspect: 'content',
              vector_available: !unavailable.includes('vector'),
            }
          : undefined,
      draft_state: scope.draft_state,
      admission_state: scope.admission_state,
    },
    requirements: {
      enforced,
      not_verified: [
        'query 语义相关性（排序依据，非逐项保证——候选不等于满足全部语义条件）',
        '未被本通道召回的题不构成「库中没有」',
        ...(scope.similar_to !== undefined && unavailable.includes('vector')
          ? [
              'similar_to 锚题暂无内容向量（未嵌入或被内容编辑失效，待 embed_backfill 回填）——向量通道不可用，本页仅 FTS 召回',
            ]
          : []),
      ],
    },
    hits: pageHits,
    coverage: {
      verdict,
      unsatisfied_constraints: verdict === 'enough' ? [] : [unsatisfied],
      gap_request: gapRequest,
      candidate_pool_size: confirmedPoolSize,
      retrieval_truncated: retrievalTruncated,
      page_has_more: hasMore,
      next_cursor: nextCursor,
      unavailable_channels: unavailable,
      complete: !hasMore && !retrievalTruncated && unavailable.length === 0,
    },
  };
}
