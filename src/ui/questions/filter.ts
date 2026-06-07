// YUK-288 题库 UI — client-side filter logic for the two API gaps the S1 reader
// does NOT cover server-side (plan §3):
//
//   gap C — 题面文本搜索: list reader has no full-text axis; S1 does a client-side
//           substring match over the already-fetched page (百到千级, SPEC量级内).
//           Follow-up: a server-side ILIKE/tsvector axis (Linear gate).
//   gap D — 草稿-only tab: list reader only has includeDrafts:boolean, no
//           "drafts only" axis; the 草稿 tab fetches with include_drafts then
//           filters draft_status==='draft' on the client.
//
// Pure functions, no React — unit-testable in the src/ui/** fast partition.

import type { QuestionListItem } from './types';

export type StatusTab = 'all' | 'active' | 'draft';

/** A row is a draft iff draft_status === 'draft' (mirrors the list reader's 排除惯例). */
export function isDraft(item: QuestionListItem): boolean {
  return item.draft_status === 'draft';
}

/**
 * 草稿/正式/全部 tab → row predicate (gap D, client-side).
 *   all    → every row (the query already used include_drafts=true).
 *   active → non-draft rows.
 *   draft  → draft rows only.
 */
export function matchStatusTab(item: QuestionListItem, tab: StatusTab): boolean {
  if (tab === 'all') return true;
  if (tab === 'draft') return isDraft(item);
  return !isDraft(item); // 'active'
}

// Strip light markdown / latex punctuation so a search for 「之」 matches a stem
// written as `「**之**」` — mirrors the design mock's `plain()` helper.
function plain(s: string): string {
  return (s ?? '').replace(/[*`$＿_]/g, '');
}

/**
 * 题面文本搜索 (gap C, client-side substring). Matches a row when the trimmed,
 * lower-cased query is a substring of any of: the (markdown-stripped) prompt
 * preview, the question id, or any knowledge-id / knowledge-name token. An empty
 * query matches everything. `labelFor` resolves a knowledge id → its display name
 * when known (so a search on 「判断句」 hits a row labelled by that node).
 */
export function matchQuery(
  item: QuestionListItem,
  query: string,
  labelFor: (knowledgeId: string) => string = (id) => id,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    plain(item.prompt_md),
    item.id,
    ...item.knowledge_ids,
    ...item.knowledge_ids.map(labelFor),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export type SortKey = 'time' | 'difficulty';
export type SortDir = 'asc' | 'desc';

/**
 * Client-side sort over the fetched page (the server's default order is
 * newest-first; the list-level 时间/难度 + 升/降 toggle re-sorts in place). Stable
 * w.r.t. the server order within equal keys.
 */
export function sortItems(
  items: QuestionListItem[],
  key: SortKey,
  dir: SortDir,
): QuestionListItem[] {
  const sorted = [...items].sort((a, b) => {
    const v =
      key === 'difficulty' ? a.difficulty - b.difficulty : a.created_at_sec - b.created_at_sec;
    return dir === 'asc' ? v : -v;
  });
  return sorted;
}
