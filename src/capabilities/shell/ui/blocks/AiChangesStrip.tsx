// M4-T6 (YUK-319)：AI 改动 · 近 24h（设计稿 screen-today.jsx AiChangesStrip）。
// 自带取数（notes 包 /api/artifacts/ai-changes/recent）+ undo mutation
// （NoteReaderPage 先例：useMutation + invalidate）。偏差：设计稿 undone 是
// 本地 state 演示，这里用服务器 undone 字段（invalidate 后回读）；真 wire 无
// artifact 标题，strip-title 收敛为「{actor} 改了笔记」。
// YUK-1713 — M3E presentation (today-m3e.css .td-card / .td-row, ui-next FoldList / Button).
// The query, the undo mutation (per-row failed ids, invalidateAfterAiChangeUndo in onSettled)
// and the disabled-while-pending rule are unchanged.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Sparkles, Undo2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { formatRelTime } from '@/ui/lib/utils';
import { invalidateAfterAiChangeUndo, queryKeys } from '@/ui/lib/write-invalidation';
import { FoldList } from '@/ui-next/primitives/FoldList';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button } from '@/ui-next/public';
import { AreaGate, type AreaStatus } from '../AreaGate';

import { useWorkbenchClient } from '../workbench-client';

// Loading → error → empty → content (early returns instead of a nested ternary; same order).
function stripStatus(isLoading: boolean, isError: boolean, isEmpty: boolean): AreaStatus {
  if (isLoading) return 'loading';
  if (isError) return 'error';
  if (isEmpty) return 'empty';
  return 'ok';
}

export function AiChangesStrip({ now }: { now: Date }) {
  const { getRecentAiChanges, undoAiChange } = useWorkbenchClient();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: queryKeys.workbenchAiChanges, queryFn: getRecentAiChanges });
  const rows = q.data?.rows ?? [];

  // Which rows' undo failed. A single shared mutation's isError can't say WHICH row; a
  // single failed-id would let a second row's failure swallow the first's error. Track the
  // full set of failed event ids and render the error inline at each. Retrying a row clears
  // only its own error; every other failed row keeps its error.
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set());
  const clearFailed = (eventId: string) =>
    setFailedIds((s) => {
      if (!s.has(eventId)) return s;
      const next = new Set(s);
      next.delete(eventId);
      return next;
    });
  const undoM = useMutation({
    mutationFn: ({ artifactId, eventId }: { artifactId: string; eventId: string }) =>
      undoAiChange(artifactId, eventId),
    onMutate: ({ eventId }) => clearFailed(eventId),
    onError: (_e, { eventId }) => setFailedIds((s) => new Set(s).add(eventId)),
    // Drop the flag on success too, so a row that ended up reverted never keeps an error.
    onSuccess: (_data, { eventId }) => clearFailed(eventId),
    // Settled, not success: a version-conflict failure also changes what the strip and the note
    // (reader + copilot hero block) should show.
    onSettled: (_d, _e, { artifactId }) => void invalidateAfterAiChangeUndo(qc, { artifactId }),
  });

  const status = stripStatus(q.isLoading, q.isError, rows.length === 0);

  return (
    <section className="td-card">
      <div className="td-card-head">
        <span className="td-card-ic" data-tone="accent" aria-hidden="true">
          <Undo2 size={18} />
        </span>
        <h3 className="td-card-title">AI 改动 · 近 24h</h3>
        <span className="td-card-aside td-chip">可回滚</span>
      </div>
      <AreaGate
        status={status}
        onRetry={() => void q.refetch()}
        errorText="无法读取改动记录。"
        loading={<SkeletonLines rows={2} label="正在读取 AI 改动" />}
        empty={<p className="td-quiet">过去 24 小时没有 AI 改动。</p>}
      >
        {/* 最近 3 条在前，其余收进「全部 N 条」（owner 2026-10-18 折叠决定，设计 L5）。 */}
        <FoldList
          as="div"
          className="td-rows"
          items={rows}
          renderItem={(c) => (
            <Fragment key={c.event_id}>
              <div className="td-row" data-undone={c.undone ? '1' : undefined}>
                <span className="td-row-lead" data-tone="secondary">
                  <Sparkles size={15} aria-hidden="true" />
                </span>
                <div className="td-row-body">
                  <p className="td-row-title">
                    <b className="td-mono">{c.actor_ref}</b> 改了笔记
                  </p>
                  <p className="td-row-sub td-mono">
                    {c.ops_count} ops · +{c.new_blocks} blocks · v{c.previous_artifact_version}→v
                    {c.next_artifact_version} · {formatRelTime(c.created_at, now)}
                  </p>
                </div>
                <div className="td-row-end">
                  {c.undone ? (
                    <span className="td-done">
                      <Check size={14} aria-hidden="true" />
                      已撤销
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={undoM.isPending}
                      onClick={() =>
                        undoM.mutate({ artifactId: c.artifact_id, eventId: c.event_id })
                      }
                    >
                      <Undo2 size={16} aria-hidden="true" />
                      撤销
                    </Button>
                  )}
                </div>
              </div>
              {!c.undone && failedIds.has(c.event_id) && (
                <p className="td-row-err" role="alert">
                  撤销失败，请重试。
                </p>
              )}
            </Fragment>
          )}
        />
      </AreaGate>
    </section>
  );
}
