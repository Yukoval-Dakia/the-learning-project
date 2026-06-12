// M4-T6 (YUK-319)：进行中会话条（设计稿 screen-today.jsx SessionsStrip）。
// 偏差：真 wire（workbench summary active_sessions）无 subject / dist 字段，
// strip-title 用「已复习 N 题」形态；status 三态 badge（started 进行中 /
// completed 已完成 / 其它(paused/abandoned) 已中断）——wire 透传
// learning_session.status，状态机是 started|paused|completed|abandoned
// （codex 验证轮 P2：曾误判 'in_progress'，live 永不为真）。

import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import type { WorkbenchSummary } from '../workbench-api';

function durLabel(ms: number | null): string {
  if (ms == null) return '—';
  const min = Math.round(ms / 60_000);
  return min < 1 ? '不足 1 分钟' : `${min} 分钟`;
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
    <LoomCard pad>
      <div className="card-head">
        <span className="card-icon">
          <LoomIcon name="clock" size={18} />
        </span>
        <div className="card-title">进行中的会话</div>
        <span className="meta" style={{ marginLeft: 'auto' }}>
          review_session
        </span>
      </div>
      {sessions.length === 0 ? (
        <div className="quiet-empty">没有进行中的复习会话。</div>
      ) : (
        <div className="strip-list">
          {sessions.map((s) => {
            const live = s.status === 'started';
            const statusLabel = live ? '进行中' : s.status === 'completed' ? '已完成' : '已中断';
            return (
              <div key={s.id} className="strip">
                <span className={`strip-lead ${live ? 'tone-good' : 'tone-hard'}`}>
                  <LoomIcon name={live ? 'review' : 'undo'} size={16} />
                </span>
                <div className="strip-body">
                  <div className="strip-title">
                    {s.summary_md ?? `已复习 ${s.reviewed_count} 题`}
                  </div>
                  <div className="strip-sub nowrap-meta">
                    <span className="badge tone-neutral" style={{ padding: '2px 6px' }}>
                      {statusLabel}
                    </span>
                    已复习 {s.reviewed_count} 题 · {durLabel(s.duration_ms)} ·{' '}
                    {formatRelTime(s.started_at * 1000, now)}
                  </div>
                </div>
                <div className="strip-end">
                  <Btn
                    size="sm"
                    variant={live ? 'primary' : 'secondary'}
                    iconEnd="arrow"
                    onClick={() => navigate('/practice')}
                  >
                    {live ? '继续' : '恢复'}
                  </Btn>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </LoomCard>
  );
}
