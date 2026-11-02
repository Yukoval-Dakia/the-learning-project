// First-run state blocks in the M3E presentation (YUK-1473): a state with no content yet
// (no goal, preparing, ended, empty profile …) and an error line. Presentation only; the pages
// decide which state applies and what the actions do.

import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { RetryLine } from '@/ui-next/primitives/RetryLine';

export function OnboardingState({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="un-ob-state">
      <span className="un-ob-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2 className="un-ob-question">{title}</h2>
      <p className="un-ob-state-text">{text}</p>
      {action && <div className="un-ob-actions un-ob-actions-start">{action}</div>}
    </div>
  );
}

/** An error line; with a retry it is the ui-next RetryLine. */
export function OnboardingError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  if (onRetry) return <RetryLine message={text} onRetry={onRetry} />;
  return (
    <p className="un-ob-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      {text}
    </p>
  );
}
