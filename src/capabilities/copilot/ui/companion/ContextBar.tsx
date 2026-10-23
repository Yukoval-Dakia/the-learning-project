// 「正在看：<title>」 — what the page told the companion the learner is looking at. It rides along
// with each message as the focused entity; × drops it, so the next message goes without it.

import { Eye, X } from 'lucide-react';
import { setCompanionFocus, useCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { IconButton } from '@/ui-next/public';
import { focusKindLabel } from './focus-chips';

export function ContextBar() {
  const focus = useCompanionFocus();
  if (!focus) return null;
  const kind = focusKindLabel(focus.kind);
  return (
    <div className="un-cp-context">
      <Eye size={14} aria-hidden="true" className="un-cp-context-icon" />
      <p className="un-cp-context-text">
        <span className="un-cp-context-lead">正在看：</span>
        {kind ? <span className="un-cp-context-kind">{kind}</span> : null}
        <span className="un-cp-context-title">{focus.title}</span>
      </p>
      <IconButton
        label="不带上这项内容"
        className="un-cp-context-drop"
        icon={<X size={14} />}
        onClick={() => setCompanionFocus(null)}
      />
    </div>
  );
}
