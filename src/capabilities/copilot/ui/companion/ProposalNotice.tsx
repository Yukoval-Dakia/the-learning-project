// When a reply created suggestions, say where they went: they wait in the inbox for the learner's
// decision; nothing has been applied yet.

import { Inbox } from 'lucide-react';
import { Button } from '@/ui-next/public';

export function ProposalNotice({
  pending,
  navigate,
}: {
  pending: number;
  navigate: (to: string) => void;
}) {
  if (pending <= 0) return null;
  return (
    <div className="un-cp-proposal" role="note">
      <Inbox size={16} aria-hidden="true" className="un-cp-proposal-icon" />
      <p className="un-cp-proposal-text">
        已放进收件箱 · <span className="un-num">{pending}</span> 条建议
        <span className="un-cp-proposal-sub">你确认之后才会生效</span>
      </p>
      <Button variant="secondary" size="sm" onClick={() => navigate('/inbox')}>
        去看看
      </Button>
    </div>
  );
}
