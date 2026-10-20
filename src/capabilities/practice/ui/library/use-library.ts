// YUK-1473 — React Query reads for the 题目 library. Query keys share the 'questions-lib' prefix
// so any write can refresh the whole library in one invalidation.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { listSubjectChoices } from '@/ui/lib/subject';
import {
  countDrafts,
  countQuestions,
  getQuestionKnowledgeOptions,
  listDraftPage,
  listMistakePage,
  listQuestionPage,
} from './library-api';
import type { LibraryScope } from './library-url';
import { groupMistakes } from './mistake-read';

export const LIBRARY_KEY = 'questions-lib';

export function useViewCounts() {
  const all = useQuery({
    queryKey: [LIBRARY_KEY, 'count', 'all'],
    queryFn: () => countQuestions('active'),
  });
  const review = useQuery({ queryKey: [LIBRARY_KEY, 'count', 'review'], queryFn: countDrafts });
  const held = useQuery({
    queryKey: [LIBRARY_KEY, 'count', 'held'],
    queryFn: () => countQuestions('not_servable'),
  });
  return { all: all.data, review: review.data, held: held.data };
}

export function useQuestionPages(status: 'active' | 'not_servable', scope: LibraryScope) {
  return useInfiniteQuery({
    queryKey: [LIBRARY_KEY, 'list', status, scope],
    queryFn: ({ pageParam }) => listQuestionPage(status, scope, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore ? last.nextOffset : undefined),
  });
}

export function useDraftPages(scope: LibraryScope) {
  const query = useInfiniteQuery({
    queryKey: [LIBRARY_KEY, 'drafts', scope.kind, scope.source],
    queryFn: ({ pageParam }) => listDraftPage(scope, pageParam),
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
  const query = useInfiniteQuery({
    queryKey: [LIBRARY_KEY, 'mistakes', scope.subject],
    queryFn: ({ pageParam }) => listMistakePage(scope, pageParam),
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

export interface LibraryLookups {
  knowledgeName: (id: string) => string | null;
  knowledgeOptions: ReadonlyArray<{ id: string; name: string }>;
  subjectOptions: ReadonlyArray<{ id: string; label: string }>;
  causeLabel: (category: string) => string;
}

export function useLookups(): LibraryLookups {
  const knowledge = useQuery({
    queryKey: [LIBRARY_KEY, 'knowledge'],
    queryFn: getQuestionKnowledgeOptions,
    staleTime: 5 * 60_000,
  });
  const { subjects } = useSubjects();
  const rows = (knowledge.data?.rows ?? []) as ReadonlyArray<{
    id: string;
    name: string;
    archived_at?: string | null;
  }>;
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const causes = new Map<string, string>();
  for (const subject of subjects) {
    for (const cause of subject.causeCategories) causes.set(cause.id, cause.label);
  }
  return {
    knowledgeName: (id) => names.get(id) ?? null,
    knowledgeOptions: rows
      .filter((row) => !row.archived_at)
      .map((row) => ({ id: row.id, name: row.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    subjectOptions: listSubjectChoices(subjects).filter(
      (choice) => choice.configurationStatus !== 'unconfigured',
    ),
    causeLabel: (category) => causes.get(category) ?? '其他原因',
  };
}
