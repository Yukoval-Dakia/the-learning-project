// M4-T6 (YUK-319)：进行中会话条（设计稿 screen-today.jsx SessionsStrip）。
// 偏差：真 wire（workbench summary active_sessions）无 subject / dist 字段，
// strip-title 用「已复习 N 题」形态；status 三态 badge（started 进行中 /
// completed 已完成 / 其它(paused/abandoned) 已中断）——wire 透传
// learning_session.status，状态机是 started|paused|completed|abandoned
// （codex 验证轮 P2：曾误判 'in_progress'，live 永不为真）。
// YUK-1713 — M3E presentation (today-m3e.css .td-card / .td-row); data, labels and the
// /practice target are unchanged.

import { ArrowRight, Clock, RotateCcw, Undo2 } from 'lucide-react';
import { formatRelTime } from '@/ui/lib/utils';
import { Button } from '@/ui-next/public';

import type { WorkbenchSummary } from '../workbench-api';

function durLabel(ms: number | null): string {
  if (ms == null) return '—';
  const min = Math.round(ms / 60_000);
  return min < 1 ? '不足 1 分钟' : `${min} 分钟`;
}

// started → 进行中, completed → 已完成, anything else → 已中断 (early returns instead of a
// nested ternary; same order and conditions).
function statusLabelOf(live: boolean, status: string): string {
  if (live) return '进行中';
  if (status === 'completed') return '已完成';
  return '已中断';
}

export function SessionsStrip({
  sessions,
  now,
  navigate,
}: {
  sessions: WorkbenchSummary['active_sessions'];
  now: Date;
  navigate: (to: string) => void;
}) {
  return (
    <section className="td-card">
      <div className="td-card-head">
        <span className="td-card-ic" aria-hidden="true">
          <Clock size={18} />
        </span>
        <h3 className="td-card-title">进行中的会话</h3>
        <span className="td-card-aside td-quiet">
          {sessions.length > 0 ? `共 ${sessions.length} 个` : '复习安排'}
        </span>
      </div>
      {sessions.length === 0 ? (
        <p className="td-quiet">没有进行中的复习会话。</p>
      ) : (
        <div className="td-rows">
          {sessions.map((s) => {
            const live = s.status === 'started';
            const statusLabel = statusLabelOf(live, s.status);
            const LeadIcon = live ? RotateCcw : Undo2;
            return (
              <div key={s.id} className="td-row">
                <span className="td-row-lead" data-tone={live ? 'positive' : 'caution'}>
                  <LeadIcon size={16} aria-hidden="true" />
                </span>
                <div className="td-row-body">
                  <p className="td-row-title">{s.summary_md ?? `已复习 ${s.reviewed_count} 题`}</p>
                  <p className="td-row-sub un-num">
                    <span className="td-chip">{statusLabel}</span>
                    已复习 {s.reviewed_count} 题 · {durLabel(s.duration_ms)} ·{' '}
                    {formatRelTime(s.started_at * 1000, now)}
                  </p>
                </div>
                <div className="td-row-end">
                  <Button
                    size="sm"
                    variant={live ? 'primary' : 'secondary'}
                    onClick={() => navigate('/practice')}
                  >
                    {live ? '继续' : '恢复'}
                    <ArrowRight size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
