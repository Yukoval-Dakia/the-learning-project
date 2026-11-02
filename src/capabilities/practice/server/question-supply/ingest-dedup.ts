// 入库查重。精确哈希与同知识点 n-gram 仍在调用方。
// 网址不是题目身份。只有一页一题的来源（目前是菁优网题目详情页）才按规范化网址合并。
// 多题页面只走精确哈希和向量近重。向量近重不拒收，记一笔交给现有草稿待裁决。

import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { settleOneQuestionPageHit } from '@/capabilities/practice/server/quiz/content-fingerprint';
import type { Db, Tx } from '@/db/client';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import { question } from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { JYEOO_SOURCE_HOST } from './jyeoo-supply-config';

declare const HttpSourceRefBrand: unique symbol;

/** 规范化后的 http(s) 网址。只有 normalizeHttpSourceRef 能造出来。 */
export type HttpSourceRef = string & { readonly [HttpSourceRefBrand]: true };

/** 余弦相似度达到此值就送裁决，不自动拒。pgvector `<=>` 是距离，门槛 = 1 - 此值。 */
export const VECTOR_NEAR_DUP_MIN_SIMILARITY = 0.93;

const VECTOR_NEAR_DUP_MAX_DISTANCE = 1 - VECTOR_NEAR_DUP_MIN_SIMILARITY;

// question.embedding 是 vector(1024)，与 EMBED_DIMS 对齐。这里不 import embed 模块。
const QUESTION_EMBED_WIDTH = 1024;

export const VECTOR_NEAR_HOLD_KEY = 'vector_near_dup';

export interface VectorNearHold {
  neighbor_question_id: string;
  similarity: number;
}

const DROPPED_QUERY_KEYS = new Set([
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'dclid',
  'fbclid',
  'gbraid',
  'gclid',
  'gclsrc',
  'igsh',
  'igshid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'msclkid',
  'spm',
  'ttclid',
  'twclid',
  'wbraid',
  'yclid',
  'ysclid',
]);

function isTrackingParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith('utm_') || DROPPED_QUERY_KEYS.has(normalized);
}

function asHttpSourceRef(value: string): HttpSourceRef {
  return value as HttpSourceRef;
}

/** 百分号编码的十六进制大小写归一。WHATWG 保留路径里的原始大小写。 */
function uppercasePercentEncoding(value: string): string {
  return value.replace(/%[0-9a-fA-F]{2}/g, (hex) => hex.toUpperCase());
}

/**
 * http(s) 网址的同一性。
 * scheme 与 host 小写、去掉默认端口与 userinfo、去掉 fragment、
 * 非根路径去掉尾斜杠、路径里的百分号编码改为大写、丢掉跟踪参数、其余 query 按键和值排序。
 * 解析失败或不是 http(s) 时返回 null（不参与网址判重）。
 */
export function normalizeHttpSourceRef(raw: string): HttpSourceRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const pathname = uppercasePercentEncoding(
    url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname,
  );
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const query =
    params.length === 0
      ? ''
      : `?${params
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&')}`;
  const port = url.port === '' ? '' : `:${url.port}`;
  return asHttpSourceRef(`${url.protocol}//${url.hostname}${port}${pathname}${query}`);
}

const JYEOO_DETAIL_PATH = /^\/[^/]+\/ques\/detail\/([^/]+)$/;

/** 一页只对应一道题。目前只有菁优网 `/ques/detail/<id>`。多题页面造不出这个类型。 */
export interface OneQuestionPage {
  readonly kind: 'jyeoo_detail';
  readonly ref: HttpSourceRef;
  readonly detailId: string;
}

export function oneQuestionPage(raw: string): OneQuestionPage | null {
  const ref = normalizeHttpSourceRef(raw);
  if (ref == null) return null;
  const url = new URL(ref);
  if (url.hostname !== JYEOO_SOURCE_HOST) return null;
  const match = JYEOO_DETAIL_PATH.exec(url.pathname);
  if (match == null) return null;
  return { kind: 'jyeoo_detail', ref, detailId: match[1] };
}

