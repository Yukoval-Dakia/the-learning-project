// Which question images a learner may see. A photographed source page is a whole
// sheet: it carries other questions and their handwriting, so it is prompt material
// for vision models only. The judgement is made at read time from the question's own
// source document (its `source_asset_ids` are the uploaded pages), so rows written
// before this rule — and manual imports — take the same path with no data backfill.

import { inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';

/** Question sources that come from a photographed/uploaded page. */
export const INGESTION_QUESTION_SOURCES: ReadonlySet<string> = new Set([
  'ingestion',
  'vision_paper',
  'vision_single',
  'camera',
  'import',
  'pdf',
  'docx',
  'photo',
  'reverse_mark',
]);

export interface LearnerImagePageIndex {
  /** Whole-page asset ids per source document id. */
  pageAssetsByDocument: Map<string, Set<string>>;
  /** Document id per ingestion session id, for questions missing the document id. */
  documentIdBySession: Map<string, string>;
}

export interface LearnerImageQuestion {
  image_refs?: readonly string[] | null;
  metadata?: unknown;
  /** question.source; ingestion sources fail closed when the page identity is unknown. */
  source?: string | null;
}

function metadataOf(metadata: unknown): Record<string, unknown> | null {
  return metadata != null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Batch-loads the page identity needed by `learnerVisibleImageRefs`. Only documents
 * that exist are indexed; an id absent from `pageAssetsByDocument` is an unknown.
 */
export async function loadLearnerImagePageIndex(
  db: Db | Tx,
  questions: readonly { metadata?: unknown }[],
): Promise<LearnerImagePageIndex> {
  const documentIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const q of questions) {
    const meta = metadataOf(q.metadata);
    if (!meta) continue;
    const docId = stringOf(meta.source_document_id);
    if (docId) documentIds.add(docId);
    const sessionId = stringOf(meta.ingestion_session_id);
    if (sessionId) sessionIds.add(sessionId);
  }

  const documentIdBySession = new Map<string, string>();
  if (sessionIds.size > 0) {
    const rows = await db
      .select({ id: learning_session.id, sourceDocumentId: learning_session.source_document_id })
      .from(learning_session)
      .where(inArray(learning_session.id, [...sessionIds]));
    for (const row of rows) {
      if (row.sourceDocumentId) {
        documentIdBySession.set(row.id, row.sourceDocumentId);
        documentIds.add(row.sourceDocumentId);
      }
    }
  }

  const pageAssetsByDocument = new Map<string, Set<string>>();
  if (documentIds.size > 0) {
    const rows = await db
      .select({
        id: source_document.id,
        sourceAssetIds: source_document.source_asset_ids,
      })
      .from(source_document)
      .where(inArray(source_document.id, [...documentIds]));
    for (const row of rows) {
      pageAssetsByDocument.set(row.id, new Set(row.sourceAssetIds ?? []));
    }
  }
  return { pageAssetsByDocument, documentIdBySession };
}

/**
 * Tries metadata.source_document_id first, then the ingestion session's document. A
 * stale/unresolvable id never masks the fallback. Returns null when neither resolves to
 * an existing document.
 */
function resolvePageAssets(
  q: LearnerImageQuestion,
  index: LearnerImagePageIndex,
): Set<string> | null {
  const meta = metadataOf(q.metadata);
  const documentCandidates = [
    stringOf(meta?.source_document_id),
    stringOf(meta?.ingestion_session_id)
      ? (index.documentIdBySession.get(stringOf(meta?.ingestion_session_id) as string) ?? null)
      : null,
  ];
  for (const documentId of documentCandidates) {
    if (!documentId) continue;
    const pages = index.pageAssetsByDocument.get(documentId);
    if (pages !== undefined) return pages;
  }
  return null;
}

/**
 * `image_refs` minus whole source pages; verified figure crops are unaffected.
 *
 * When the page identity cannot be resolved, ingestion-sourced questions fail closed
 * (no `image_refs`; `figures` remain), because a whole photographed page may carry other
 * learners' questions/handwriting. Non-ingestion questions keep their refs unchanged.
 */
export function learnerVisibleImageRefs(
  q: LearnerImageQuestion,
  index: LearnerImagePageIndex,
): string[] {
  const refs = [...(q.image_refs ?? [])];
  const pages = resolvePageAssets(q, index);
  if (pages === null) {
    return q.source != null && INGESTION_QUESTION_SOURCES.has(q.source) ? [] : refs;
  }
  if (pages.size === 0) return refs;
  return refs.filter((ref) => !pages.has(ref));
}
