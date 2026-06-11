// M4-T6 (YUK-319)：AI 改动 · 近 24h（设计稿 screen-today.jsx AiChangesStrip）。
// 自带取数（notes 包 /api/artifacts/ai-changes/recent）+ undo mutation
// （NoteReaderPage 先例：useMutation + invalidate）。偏差：设计稿 undone 是
// 本地 state 演示，这里用服务器 undone 字段（invalidate 后回读）；真 wire 无
// artifact 标题，strip-title 收敛为「{actor} 改了笔记」。

import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getRecentAiChanges, undoAiChange } from '../workbench-api';

export function AiChangesStrip({ now }: { now: Date }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['workbench-ai-changes'], queryFn: getRecentAiChanges });
  const rows = q.data?.rows ?? [];

  const undoM = useMutation({
    mutationFn: ({ artifactId, eventId }: { artifactId: string; eventId: string }) =>
      undoAiChange(artifactId, eventId),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['workbench-ai-changes'] }),
  });

  const status: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : rows.length === 0
        ? 'empty'
        : 'ok';

  return (
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon accent">
          <LoomIcon name="undo" size={18} />
        </span>
        <div className="card-title">AI 改动 · 近 24h</div>
        <span className="badge tone-neutral" style={{ marginLeft: 'auto' }}>
          可回滚
        </span>
      </div>
      <Stateful
        status={status}
        onRetry={() => void q.refetch()}
        errorText="无法读取改动记录。"
        skeleton={<SkLines rows={2} />}
        empty={<div className="quiet-empty">过去 24 小时没有 AI 改动。</div>}
      >
        <div className="strip-list">
          {rows.map((c) => (
            <div key={c.event_id} className={`strip${c.undone ? ' is-undone' : ''}`}>
              <span className="strip-lead tone-coral">
                <LoomIcon name="sparkle" size={15} />
              </span>
              <div className="strip-body">
                <div className="strip-title">
                  <b className="mono">{c.actor_ref}</b> 改了笔记
                </div>
                <div className="strip-sub nowrap-meta mono">
                  {c.ops_count} ops · +{c.new_blocks} blocks · v{c.previous_artifact_version}→v
                  {c.next_artifact_version} · {formatRelTime(c.created_at, now)}
                </div>
              </div>
              <div className="strip-end">
                {c.undone ? (
                  <LoomBadge tone="good" dot>
                    <LoomIcon name="check" size={12} />
                    已撤销
                  </LoomBadge>
                ) : (
                  <Btn
                    size="sm"
                    variant="ghost"
                    icon="undo"
                    disabled={undoM.isPending}
                    onClick={() => undoM.mutate({ artifactId: c.artifact_id, eventId: c.event_id })}
                  >
                    撤销
                  </Btn>
                )}
              </div>
            </div>
          ))}
        </div>
      </Stateful>
    </LoomCard>
  );
}
