// YUK-1473 — the loading / error / empty / ready switch for the coach hub and the Today brief
// blocks, in ui-next form. Same order as the old Stateful primitive: loading → error → empty →
// content. Design record: docs/design/2026-11-03-coach-m3e.md.

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import './coach-shared-m3e.css';

export type AreaStatus = 'loading' | 'empty' | 'error' | 'ok';

export function AreaGate({
  status,
  loading,
  errorText,
  onRetry,
  empty,
  children,
}: {
  status: AreaStatus;
  loading: ReactNode;
  errorText: string;
  onRetry: () => void;
  empty?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  if (status === 'loading') return loading;
  if (status === 'error') return <RetryLine message={errorText} onRetry={onRetry} />;
  if (status === 'empty') return empty ?? null;
  return children;
}

/** An empty area: what is missing, why, and (optionally) the one way forward. */
export function AreaEmpty({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  text: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="cs-empty">
      <span className="cs-empty-ic" aria-hidden="true">
        <Icon size={22} />
      </span>
      <p className="cs-empty-t">{title}</p>
      <p className="cs-empty-s">{text}</p>
      {action}
    </div>
  );
}
