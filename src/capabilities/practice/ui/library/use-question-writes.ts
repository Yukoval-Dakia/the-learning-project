// YUK-1473 — every write the 题目 library makes, as React Query mutations. Each success refreshes
// the library lists and the question's own reads; each failure becomes one plain sentence.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/ui/lib/api';
import { showToast } from '@/ui-next/feedback/toast-store';
import { type QuestionPatchBody, enableDraft, forceEnableDraft } from '../practice-api';
import type { ServingAction } from './library-api';
import { type LibraryClient, useLibraryClient } from './library-client';
import { LIBRARY_KEY } from './use-library';

export const questionKey = (id: string) => [LIBRARY_KEY, 'question', id] as const;

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [LIBRARY_KEY] });
}

export function writeErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'unchanged_base_already_verified')
      return '题目没有改动，再核验一次结果也一样。先改题再核验。';
    if (err.code === 'owner_hold') return '这道题是你自己停出的，不需要核验。';
    if (err.code === 'immutable_question') return '这是系统用来了解你的诊断题，不能在这里改动。';
    if (err.status === 409) return '这道题刚刚在别处有了变化，已经刷新，请再看一眼。';
    if (err.status === 404) return '找不到这道题了。';
  }
  if (err instanceof TypeError) return '网络断了，没能确认结果。刷新后再试一次。';
  return '没有成功，请稍后再试。';
}

/** Run the one release action the server offers (same idempotency key on network retries). */
export function useServingAction() {
  const { runServingAction } = useLibraryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ action, key }: { action: ServingAction; key: string }) =>
      runServingAction(action, key),
    retry: (count, err) => err instanceof TypeError && count < 2,
    onSuccess: (result) => {
      void refresh();
      showToast({
        message: result.accepted ? '已提交，排队处理中' : '这道题现在不需要这个操作，已刷新状态',
      });
    },
    onError: (err) => {
      void refresh();
      showToast({ message: writeErrorText(err) });
    },
  });
}

/** 核验并启用: the server runs the check and turns the draft on only if it passes. */
export function useVerifyDraft() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => enableDraft(id),
    onSettled: () => void refresh(),
  });
}

export function useForceEnable() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => forceEnableDraft(id, reason),
    onSettled: () => void refresh(),
  });
}

export function useSaveQuestion(id: string) {
  const { patchQuestion } = useLibraryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (body: QuestionPatchBody) => patchQuestion(id, body),
    onSettled: () => void refresh(),
  });
}

/** First step of delete: what the question is tied to (nothing is written). */
export function useDeletePreview(id: string) {
  const { deleteQuestion } = useLibraryClient();
  return useMutation({
    mutationFn: (fallbackChildren: number) => deleteQuestion(id, { fallbackChildren }),
  });
}

/**
 * Restore failures: a live question already holding the same content is its own sentence (the
 * route sends it as a 409 'conflict' whose message names the content claim).
 */
export function restoreErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 409 && err.message.includes('same content claim'))
    return '没能恢复：题库里已经有一道内容相同的题在用。要恢复这道，先处理那道题。';
  if (err instanceof ApiError && err.status === 409 && err.message.includes('not archived'))
    return '这道题已经不在删除状态了。';
  return writeErrorText(err);
}

async function restoreLatest(
  id: string,
  getQuestionFull: LibraryClient['getQuestionFull'],
  restoreQuestion: LibraryClient['restoreQuestion'],
) {
  const fresh = await getQuestionFull(id);
  return restoreQuestion(id, fresh.version);
}

export function useRestore(id: string) {
  const { getQuestionFull, restoreQuestion } = useLibraryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => restoreLatest(id, getQuestionFull, restoreQuestion),
    onSuccess: () => showToast({ message: '已恢复，题目回到待审核' }),
    onError: (err) => showToast({ message: restoreErrorText(err) }),
    onSettled: () => void refresh(),
  });
}

/** Delete, then offer 撤销 for the toast's lifetime (restore works later too). */
export function useDelete(id: string) {
  const { getQuestionFull, restoreQuestion, deleteQuestion } = useLibraryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (input: { version: number; children: number }) =>
      deleteQuestion(id, {
        confirm: true,
        confirmChildren: input.children > 0,
        version: input.version,
        fallbackChildren: input.children,
      }),
    onSuccess: () => {
      showToast({
        message: '已删除。作答和错题记录都还在。',
        action: {
          label: '撤销',
          run: () => {
            void restoreLatest(id, getQuestionFull, restoreQuestion)
              .then(() => showToast({ message: '已恢复，题目回到待审核' }))
              .catch((err: unknown) => showToast({ message: restoreErrorText(err) }))
              .finally(() => void refresh());
          },
        },
      });
    },
    onSettled: () => void refresh(),
  });
}
