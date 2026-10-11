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
import { type SQL, and, desc, eq, inArray, sql } from 'drizzle-orm';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import { deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { question, question_group_lifecycle, question_revision } from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { embedText } from '@/server/ai/embed';
import { canonicalKindToPersistedForms } from '@/subjects/question-kind';
import { encodeBankRef } from './bank-ref';

/** 每个召回通道的截断上限（OOM 保护；命中即 retrieval_truncated=true）。 */
export const BANK_SEARCH_CHANNEL_CAP = 200;

/** RRF 常数（标准 k=60；rank 从 1 计）。 */
export const BANK_SEARCH_RRF_K = 60;

export interface BankSearchScope {
  /** Subject profile id（如 'yuwen'）—— 服务端解析为 knowledge-id 集（模型无感）。 */
  subject?: string;
  /** 规范题型 label（choice/reading/…），展开到全部持久化同义形式。 */
  kind?: string;
  source?: string;
  /** 'all' | 'active' | 'draft'（默认 all：查重场景需要看见自己上一轮的 draft）。 */
  draft_state: 'all' | 'active' | 'draft';
  /** 'any' | 'admitted' | 'withheld'（默认 any）。admitted=自动可判且可服务。 */
  admission_state: 'any' | 'admitted' | 'withheld';
}

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
  source_tier: { tier: number; name: string };
  difficulty: number;
  knowledge_ids: string[];
  match_evidence: BankSearchMatchEvidence[];
  missing: string[];
}

export interface BankSearchCoverage {
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

interface BankSearchCursor {
  v: 1;
  q: string;
  scope: BankSearchScope;
  limit: number;
  offset: number;
  f: string;
}

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
  const c = parsed as Partial<BankSearchCursor>;
  if (
    c.v !== 1 ||
    typeof c.q !== 'string' ||
    c.q.length === 0 ||
    typeof c.scope !== 'object' ||
    c.scope === null ||
    typeof c.limit !== 'number' ||
    typeof c.offset !== 'number' ||
    c.offset < 0 ||
    typeof c.f !== 'string'
  ) {
    throw new Error('cursor is not a valid bank-search cursor');
  }
  if (c.f !== bankSearchFingerprint(c.q, c.scope, c.limit)) {
    throw new Error(
      'cursor fingerprint mismatch — start a new search instead of mixing a cursor with changed conditions',
    );
  }
  return c as BankSearchCursor;
}

// ── RRF 融合（纯函数，单测直接覆盖）───────────────────────────────────────

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
}

async function resolveScope(db: Db, scope: BankSearchScope): Promise<ResolvedScope> {
  const resolved: ResolvedScope = { scope };
  if (scope.subject !== undefined) {
    resolved.subjectKnowledgeIds = await resolveSubjectKnowledgeIds(db, scope.subject);
  }
  if (scope.kind !== undefined) {
    resolved.kindForms = canonicalKindToPersistedForms(scope.kind);
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
    filters.push(sql`(${question.draft_status} = 'draft')`);
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
  if (scope.source !== undefined) {
    filters.push(sql`(${question.source} = ${scope.source})`);
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
  let offset = 0;
  let limit: number;
  let scope: BankSearchScope;
  let effectiveQuery: string;
  if (request.form === 'cursor') {
    const c = decodeBankSearchCursor(request.cursor);
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
  const embedFn =
    deps.embedFn ??
    (async (text: string) =>
      embedText(text, {
        db,
        caller: 'api',
        deadlineAt: new Date(Date.now() + 20_000),
      }));
  const vectorPromise: Promise<{ vector: number[] | null; error?: string }> = embedFn(
    effectiveQuery,
  )
    .then((vector) => ({ vector }))
    .catch((err: unknown) => ({
      vector: null,
      error: err instanceof Error ? err.message : String(err),
    }));

  const [ftsAll, vectorResult] = await Promise.all([ftsRowsPromise, vectorPromise]);

  const ftsTruncated = ftsAll.length > BANK_SEARCH_CHANNEL_CAP;
  const ftsRows = ftsAll.slice(0, BANK_SEARCH_CHANNEL_CAP);
  const unavailable: BankSearchCoverage['unavailable_channels'] = [];

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
      .where(and(where, sql`${question.embedding} IS NOT NULL`))
      .orderBy(sql`${distanceExpr} ASC`)
      .limit(BANK_SEARCH_CHANNEL_CAP + 1);
    vectorTruncated = vecAll.length > BANK_SEARCH_CHANNEL_CAP;
    vectorRows = vecAll.slice(0, BANK_SEARCH_CHANNEL_CAP);
    channels.push({ name: 'vector', hits: vectorRows.map((r, i) => ({ id: r.id, rank: i })) });
  } else {
    unavailable.push('vector');
  }

  const retrievalTruncated = ftsTruncated || vectorTruncated;

  // ── RRF 融合 + 分页 ──
  const fused = rrfFuse(channels);
  const poolSize = fused.length;
  const page = fused.slice(offset, offset + limit);
  const hasMore = offset + page.length < poolSize;
  const nextCursor = hasMore
    ? encodeBankSearchCursor({ v: 1, q: effectiveQuery, scope, limit, offset: offset + limit })
    : null;

  // ── 卡片数据（page 量；批量无 N+1）──
  const pageIds = page.map((p) => p.id);
  const createdBy = new Map<string, Date>();
  for (const r of ftsRows) createdBy.set(r.id, r.created_at);
  for (const r of vectorRows) if (!createdBy.has(r.id)) createdBy.set(r.id, r.created_at);

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
      .where(inArray(question.id, pageIds));
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

    for (const fusedHit of page) {
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
        source_tier: { tier, name },
        difficulty: row.difficulty,
        knowledge_ids: row.knowledge_ids ?? [],
        match_evidence: evidence,
        missing,
      });
    }
  }

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
  enforced.push(`draft_state=${scope.draft_state}`);
  enforced.push(`admission_state=${scope.admission_state}`);
  enforced.push('top-level questions only (composite parts read via their group)');

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
      draft_state: scope.draft_state,
      admission_state: scope.admission_state,
    },
    requirements: {
      enforced,
      not_verified: [
        'query 语义相关性（排序依据，非逐项保证——候选不等于满足全部语义条件）',
        '未被本通道召回的题不构成「库中没有」',
      ],
    },
    hits,
    coverage: {
      candidate_pool_size: poolSize,
      retrieval_truncated: retrievalTruncated,
      page_has_more: hasMore,
      next_cursor: nextCursor,
      unavailable_channels: unavailable,
      complete: !hasMore && !retrievalTruncated && unavailable.length === 0,
    },
  };
}
