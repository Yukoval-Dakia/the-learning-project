// When a reply created suggestions, say what happens to them: some wait in the inbox for the
// learner's decision, others apply on their own and can be undone there while nothing uses them yet.

import { Inbox } from 'lucide-react';
import { Button } from '@/ui-next/public';

const UNDO_WORDS = '还没被用到的可以撤销';

export function ProposalNotice({
  pending,
  autoApplying,
  navigate,
}: {
  pending: number;
  autoApplying: number;
  navigate: (to: string) => void;
}) {
  if (pending <= 0 && autoApplying <= 0) return null;
  return (
    <div className="un-cp-proposal" role="note">
      <Inbox size={16} aria-hidden="true" className="un-cp-proposal-icon" />
      {pending > 0 ? (
        <p className="un-cp-proposal-text">
          <span>
            已放进收件箱 · <span className="un-num">{pending}</span> 条建议
          </span>
          <span className="un-cp-proposal-sub">
            {autoApplying > 0
              ? `你确认之后才会生效；另有 ${autoApplying} 条会自动生效，${UNDO_WORDS}`
              : '你确认之后才会生效'}
          </span>
        </p>
      ) : (
        <p className="un-cp-proposal-text">
          <span>
            已记下 · <span className="un-num">{autoApplying}</span> 条会自动生效
          </span>
          <span className="un-cp-proposal-sub">{UNDO_WORDS}</span>
        </p>
      )}
      <Button variant="secondary" size="sm" onClick={() => navigate('/inbox')}>
        去看看
      </Button>
    </div>
  );
}
