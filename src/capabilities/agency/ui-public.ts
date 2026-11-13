// Client-only contributions and the learner plan edit/recovery operation.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createElement, useRef, useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { invalidateAfterLearningItemPlan, queryKeys } from '@/ui/lib/write-invalidation';
import { LearningItemPlanList } from '@/ui-next/today/LearningItemPlanList';
import {
  type LearningItemPlan,
  type LearningItemPlanClient,
  type LearningItemPlanPage,
  type LearningItemPlanPatch,
  learningItemPlanClient,
} from './ui/learning-item-plan-api';

function calendarDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function localDayEnd(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效的日期。');
  const [year, month, day] = value.split('-').map(Number);
  // The current PG timestamp reader remaps years 1–99; do not silently save a different year.
  if (year !== undefined && year < 100) throw new Error('请选择公元 100 年及以后的日期。');
  if (!year || !month || !day || value > '9999-12-30') throw new Error('请选择有效的日期。');
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (calendarDate(date) !== value) throw new Error('这个日期在本机时区不存在。');
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  date.setTime(date.getTime() - 1);
  if (calendarDate(date) !== value) throw new Error('这个日期在本机时区不存在。');
  return date.toISOString();
}
interface Draft {
  base: LearningItemPlan;
  pinned: boolean;
  date: string;
}
function changedFields(draft: Draft): LearningItemPlanPatch {
  const patch: LearningItemPlanPatch = {};
  if (draft.pinned !== draft.base.user_pinned) patch.user_pinned = draft.pinned;
  const originalDate = draft.base.due_at ? calendarDate(new Date(draft.base.due_at)) : '';
  if (draft.date !== originalDate) patch.due_at = draft.date ? localDayEnd(draft.date) : null;
  return patch;
}
export function LearningItemPlanSection({
  navigate,
  client = learningItemPlanClient,
}: {
  navigate: (to: string) => void;
  client?: LearningItemPlanClient;
}) {
  const qc = useQueryClient();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<LearningItemPlanPatch | null>(null);
  const [blocked, setBlocked] = useState(false);
  const sending = useRef(false);
  const cursor = cursors.at(-1);
  const key = [...queryKeys.learningItemPlans, cursor ?? null];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.list(cursor, signal),
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  const mutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: LearningItemPlanPatch }) =>
      client.patch(id, patch),
    retry: false,
  });
  const dirty =
    draft !== null &&
    (draft.pinned !== draft.base.user_pinned ||
      draft.date !== (draft.base.due_at ? calendarDate(new Date(draft.base.due_at)) : ''));
  const current = query.data?.items.find((item) => item.id === draft?.base.id);
  const available = !query.isSuccess || current !== undefined;
  const leaveEditor = () => {
    if (sending.current || unknown !== null) return false;
    if (dirty) {
      setNotice('有未保存的修改，请先保存或取消。');
      return false;
    }
    setDraft(null);
    setError(null);
    setBlocked(false);
    return true;
  };
  const reconcile = async (pending: LearningItemPlanPatch) => {
    if (!draft || sending.current) return;
    try {
      const result = await query.refetch({ throwOnError: true });
      const row = result.data?.items.find((item) => item.id === draft.base.id);
      if (!row) {
        setUnknown(null);
        setBlocked(true);
        setError('无法确认保存结果；这个学习项已不在本页，请取消编辑并刷新列表查看。');
        return;
      }
      setUnknown(null);
      setBlocked(false);
      if (
        (pending.user_pinned === undefined || pending.user_pinned === row.user_pinned) &&
        (pending.due_at === undefined || pending.due_at === row.due_at)
      ) {
        setDraft(null);
        setError(null);
        setNotice('已读取并确认当前设置。');
      } else {
        setDraft({
          base: row,
          pinned: pending.user_pinned ?? row.user_pinned,
          date:
            pending.due_at === undefined
              ? row.due_at
                ? calendarDate(new Date(row.due_at))
                : ''
              : draft.date,
        });
        setError('已读取当前设置，与刚才提交的不同。请核对后再保存。');
      }
    } catch {
      setError('保存结果待确认，暂时无法读取。请恢复连接后读取保存结果。');
    }
  };
  const save = async () => {
    if (!draft || !dirty || sending.current || blocked || unknown || !available) return false;
    let patch: LearningItemPlanPatch;
    try {
      patch = changedFields(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请选择有效的日期。');
      return false;
    }
    sending.current = true;
    setError(null);
    setNotice(null);
    await qc.cancelQueries({ queryKey: queryKeys.learningItemPlans });
    try {
      const receipt = await mutation.mutateAsync({ id: draft.base.id, patch });
      await qc.cancelQueries({ queryKey: queryKeys.learningItemPlans });
      qc.setQueriesData<LearningItemPlanPage>(
        { queryKey: queryKeys.learningItemPlans },
        (page) =>
          page && {
            ...page,
            items: page.items.map((item) =>
              item.id === receipt.id ? { ...item, ...receipt } : item,
            ),
          },
      );
      setDraft(null);
      setNotice('已保存优先级。可到今日练习按当前信号重排。');
      await invalidateAfterLearningItemPlan(qc);
      try {
        await query.refetch({ throwOnError: true });
      } catch {
        setNotice('已保存；列表刷新失败。请重试读取列表。');
      }
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        if (e.status === 404) {
          setBlocked(true);
          setError('这个学习项已不可用，请刷新列表。');
        } else if (e.status === 409) {
          setBlocked(true);
          setError('这个学习项暂时无法保存，当前设置保持不变。');
        } else setError('未能保存，请检查输入并重试。');
      } else {
        setUnknown(patch);
        setError('保存结果待确认。请先读取保存结果，再决定是否重试。');
      }
      return false;
    } finally {
      sending.current = false;
    }
  };
  const refresh = async () => {
    if (sending.current) return;
    if (unknown) {
      await reconcile(unknown);
      return;
    }
    try {
      await query.refetch({ throwOnError: true });
      if (blocked) {
        setDraft(null);
        setBlocked(false);
        setError(null);
      }
    } catch {
      /* The section keeps the last confirmed rows and exposes read retry. */
    }
  };
  const rows = query.data?.items ?? [];
  // Preserve the editor when an authoritative refresh removes its row, but prohibit writes.
  const shown = draft && !current ? [draft.base, ...rows.slice(0, 19)] : rows;
  return createElement(LearningItemPlanList, {
    rows: shown,
    loading: query.isPending,
    refreshing: query.isFetching,
    error: query.isError,
    expanded,
    page: cursors.length - 1,
    hasNext: query.data?.next_cursor != null,
    notice,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    onEdit: (row) => {
      if (draft?.base.id === row.id || !leaveEditor()) return;
      setDraft({
        base: row,
        pinned: row.user_pinned,
        date: row.due_at ? calendarDate(new Date(row.due_at)) : '',
      });
      setNotice(null);
    },
    onRefresh: () => void refresh(),
    onExpand: () => {
      if (leaveEditor()) setExpanded(!expanded);
    },
    onPage: (direction) => {
      if (!leaveEditor()) return;
      if (direction === -1) setCursors(cursors.slice(0, -1));
      else if (query.data?.next_cursor) setCursors([...cursors, query.data.next_cursor]);
    },
    onPractice: () => {
      if (leaveEditor()) navigate('/practice');
    },
    editor: draft
      ? {
          id: draft.base.id,
          pinned: draft.pinned,
          date: draft.date,
          dirty,
          busy: mutation.isPending,
          blocked: blocked || unknown !== null,
          unknown: unknown !== null,
          error,
          available,
          changedElsewhere:
            current !== undefined &&
            (current.user_pinned !== draft.base.user_pinned ||
              current.due_at !== draft.base.due_at),
          onPin: (pinned) => setDraft({ ...draft, pinned }),
          onDate: (date) => {
            setDraft({ ...draft, date });
            setError(null);
          },
          onTomorrow: () => {
            const date = new Date();
            date.setDate(date.getDate() + 1);
            setDraft({ ...draft, date: calendarDate(date) });
            setError(null);
          },
          onSave: save,
          onCancel: () => {
            setDraft(null);
            setError(null);
            setBlocked(false);
            setNotice(null);
          },
          onReconcile: () => {
            if (unknown) void reconcile(unknown);
          },
        }
      : null,
  });
}

export { AgentNotesResponseSchema } from './api/contracts';
export { AgentNotesBoard } from './ui/AgentNotesBoard';
export { type AgentNoteClient, AgentNoteClientProvider } from './ui/agent-note-client';
export { LearningIntentComposer } from './ui/LearningIntentComposer';
export type LearningIntentProposalClient =
  typeof import('./ui/learning-intent-api').createLearningIntentProposal;
export type { AgentNotesResponse } from './ui/types';

export const loadAgentNotesPage = () => import('./ui/page').then((module) => module.default);
export const loadMemoryPage = () => import('./ui/memory/page').then((module) => module.default);

export type { LearningPlanProgress as LearningPlanProgressData } from './server/learning-item-completion-policy';
export const loadLearningPlanProgressSection = () =>
  import('./ui/LearningPlanProgress').then((module) => module.default);
