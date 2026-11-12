// 科目经验文档库的只读投影：subject_doc 的目录、点查与搜索。
//
// 共享层：subject_id = 'general' 的文档对所有科目开放；读侧先查本科目，
// miss 回落 general（目录里分两段呈现，点查透明回落，本科目同键优先）。
// 目录路径（进任务提示词）吞错返回空目录——文档库缺席不阻塞任务；点查与
// 搜索让错误冒泡，调用方（工具/任务）拿到真实失败而不是「没有文档」的假象。

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { subject_doc } from '@/db/schema';

export const GENERAL_DOC_SUBJECT = 'general';

const SEARCH_LIMIT = 10;
const EXCERPT_RADIUS = 80;

export interface SubjectDocEntry {
  subject_id: string;
  doc_key: string;
  title: string;
  summary: string;
}

export interface SubjectDoc extends SubjectDocEntry {
  body: string;
  revision: number;
}

export interface SubjectDocCatalog {
  /** 解析后的科目 id（输入经注册表/原文回退）。 */
  subject_id: string;
  own: SubjectDocEntry[];
  /** general 共享层；subject 自身即 general 时为空。 */
  shared: SubjectDocEntry[];
}

export interface SubjectDocSearchHit extends SubjectDocEntry {
  shared: boolean;
  excerpt: string;
}

const ENTRY_COLS = {
  subject_id: subject_doc.subject_id,
  doc_key: subject_doc.doc_key,
  title: subject_doc.title,
  summary: subject_doc.summary,
} as const;

export async function listSubjectDocCatalog(db: Db, subjectId: string): Promise<SubjectDocCatalog> {
  const scope = subjectId === GENERAL_DOC_SUBJECT ? [subjectId] : [subjectId, GENERAL_DOC_SUBJECT];
  try {
    const rows = await db
      .select(ENTRY_COLS)
      .from(subject_doc)
      .where(inArray(subject_doc.subject_id, scope))
      .orderBy(asc(subject_doc.subject_id), asc(subject_doc.doc_key));
    const own = rows.filter((r) => r.subject_id === subjectId);
    const ownKeys = new Set(own.map((r) => r.doc_key));
    const shared = rows.filter(
      (r) => r.subject_id === GENERAL_DOC_SUBJECT && !ownKeys.has(r.doc_key),
    );
    return { subject_id: subjectId, own, shared: subjectId === GENERAL_DOC_SUBJECT ? [] : shared };
  } catch (error) {
    console.warn('[subject-docs] catalog read degraded to empty:', error);
    return { subject_id: subjectId, own: [], shared: [] };
  }
}

export async function readSubjectDoc(
  db: Db,
  subjectId: string,
  docKey: string,
): Promise<SubjectDoc | undefined> {
  const scope = subjectId === GENERAL_DOC_SUBJECT ? [subjectId] : [subjectId, GENERAL_DOC_SUBJECT];
  const rows = await db
    .select({ ...ENTRY_COLS, body: subject_doc.body, revision: subject_doc.revision })
    .from(subject_doc)
    .where(and(eq(subject_doc.doc_key, docKey), inArray(subject_doc.subject_id, scope)))
    .orderBy(asc(subject_doc.subject_id));
  // 本科目命中优先；同键的 general 行只在本科目缺席时顶上。
  return rows.find((r) => r.subject_id === subjectId) ?? rows[0];
}

export async function searchSubjectDocs(
  db: Db,
  subjectId: string,
  query: string,
): Promise<SubjectDocSearchHit[]> {
  const scope = subjectId === GENERAL_DOC_SUBJECT ? [subjectId] : [subjectId, GENERAL_DOC_SUBJECT];
  const rows = await db
    .select({ ...ENTRY_COLS, body: subject_doc.body })
    .from(subject_doc)
    .where(inArray(subject_doc.subject_id, scope))
    .orderBy(asc(subject_doc.subject_id), asc(subject_doc.doc_key));
  // Resolve subject-over-general precedence before matching and applying the result
  // limit. This prevents a matching general row from hiding a more-specific
  // subject override whose body does not contain the query.
  const effectiveByKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.subject_id === subjectId) effectiveByKey.set(row.doc_key, row);
  }
  for (const row of rows) {
    if (row.subject_id === GENERAL_DOC_SUBJECT && !effectiveByKey.has(row.doc_key)) {
      effectiveByKey.set(row.doc_key, row);
    }
  }
  const needle = query.toLowerCase();
  return [...effectiveByKey.values()]
    .filter((r) => `${r.title}\n${r.summary}\n${r.body}`.toLowerCase().includes(needle))
    .map((r) => {
      const haystack = `${r.title}\n${r.summary}\n${r.body}`;
      const at = haystack.toLowerCase().indexOf(needle);
      const excerpt =
        at < 0
          ? haystack.slice(0, EXCERPT_RADIUS * 2)
          : haystack.slice(Math.max(0, at - EXCERPT_RADIUS), at + EXCERPT_RADIUS);
      return {
        subject_id: r.subject_id,
        doc_key: r.doc_key,
        title: r.title,
        summary: r.summary,
        shared: r.subject_id === GENERAL_DOC_SUBJECT && r.subject_id !== subjectId,
        excerpt,
      };
    })
    .slice(0, SEARCH_LIMIT);
}

/**
 * 目录 → piSkillDocs 注入体的便捷入口：任务启动只带目录，正文留给
 * read_subject_doc 按需读。空目录返回 undefined（不注入死名）。
 */
export async function subjectDocCatalogPiSkillDoc(
  db: Db,
  subjectId: string,
): Promise<{ name: string; body: string }[] | undefined> {
  const body = renderSubjectDocCatalog(await listSubjectDocCatalog(db, subjectId));
  return body ? [{ name: 'subject-docs', body }] : undefined;
}

/**
 * 目录的提示词块：piSkillDocs 的注入体。只放键+标题+一句话用途，不放正文。
 * 空目录返回空串，调用方应跳过注入。
 */
export function renderSubjectDocCatalog(catalog: SubjectDocCatalog): string {
  if (catalog.own.length === 0 && catalog.shared.length === 0) return '';
  const header = `本科目经验文档库（用工具 read_subject_doc 按需读正文，subject_id 传「${catalog.subject_id}」；下列 key 是 doc_key 参数取值）：`;
  const lines: string[] = [header];
  if (catalog.own.length > 0) {
    lines.push('', '本科目：');
    for (const doc of catalog.own) {
      lines.push(`- ${doc.doc_key} — ${doc.title}：${doc.summary}`);
    }
  }
  if (catalog.shared.length > 0) {
    lines.push('', '通用（所有科目共享）：');
    for (const doc of catalog.shared) {
      lines.push(`- ${doc.doc_key} — ${doc.title}：${doc.summary}`);
    }
  }
  return lines.join('\n');
}
