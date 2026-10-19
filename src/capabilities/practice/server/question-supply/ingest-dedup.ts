// 入库查重（YUK-1552）。精确哈希与同知识点 n-gram 仍在调用方。
// 这里只补两件事：同一 http(s) 来源网址视为重复；跨知识点向量近重不拒收，
// 记一笔交给现有草稿待裁决（source_verify → needs_review）。

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { SYNTHETIC_SUBJECT_ROOT_RE } from '@/capabilities/practice/server/placement-scope';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { writeEvent } from '@/kernel/events';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { EMBED_DIMS } from '@/server/ai/embed';
import { enrollFsrsStateIfAbsent, initialSchedulingState } from '@/server/fsrs/state';

declare const HttpSourceRefBrand: unique symbol;

/** 规范化后的 http(s) 网址。只有 normalizeHttpSourceRef 能造出来。 */
export type HttpSourceRef = string & { readonly [HttpSourceRefBrand]: true };

/** 余弦相似度达到此值就送裁决，不自动拒。pgvector `<=>` 是距离，门槛 = 1 - 此值。 */
export const VECTOR_NEAR_DUP_MIN_SIMILARITY = 0.93;

const VECTOR_NEAR_DUP_MAX_DISTANCE = 1 - VECTOR_NEAR_DUP_MIN_SIMILARITY;

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

/**
 * http(s) 网址的同一性。
 * scheme 与 host 小写、去掉默认端口与 userinfo、去掉 fragment、
 * 非根路径去掉尾斜杠、丢掉跟踪参数、其余 query 按键和值排序。
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
  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
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

function visibleSourceRow() {
  return and(
    isNull(question.parent_question_id),
    sql`(${question.metadata} -> 'archived_at') IS NULL`,
    sql`(${question.metadata} -> 'dismissed_at') IS NULL`,
  );
}

export async function findSameHttpSource(
  db: Db | Tx,
  source: HttpSourceRef,
  excludeQuestionId?: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: question.id, sourceRef: question.source_ref })
    .from(question)
    .where(
      and(
        visibleSourceRow(),
        sql`${question.source_ref} IS NOT NULL`,
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
    if (normalizeHttpSourceRef(row.sourceRef) === source) return { id: row.id };
  }
  return null;
}

export async function findVectorNearDuplicate(
  db: Db | Tx,
  vector: number[],
  excludeQuestionId?: string,
): Promise<{ id: string; similarity: number } | null> {
  if (vector.length !== EMBED_DIMS) return null;
  const distance = sql<number>`${question.embedding} <=> ${toSqlVector(vector)}::vector`;
  const [row] = await db
    .select({ id: question.id, distance })
    .from(question)
    .where(
      and(
        visibleSourceRow(),
        sql`${question.embedding} IS NOT NULL`,
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

export async function mergeKnowledgeForSourceDuplicate(
  tx: Tx,
  params: {
    questionId: string;
    knowledgeIds: string[];
    actorRef: 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
  },
): Promise<{ addedKnowledgeIds: string[] }> {
  await acquireLearningStateWriteLock(tx);
  const [row] = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      knowledgeIds: question.knowledge_ids,
      version: question.version,
    })
    .from(question)
    .where(eq(question.id, params.questionId))
    .limit(1)
    .for('update');
  if (row == null) return { addedKnowledgeIds: [] };

  const requested = [
    ...new Set(params.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const liveRows =
    requested.length > 0
      ? await tx
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, requested), isNull(knowledge.archived_at)))
          .orderBy(knowledge.id)
          .for('update')
      : [];
  const live = new Set(liveRows.map((candidate) => candidate.id));
  const seen = new Set(row.knowledgeIds);
  const addedKnowledgeIds: string[] = [];
  for (const id of requested) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    addedKnowledgeIds.push(id);
  }
  if (addedKnowledgeIds.length === 0) return { addedKnowledgeIds };

  const knowledgeIds = [...row.knowledgeIds, ...addedKnowledgeIds];
  const nextVersion = row.version + 1;
  await tx
    .update(question)
    .set({ knowledge_ids: knowledgeIds, updated_at: params.now, version: nextVersion })
    .where(eq(question.id, row.id));

  const eventId = createId();
  const enrolledKnowledgeIds: string[] = [];
  if (row.draftStatus !== 'draft') {
    for (const knowledgeId of addedKnowledgeIds) {
      if (SYNTHETIC_SUBJECT_ROOT_RE.test(knowledgeId)) continue;
      const enrolled = await enrollFsrsStateIfAbsent(tx, {
        subject_kind: 'knowledge',
        subject_id: knowledgeId,
        ...initialSchedulingState(knowledgeId, params.now),
        last_review_event_id: eventId,
      });
      if (enrolled) enrolledKnowledgeIds.push(knowledgeId);
    }
  }
  await writeEvent(tx, {
    id: eventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: params.actorRef,
    action: QUESTION_EDIT_ACTION,
    subject_kind: 'question',
    subject_id: row.id,
    outcome: 'success',
    payload: {
      question_id: row.id,
      previous_version: row.version,
      next_version: nextVersion,
      before: { knowledge_ids: row.knowledgeIds },
      after: { knowledge_ids: knowledgeIds },
      reason: 'same_source_ref',
      added_knowledge_ids: addedKnowledgeIds,
      enrolled_knowledge_ids: enrolledKnowledgeIds,
      task_run_id: params.taskRunId ?? null,
      preserved_draft_status: row.draftStatus,
    },
    created_at: params.now,
  });
  return { addedKnowledgeIds };
}

/** 事务内锁住规范化网址，命中既有题就把知识点并进去。未命中返回 null。 */
export async function claimHttpSourceDuplicate(
  tx: Tx,
  params: {
    sourceUrl: string;
    knowledgeIds: string[];
    actorRef: 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
  },
): Promise<{ existingQuestionId: string; addedKnowledgeIds: string[] } | null> {
  const source = normalizeHttpSourceRef(params.sourceUrl);
  if (source == null) return null;
  await lockHttpSourceRef(tx, source);
  const hit = await findSameHttpSource(tx, source);
  if (hit == null) return null;
  const merged = await mergeKnowledgeForSourceDuplicate(tx, {
    questionId: hit.id,
    knowledgeIds: params.knowledgeIds,
    actorRef: params.actorRef,
    taskRunId: params.taskRunId,
    now: params.now,
  });
  return { existingQuestionId: hit.id, addedKnowledgeIds: merged.addedKnowledgeIds };
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
