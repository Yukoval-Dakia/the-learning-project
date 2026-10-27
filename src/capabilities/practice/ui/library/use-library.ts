// YUK-1473 — React Query reads for the 题目 library. Query keys share the 'questions-lib' prefix
// so any write can refresh the whole library in one invalidation.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSubjects } from '@/ui/hooks/useSubjects';
import {
  listSubjectChoices,
  resolveSubjectRenderModelForDomain,
  subjectDisplayName,
  subjectIdentityKey,
} from '@/ui/lib/subject';
import {
  countDrafts,
  countQuestions,
  listDraftPage,
  listMistakePage,
  listQuestionPage,
} from './library-api';
import { useLibraryClient } from './library-client';
import type { LibraryScope } from './library-url';
import { groupMistakes } from './mistake-read';

export const LIBRARY_KEY = 'questions-lib';

export function useViewCounts() {
  const { getQuestionsList, getReviewDrafts } = useLibraryClient();
  const all = useQuery({
    queryKey: [LIBRARY_KEY, 'count', 'all'],
    queryFn: () => countQuestions('active', getQuestionsList),
  });
  const review = useQuery({
    queryKey: [LIBRARY_KEY, 'count', 'review'],
    queryFn: () => countDrafts(getReviewDrafts),
  });
  const held = useQuery({
    queryKey: [LIBRARY_KEY, 'count', 'held'],
    queryFn: () => countQuestions('not_servable', getQuestionsList),
  });
  return { all: all.data, review: review.data, held: held.data };
}

export function useQuestionPages(status: 'active' | 'not_servable', scope: LibraryScope) {
  const { getQuestionsList } = useLibraryClient();
  return useInfiniteQuery({
    queryKey: [LIBRARY_KEY, 'list', status, scope],
    queryFn: ({ pageParam }) => listQuestionPage(status, scope, pageParam, getQuestionsList),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
  });
}

export function useDraftPages(scope: LibraryScope) {
  const { getReviewDrafts } = useLibraryClient();
  const query = useInfiniteQuery({
    queryKey: [LIBRARY_KEY, 'drafts', scope.kind, scope.source],
    queryFn: ({ pageParam }) => listDraftPage(scope, pageParam, getReviewDrafts),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const needle = scope.search.trim().toLowerCase();
  const rows = (query.data?.pages ?? [])
    .flatMap((page) => page.rows)
    .filter(
      (row) =>
        (!scope.knowledgeId || row.knowledge.some((k) => k.id === scope.knowledgeId)) &&
        (!needle || row.prompt_preview.toLowerCase().includes(needle)),
    );
  return { query, rows, total: query.data?.pages[0]?.total };
}

/** Partial read: questions grouped from the mistake pages loaded so far. */
export function useMistakeQuestions(scope: LibraryScope) {
  const { listMistakes } = useLibraryClient();
  const query = useInfiniteQuery({
    queryKey: [LIBRARY_KEY, 'mistakes', scope.subject],
    queryFn: ({ pageParam }) => listMistakePage(scope, pageParam, listMistakes),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const needle = scope.search.trim().toLowerCase();
  const groups = groupMistakes((query.data?.pages ?? []).flatMap((page) => page.rows)).filter(
    (group) =>
      (!scope.knowledgeId || group.knowledgeIds.includes(scope.knowledgeId)) &&
      (!needle || group.promptMd.toLowerCase().includes(needle)),
  );
  return { query, groups };
}

export interface KnowledgeOption {
  id: string;
  name: string;
  /** The name, plus the subject (and if needed the parent) when another point shares it. */
  label: string;
}

export interface LibraryLookups {
  knowledgeName: (id: string) => string | null;
  knowledgeOptions: ReadonlyArray<KnowledgeOption>;
  subjectOptions: ReadonlyArray<{ id: string; label: string }>;
  causeLabel: (category: string) => string;
  /** Math notation for content filed under these knowledge points (via their subject). */
  notationFor: (knowledgeIds: readonly string[]) => string | null;
}

interface KnowledgeRow {
  id: string;
  name: string;
  archived_at?: string | null;
  domain?: string | null;
  effective_domain?: string | null;
  parent_id?: string | null;
}

/** Tell same-named points apart: first by subject, then by the parent they sit under. */
function labelOptions(
  rows: readonly KnowledgeRow[],
  names: ReadonlyMap<string, string>,
  subjectOf: (row: KnowledgeRow) => string | null,
): KnowledgeOption[] {
  const count = (keys: readonly string[]) => {
    const seen = new Map<string, number>();
    for (const key of keys) seen.set(key, (seen.get(key) ?? 0) + 1);
    return seen;
  };
  const byName = count(rows.map((r) => r.name));
  const first = rows.map((row) => {
    if ((byName.get(row.name) ?? 0) < 2) return row.name;
    const subject = subjectOf(row);
    return subject ? `${row.name} · ${subject}` : row.name;
  });
  const byFirst = count(first);
  const second = rows.map((row, i) => {
    const label = first[i] ?? row.name;
    if ((byFirst.get(label) ?? 0) < 2) return label;
    const parent = row.parent_id ? names.get(row.parent_id) : null;
    return parent ? `${label}（在「${parent}」下）` : label;
  });
  const bySecond = count(second);
  const nth = new Map<string, number>();
  return rows.map((row, i) => {
    const label = second[i] ?? row.name;
    if ((bySecond.get(label) ?? 0) < 2) return { id: row.id, name: row.name, label };
    const n = (nth.get(label) ?? 0) + 1;
    nth.set(label, n);
    return { id: row.id, name: row.name, label: `${label}（第 ${n} 个）` };
  });
}

export function useLookups(): LibraryLookups {
  const { getQuestionKnowledgeOptions } = useLibraryClient();
  const knowledge = useQuery({
    queryKey: [LIBRARY_KEY, 'knowledge'],
    queryFn: getQuestionKnowledgeOptions,
    staleTime: 5 * 60_000,
  });
  const { subjects } = useSubjects();
  const rows = (knowledge.data?.rows ?? []) as ReadonlyArray<KnowledgeRow>;
  const domainOf = (row: KnowledgeRow | undefined) => row?.effective_domain ?? row?.domain ?? null;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const causes = new Map<string, string>();
  for (const subject of subjects) {
    for (const cause of subject.causeCategories ?? []) causes.set(cause.id, cause.label);
  }
  const live = rows
    .filter((row) => !row.archived_at)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return {
    knowledgeName: (id) => names.get(id) ?? null,
    knowledgeOptions: labelOptions(live, names, (row) => {
      const domain = domainOf(row);
      return domain ? subjectDisplayName(domain, subjects) : null;
    }),
    subjectOptions: listSubjectChoices(subjects).filter(
      (choice) => choice.configurationStatus !== 'unconfigured',
    ),
    causeLabel: (category) => causes.get(category) ?? '其他原因',
    // Same rule as the server's list notation: the first knowledge point's subject, falling back
    // to the registry (built-in subjects, default profile) when no subject row matches.
    notationFor: (knowledgeIds) => {
      const domain = domainOf(byId.get(knowledgeIds[0] ?? ''));
      const key = subjectIdentityKey(domain, subjects);
      const subject = key ? subjects.find((row) => row.id === key) : undefined;
      if (subject) return subject.renderConfig?.notation ?? null;
      return resolveSubjectRenderModelForDomain(domain).renderConfig.notation ?? null;
    },
  };
}