function likeContains(fragment: string): string {
  return `%${fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function visibleSourceRow() {
  return and(
    isNull(question.parent_question_id),
    sql`(${question.metadata} -> 'archived_at') IS NULL`,
    sql`(${question.metadata} -> 'dismissed_at') IS NULL`,
  );
}

/** 近重 hold 的邻居。入库写入和 source_verify 重查用同一条可见性。 */
export async function visibleSourceNeighbor(db: Db | Tx, questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: question.id })
    .from(question)
    .where(and(eq(question.id, questionId), visibleSourceRow()))
    .limit(1);
  return row != null;
}

export async function findSameHttpSource(
  db: Db | Tx,
  page: OneQuestionPage,
  excludeQuestionId?: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: question.id, sourceRef: question.source_ref })
    .from(question)
    .where(
      and(
        visibleSourceRow(),
        sql`${question.source_ref} ILIKE ${likeContains(`/ques/detail/${page.detailId}`)} ESCAPE '\\'`,
        sql`(
          ${question.metadata}->>'source_ref_kind' = 'url'
          OR ${question.source_ref} ILIKE 'http%'
        )`,
        ...(excludeQuestionId != null ? [ne(question.id, excludeQuestionId)] : []),
      ),
    )
    .orderBy(asc(question.created_at), asc(question.id));
  for (const row of rows) {
    if (row.sourceRef == null) continue;
    if (oneQuestionPage(row.sourceRef)?.ref === page.ref) return { id: row.id };
  }
  return null;
}

export async function findVectorNearDuplicate(
  db: Db | Tx,
  vector: number[],
  excludeQuestionId?: string,
): Promise<{ id: string; similarity: number } | null> {
  if (vector.length !== QUESTION_EMBED_WIDTH) return null;
  const distance = sql<number>`${question.embedding} <=> ${toSqlVector(vector)}::vector`;
  const [row] = await db
    .select({ id: question.id, distance })
    .from(question)
    .where(
      and(
        visibleSourceRow(),
        sql`${question.embedding} IS NOT NULL`,
        // YUK-1603 — a revision-stale vector is not a near-dup witness for the
        // current content; the embed_backfill currency sweep re-stamps/re-embeds it.
        embedCurrencyPredicate(question),
        ...(excludeQuestionId != null ? [ne(question.id, excludeQuestionId)] : []),
      ),
    )
    .orderBy(sql`${distance} ASC`)
    .limit(1);
  if (row == null) return null;
  const cosineDistance = Number(row.distance);
  if (!Number.isFinite(cosineDistance) || cosineDistance > VECTOR_NEAR_DUP_MAX_DISTANCE) {
    return null;
  }
  return {
    id: row.id,
    similarity: Number((1 - cosineDistance).toFixed(6)),
  };
}

async function lockHttpSourceRef(tx: Tx, source: HttpSourceRef): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ingest-source:${source}`}))`);
}

/**
 * 只对一页一题的网址加锁并查重。多题页面返回 null。
 * onTerminal=defer 时终态草稿不合并、也不归档（预检）。
 * onTerminal=release 时在当前事务里放行终态草稿，调用方继续插入。
 */
export async function claimHttpSourceDuplicate(
  tx: Tx,
  params: {
    sourceUrl: string;
    knowledgeIds: string[];
    actorRef: 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
    onTerminal: 'defer' | 'release';
  },
): Promise<{ existingQuestionId: string; addedKnowledgeIds: string[] } | null> {
  const page = oneQuestionPage(params.sourceUrl);
  if (page == null) return null;
  await lockHttpSourceRef(tx, page.ref);
  const hit = await findSameHttpSource(tx, page);
  if (hit == null) return null;
  const settled = await settleOneQuestionPageHit(tx, {
    questionId: hit.id,
    knowledgeIds: params.knowledgeIds,
    actorRef: params.actorRef,
    taskRunId: params.taskRunId,
    now: params.now,
    onTerminal: params.onTerminal,
  });
  return settled === 'continue' ? null : settled;
}

export function vectorNearHoldMetadata(hit: {
  id: string;
  similarity: number;
}): Record<string, VectorNearHold> {
  return {
    [VECTOR_NEAR_HOLD_KEY]: {
      neighbor_question_id: hit.id,
      similarity: hit.similarity,
    },
  };
}

export function readVectorNearHold(metadata: Record<string, unknown>): VectorNearHold | null {
  const raw = metadata[VECTOR_NEAR_HOLD_KEY];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const neighbor = (raw as { neighbor_question_id?: unknown }).neighbor_question_id;
  const similarity = (raw as { similarity?: unknown }).similarity;
  if (typeof neighbor !== 'string' || neighbor.length === 0) return null;
  if (typeof similarity !== 'number' || !Number.isFinite(similarity)) return null;
  if (similarity + 1e-9 < VECTOR_NEAR_DUP_MIN_SIMILARITY) return null;
  return { neighbor_question_id: neighbor, similarity };
}
