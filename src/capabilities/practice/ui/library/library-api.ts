// YUK-1473 — the 题目 library's reads and writes. Thin wrappers over the existing routes; pages
// call these through React Query and never build URLs themselves.

import { listMistakes } from '@/capabilities/ingestion/ui-public';
import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';
import { type QBankQuestion, type QuestionFullDetail, getQuestionsList } from '../practice-api';
import type { LibraryScope } from './library-url';

export {
  deleteQuestion,
  enableDraft,
  forceEnableDraft,
  getDraftDetail,
  getQuestionFull,
  getQuestionKnowledgeOptions,
  patchQuestion,
} from '../practice-api';
export type { QBankQuestion, QuestionFullDetail };

export const LIBRARY_PAGE = 30;

type ServingStatus = 'active' | 'not_servable';

export interface QuestionPage {
  items: QBankQuestion[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  byReason: Partial<Record<string, number>>;
}

export async function listQuestionPage(
  status: ServingStatus,
  scope: LibraryScope,
  offset: number,
): Promise<QuestionPage> {
  const result = await getQuestionsList({
    status,
    subject: scope.subject ?? undefined,
    knowledgeIds: scope.knowledgeId ? [scope.knowledgeId] : undefined,
    kind: scope.kind ?? undefined,
    source: scope.source ?? undefined,
    search: scope.search || undefined,
    // Held questions include drafts: a held draft still needs looking after.
    includeDrafts: status === 'not_servable',
    sortBy: 'created_at',
    sortDir: 'desc',
    limit: LIBRARY_PAGE,
    offset,
  });
  return {
    items: result.items,
    total: result.serving_counts?.not_servable_total ?? result.total,
    hasMore: result.page.has_more,
    nextOffset: offset + result.items.length,
    byReason: result.serving_counts?.by_reason ?? {},
  };
}

/** True totals for the view switch. 做错过 has none until the backend adds has_mistake. */
export async function countQuestions(status: ServingStatus): Promise<number> {
  const page = await getQuestionsList({
    status,
    includeDrafts: status === 'not_servable',
    limit: 1,
  });
  return page.serving_counts?.not_servable_total ?? page.total;
}

type DraftList = ApiOperationJsonResponse<'listReviewDrafts'>;
export type DraftRow = DraftList['rows'][number];

export async function listDraftPage(
  scope: LibraryScope,
  cursor: string | null,
): Promise<{ rows: DraftRow[]; total: number; nextCursor: string | null }> {
  const sp = new URLSearchParams({ limit: String(LIBRARY_PAGE) });
  if (scope.kind) sp.set('kind', scope.kind);
  if (scope.source) sp.set('source', scope.source);
  if (cursor) sp.set('cursor', cursor);
  const page = await apiOperationJson('listReviewDrafts', {
    url: `/api/review/drafts?${sp}`,
    method: 'GET',
  });
  return { rows: page.rows, total: page.total, nextCursor: page.next_cursor };
}

export async function countDrafts(): Promise<number> {
  const page = await apiOperationJson('listReviewDrafts', {
    url: '/api/review/drafts?limit=1',
    method: 'GET',
  });
  return page.total;
}

export const MISTAKE_PAGE = 50;

export function listMistakePage(scope: LibraryScope, cursor: string | null) {
  return listMistakes({
    limit: MISTAKE_PAGE,
    subject: scope.subject ?? undefined,
    cursor: cursor ?? undefined,
  });
}

export function listQuestionMistakes(questionId: string) {
  return listMistakes({ limit: MISTAKE_PAGE, questionId });
}

export type ServingAction = NonNullable<QuestionFullDetail['serving']['next_action']>;

export function runServingAction(action: ServingAction, idempotencyKey: string) {
  return apiOperationJson('runQuestionServingAction', {
    url: action.path,
    method: 'POST',
    init: { headers: { 'Idempotency-Key': idempotencyKey } },
  });
}

export function restoreQuestion(id: string, version: number) {
  return apiOperationJson('restoreQuestion', {
    url: `/api/questions/${encodeURIComponent(id)}/restore`,
    method: 'POST',
    body: { version },
  });
}

/** A deleted question is a draft carrying the archive mark (soft delete keeps every record). */
export function isDeleted(detail: Pick<QuestionFullDetail, 'metadata'>): boolean {
  return detail.metadata?.archived_at != null;
}

export function isDraft(detail: Pick<QuestionFullDetail, 'draft_status' | 'metadata'>): boolean {
  return detail.draft_status === 'draft' && !isDeleted(detail);
}

/** What the companion shows as 「正在看」: the knowledge points, else the start of the stem. */
export function focusTitle(detail: Pick<QuestionFullDetail, 'labels' | 'prompt_md'>): string {
  const names = detail.labels.map((l) => l.name).join('、');
  if (names) return names;
  const stem = detail.prompt_md.replace(/\s+/g, ' ').trim();
  return stem.length > 24 ? `${stem.slice(0, 24)}…` : stem || '这道题';
}
