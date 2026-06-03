// Stateful — status switch rendering loading / empty / error / ok(children).
// Ported from docs/design/loom-prototype/components.jsx (Stateful); prototype's
// `state` prop is exposed here as `status` per spec.

import type { ReactNode } from 'react';
import { ErrorState } from './ErrorState';
import { SkLines } from './SkLines';

export type StatefulStatus = 'loading' | 'empty' | 'error' | 'ok';

export interface StatefulProps {
  status?: StatefulStatus;
  skeleton?: ReactNode;
  empty?: ReactNode;
  errorText?: string;
  onRetry?: () => void;
  children?: ReactNode;
}

export function Stateful({
  status = 'ok',
  skeleton,
  empty,
  errorText,
  onRetry,
  children,
}: StatefulProps): ReactNode {
  if (status === 'loading') return skeleton ?? <SkLines />;
  if (status === 'error') return <ErrorState text={errorText} onRetry={onRetry} />;
  if (status === 'empty') return empty ?? null;
  return children;
}
