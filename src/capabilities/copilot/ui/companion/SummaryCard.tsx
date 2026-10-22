// Today, at the top of the conversation: the day's focus, due reviews, the learner brief and the
// suggestions waiting in the inbox. Open while the conversation is empty (with a short greeting);
// once there are turns it folds to one line so the conversation keeps the height. A click on the
// line records the learner's own choice.

import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { Expand } from '@/ui-next/public';
import { learnerGlobalBrief } from '../learner-global-brief';
import { useCompanionSummary } from './use-companion';

export function SummaryCard({
  empty,
  navigate,
}: {
  empty: boolean;
  navigate: (to: string) => void;
}) {
  const summary = useCompanionSummary(true);
  const [pref, setPref] = useState<boolean | null>(null);
  const regionId = useId();
  const open = pref ?? empty;
  const data = summary.data;
  const brief = learnerGlobalBrief(data?.brief_global_md);
  const preview = data
    ? data.daily_focus
    : summary.isLoading
      ? '正在读取今天的安排…'
      : '今天的安排暂时读不到。';

  return (
    <section className="un-cp-today" data-empty={empty ? '' : undefined}>
      {empty ? (
        <div className="un-cp-hello">
          <h2 className="un-cp-hello-title">有什么想一起弄明白的？</h2>
          <p className="un-cp-hello-text">
            问我今天该学什么、为什么这样安排，或者让我帮你调整。我做的每一处改动，你都可以留下或撤回。
          </p>
        </div>
      ) : null}
      <button
        type="button"
        className="un-cp-today-toggle un-hit"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setPref(!open)}
      >
        <span className="un-cp-today-label">今天</span>
        <span className="un-cp-today-preview" data-hidden={open ? '' : undefined}>
          {preview}
        </span>
        <ChevronDown size={14} aria-hidden="true" className="un-cp-chev" />
      </button>
      <Expand open={open} id={regionId}>
        <div className="un-cp-today-body">
          {data ? (
            <>
              <p className="un-cp-today-focus">{data.daily_focus}</p>
              {data.review_due_count > 0 ? (
                <p className="un-cp-today-line">
                  今日待复习 <strong className="un-num">{data.review_due_count}</strong> 题
                </p>
              ) : null}
              {brief ? <p className="un-cp-today-brief">{brief}</p> : null}
              {data.dreaming_preview.length > 0 ? (
                <ul className="un-cp-today-list">
                  {data.dreaming_preview.map((row) => (
                    <li key={row.proposal_id}>{row.brief}</li>
                  ))}
                </ul>
              ) : null}
              {data.pending_proposals_total > 0 ? (
                <button
                  type="button"
                  className="un-cp-text-btn un-hit"
                  onClick={() => navigate('/inbox')}
                >
                  还有 {data.pending_proposals_total} 条建议在收件箱 · 去看看
                </button>
              ) : null}
            </>
          ) : (
            <p className="un-cp-quiet">{preview}</p>
          )}
        </div>
      </Expand>
    </section>
  );
}
